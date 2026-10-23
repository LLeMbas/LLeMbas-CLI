// Anthropic Messages (`POST {base}/messages`) — api.anthropic.com, and servers that imitate it
// (vLLM, llama-server). Content blocks both ways; thinking with signatures that must be sent back
// on the next turn; optional prompt-caching breakpoints.
import type { Effort } from "../config/schema.ts"
import { resolveKey } from "../config/load.ts"
import { Parts, record, recordFailure, retrying, statusOf, SwapBanner } from "./common.ts"
import { authHeaders, joinUrl, request, tlsFor } from "./http.ts"
import { sseJson } from "./sse.ts"
import { estimateTokens, estimateValue } from "./tokens.ts"
import { ProviderError, type ChatRequest, type Client, type DiscoveredModel, type Message, type ResolvedModel, type StreamEvent, type ToolCallPart } from "./types.ts"

/** Thinking budgets by effort, when the model's config gives no effort_map. */
export const DEFAULT_BUDGETS: Record<Effort, number> = { minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 32000, max: 48000 }

type Block = Record<string, unknown>
type AMessage = { role: "user" | "assistant"; content: Block[] }

/** Anthropic ids must match ^[a-zA-Z0-9_-]+$; ids from other providers are mapped consistently. */
export const safeId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_") || "call"

export function toAnthropicMessages(messages: Message[], vision: boolean, thinking: boolean): AMessage[] {
  const out: AMessage[] = []
  const push = (role: AMessage["role"], blocks: Block[]) => {
    if (!blocks.length) return
    const last = out[out.length - 1]
    // Consecutive turns of one role are merged: tool results and a following note are one user turn.
    if (last && last.role === role) last.content.push(...blocks)
    else out.push({ role, content: blocks })
  }
  for (const m of messages) {
    if (m.role === "user") {
      push(
        "user",
        m.parts.map((p) =>
          p.type === "text"
            ? { type: "text", text: p.text }
            : vision
              ? { type: "image", source: { type: "base64", media_type: p.mime, data: p.data } }
              : { type: "text", text: "[image omitted: this model has no vision]" },
        ),
      )
    } else if (m.role === "assistant") {
      const blocks: Block[] = []
      for (const p of m.parts) {
        if (p.type === "reasoning") {
          // A thinking block can only go back with its signature, and only while thinking is on.
          if (!thinking) continue
          const redacted = (p.opaque as { redacted?: string } | undefined)?.redacted
          if (redacted) blocks.push({ type: "redacted_thinking", data: redacted })
          else if (p.signature) blocks.push({ type: "thinking", thinking: p.text, signature: p.signature })
        } else if (p.type === "text") {
          if (p.text.trim()) blocks.push({ type: "text", text: p.text })
        } else {
          let input: unknown = {}
          try {
            input = p.args.trim() ? JSON.parse(p.args) : {}
          } catch {
            input = { _unparsed: p.args }
          }
          blocks.push({ type: "tool_use", id: safeId(p.id), name: p.name, input })
        }
      }
      push("assistant", blocks)
    } else {
      push("user", [{ type: "tool_result", tool_use_id: safeId(m.callId), content: m.content || "(empty)", ...(m.isError ? { is_error: true } : {}) }])
    }
  }
  return out
}

export class AnthropicClient implements Client {
  constructor(private m: ResolvedModel) {}

  private headers() {
    return authHeaders(this.m.connection, resolveKey(this.m.connectionName, this.m.connection), { "anthropic-version": "2023-06-01", ...this.m.spec.headers })
  }

  buildBody(req: ChatRequest): Record<string, unknown> {
    const { m } = this
    const budget = req.effort ? (m.spec.effort_map?.[req.effort] ?? DEFAULT_BUDGETS[req.effort]) : undefined
    let maxTokens = m.spec.max_output ?? 8192
    if (budget && maxTokens <= budget) maxTokens = budget + Math.min(8192, maxTokens)
    const cache = m.spec.cache === true
    const body: Record<string, unknown> = {
      model: m.id,
      max_tokens: maxTokens,
      stream: true,
      messages: toAnthropicMessages(req.messages, m.spec.vision === true, !!budget),
      ...m.connection.body,
      ...m.spec.body,
    }
    if (req.system) body.system = cache ? [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }] : req.system
    if (req.tools.length && m.spec.tools !== false) {
      const tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
      if (cache) (tools[tools.length - 1] as Block).cache_control = { type: "ephemeral" }
      body.tools = tools
    }
    if (cache) {
      const msgs = body.messages as AMessage[]
      const last = msgs[msgs.length - 1]?.content
      if (last?.length) last[last.length - 1] = { ...last[last.length - 1], cache_control: { type: "ephemeral" } }
    }
    if (budget) body.thinking = { type: "enabled", budget_tokens: budget }
    else {
      // Sampling parameters and extended thinking do not mix on this API.
      if (m.spec.temperature !== undefined) body.temperature = m.spec.temperature
      if (m.spec.top_p !== undefined) body.top_p = m.spec.top_p
    }
    return body
  }

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    const body = this.buildBody(req)
    yield* retrying(() => this.attempt(req, body))
  }

  private async *attempt(req: ChatRequest, body: Record<string, unknown>): AsyncGenerator<StreamEvent> {
    const { m } = this
    const res = await request(
      joinUrl(m.connection.base_url, "messages"),
      { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal: req.signal, timeoutMs: (m.connection.timeout ?? 600) * 1000, tls: tlsFor(m.connection) },
      m.ref,
    ).catch((e) => {
      recordFailure(m.ref, body, e)
      throw e
    })
    if (!res.body) throw new ProviderError(`${m.ref}: empty response`)

    const out = new Parts()
    const banner = new SwapBanner()
    type Open = { type: string; text: string; signature?: string; id?: string; name?: string; json: string; data?: string; index: number }
    const blocks = new Map<number, Open>()
    let toolIndex = 0
    let finish = "stop"
    let input = 0
    let output = 0
    let cached: number | undefined
    let sawUsage = false

    for await (const { data } of sseJson(record(res.body, m.ref, body))) {
      const ev = data as any
      switch (ev?.type) {
        case "message_start": {
          const u = ev.message?.usage
          if (u) {
            sawUsage = true
            cached = u.cache_read_input_tokens || undefined
            input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
            output = u.output_tokens ?? 0
          }
          break
        }
        case "content_block_start": {
          const b = ev.content_block ?? {}
          blocks.set(ev.index, { type: b.type, text: b.text ?? b.thinking ?? "", id: b.id, name: b.name, json: "", data: b.data, index: ev.index })
          if (b.type === "tool_use") yield { type: "tool_call_delta", index: toolIndex, name: b.name, argsDelta: "" }
          if (b.type === "text" && b.text) {
            out.add("text", b.text)
            yield { type: "text", text: b.text }
          }
          break
        }
        case "content_block_delta": {
          const blk = blocks.get(ev.index)
          const d = ev.delta ?? {}
          if (!blk) break
          if (d.type === "text_delta") {
            out.add("text", d.text)
            yield { type: "text", text: d.text }
          } else if (d.type === "thinking_delta") {
            const b = banner.feed(d.thinking ?? "")
            if (b.notice) yield { type: "notice", message: b.notice }
            if (b.text) {
              blk.text += b.text
              if (b.text.trim()) out.output = true
              yield { type: "reasoning", text: b.text }
            }
          } else if (d.type === "signature_delta") blk.signature = (blk.signature ?? "") + d.signature
          else if (d.type === "input_json_delta") {
            blk.json += d.partial_json ?? ""
            out.output = true
            yield { type: "tool_call_delta", index: toolIndex, argsDelta: d.partial_json ?? "" }
          }
          break
        }
        case "content_block_stop": {
          const blk = blocks.get(ev.index)
          if (!blk) break
          if (blk.type === "thinking" && blk.text) out.push({ type: "reasoning", text: blk.text, signature: blk.signature })
          else if (blk.type === "redacted_thinking") out.push({ type: "reasoning", text: "", opaque: { redacted: blk.data } })
          else if (blk.type === "tool_use") {
            const call: ToolCallPart = { type: "tool_call", id: blk.id || `toolu_${toolIndex}`, name: blk.name ?? "", args: blk.json || "{}" }
            out.push(call)
            toolIndex++
          }
          blocks.delete(ev.index)
          break
        }
        case "message_delta": {
          if (ev.delta?.stop_reason) finish = ev.delta.stop_reason
          if (ev.usage?.output_tokens !== undefined) {
            sawUsage = true
            output = ev.usage.output_tokens
          }
          break
        }
        case "error": {
          const err = ev.error ?? {}
          throw new ProviderError(`${m.ref}: ${err.message ?? JSON.stringify(err)}`, statusOf(err) ?? (err.type === "overloaded_error" ? 529 : undefined), undefined, !out.output)
        }
        default:
          if (ev?.error) throw new ProviderError(`${m.ref}: ${ev.error.message ?? JSON.stringify(ev.error)}`, statusOf(ev.error), undefined, !out.output)
      }
    }
    const message = out.message()
    const reason = finish === "max_tokens" ? "length" : finish === "tool_use" || message.parts.some((p) => p.type === "tool_call") ? "tool_calls" : "stop"
    yield sawUsage
      ? { type: "usage", usage: { input, output, cached } }
      : { type: "usage", usage: { input: estimateValue(body.messages), output: message.parts.reduce((n, p) => n + estimateTokens(p.type === "tool_call" ? p.args : p.text), 0), estimated: true } }
    yield { type: "finish", reason, message }
  }

  async listModels(): Promise<DiscoveredModel[]> {
    const res = await request(joinUrl(this.m.connection.base_url, "models"), { headers: this.headers(), timeoutMs: 15_000, tls: tlsFor(this.m.connection) }, this.m.connectionName)
    const j = (await res.json()) as any
    return (Array.isArray(j?.data) ? j.data : []).map((x: any) => ({ id: String(x.id), context: x.context_window ?? x.max_input_tokens })).filter((x: DiscoveredModel) => x.id)
  }
}
