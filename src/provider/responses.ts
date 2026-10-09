// OpenAI Responses (`POST {base}/responses`) — api.openai.com, and vLLM. Stateless (store: false):
// the whole history is sent as input items, and reasoning items come back opaque (with their
// encrypted content when the server provides it) so a reasoning model keeps its thread.
import { resolveKey } from "../config/load.ts"
import { historyArgs, Parts, record, recordFailure, retrying, statusOf, SwapBanner } from "./common.ts"
import { authHeaders, joinUrl, request, tlsFor } from "./http.ts"
import { contextFrom } from "./openai-chat.ts"
import { sseJson } from "./sse.ts"
import { estimateTokens } from "./tokens.ts"
import { ProviderError, type ChatRequest, type Client, type DiscoveredModel, type Message, type ResolvedModel, type StreamEvent } from "./types.ts"

type Item = Record<string, unknown>

export function toResponsesInput(messages: Message[], vision: boolean): Item[] {
  const out: Item[] = []
  for (const m of messages) {
    if (m.role === "user") {
      out.push({
        role: "user",
        content: m.parts.map((p) =>
          p.type === "text"
            ? { type: "input_text", text: p.text }
            : vision
              ? { type: "input_image", image_url: `data:${p.mime};base64,${p.data}` }
              : { type: "input_text", text: "[image omitted: this model has no vision]" },
        ),
      })
    } else if (m.role === "assistant") {
      let text: string[] = []
      const flush = () => {
        if (text.join("").trim()) out.push({ role: "assistant", content: [{ type: "output_text", text: text.join("") }] })
        text = []
      }
      for (const p of m.parts) {
        if (p.type === "text") text.push(p.text)
        else if (p.type === "reasoning") {
          // Only a reasoning item this dialect produced can go back; text from elsewhere cannot.
          const item = (p.opaque as { responses?: Item } | undefined)?.responses
          if (item) {
            flush()
            out.push(item)
          }
        } else {
          flush()
          out.push({ type: "function_call", call_id: p.id, name: p.name, arguments: historyArgs(p.args) })
        }
      }
      flush()
    } else out.push({ type: "function_call_output", call_id: m.callId, output: m.content })
  }
  return out
}

export class ResponsesClient implements Client {
  constructor(private m: ResolvedModel) {}

  private headers() {
    return authHeaders(this.m.connection, resolveKey(this.m.connectionName, this.m.connection), this.m.spec.headers)
  }

  buildBody(req: ChatRequest): Record<string, unknown> {
    const { m } = this
    const body: Record<string, unknown> = {
      model: m.id,
      input: toResponsesInput(req.messages, m.spec.vision === true),
      stream: true,
      store: false,
      ...m.connection.body,
      ...m.spec.body,
    }
    if (req.system) body.instructions = req.system
    if (req.tools.length && m.spec.tools !== false)
      body.tools = req.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: false }))
    if (m.spec.max_output) body.max_output_tokens = m.spec.max_output
    if (req.effort) {
      body.reasoning = { effort: req.effort, summary: "auto" }
      body.include = ["reasoning.encrypted_content"]
    } else {
      if (m.spec.temperature !== undefined) body.temperature = m.spec.temperature
      if (m.spec.top_p !== undefined) body.top_p = m.spec.top_p
    }
    return body
  }

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    let body = this.buildBody(req)
    yield* retrying(
      () => this.attempt(req, body),
      (e) => {
        // Some servers do not know `include`; drop it once rather than fail.
        if (body.include && (e.status === 400 || e.status === 422) && /include/i.test(e.message)) {
          const { include: _, ...rest } = body
          body = rest
          return { retry: true }
        }
        return { retry: false }
      },
    )
  }

  private async *attempt(req: ChatRequest, body: Record<string, unknown>): AsyncGenerator<StreamEvent> {
    const { m } = this
    const res = await request(
      joinUrl(m.connection.base_url, "responses"),
      { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal: req.signal, timeoutMs: (m.connection.timeout ?? 600) * 1000, tls: tlsFor(m.connection) },
      m.ref,
    ).catch((e) => {
      recordFailure(m.ref, body, e)
      throw e
    })
    if (!res.body) throw new ProviderError(`${m.ref}: empty response`)

    const out = new Parts()
    const banner = new SwapBanner()
    const reasoning = new Map<string, string>()
    const callIndex = new Map<string, number>()
    let finish = "stop"
    let usage: StreamEvent | undefined

    for await (const { data } of sseJson(record(res.body, m.ref, body))) {
      const ev = data as any
      const t: string = ev?.type ?? ""
      if (t === "response.output_text.delta") {
        out.add("text", ev.delta ?? "")
        yield { type: "text", text: ev.delta ?? "" }
      } else if (t === "response.reasoning_summary_text.delta" || t === "response.reasoning_text.delta") {
        const b = banner.feed(ev.delta ?? "")
        if (b.notice) yield { type: "notice", message: b.notice }
        if (!b.text) continue
        reasoning.set(ev.item_id ?? "", (reasoning.get(ev.item_id ?? "") ?? "") + b.text)
        if (b.text.trim()) out.output = true
        yield { type: "reasoning", text: b.text }
      } else if (t === "response.output_item.added" && ev.item?.type === "function_call") {
        const index = callIndex.size
        callIndex.set(ev.item.id ?? ev.item.call_id, index)
        yield { type: "tool_call_delta", index, name: ev.item.name, argsDelta: "" }
      } else if (t === "response.function_call_arguments.delta") {
        out.output = true
        yield { type: "tool_call_delta", index: callIndex.get(ev.item_id) ?? 0, argsDelta: ev.delta ?? "" }
      } else if (t === "response.output_item.done") {
        const item = ev.item ?? {}
        if (item.type === "function_call") out.push({ type: "tool_call", id: item.call_id ?? item.id, name: item.name, args: item.arguments || "{}" })
        else if (item.type === "reasoning") {
          const summary = Array.isArray(item.summary) ? item.summary.map((s: any) => s.text ?? "").join("\n") : ""
          const text = reasoning.get(item.id ?? "") || summary
          // vLLM puts the raw reasoning in `content`, which it will not accept back; keep what can return.
          const { content: _c, ...back } = item
          if (text || item.encrypted_content) out.push({ type: "reasoning", text, opaque: item.encrypted_content ? { responses: back } : undefined })
        }
      } else if (t === "response.completed" || t === "response.incomplete") {
        const r = ev.response ?? {}
        if (t === "response.incomplete" || r.status === "incomplete") finish = "length"
        const u = r.usage
        if (u) usage = { type: "usage", usage: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, reasoning: u.output_tokens_details?.reasoning_tokens, cached: u.input_tokens_details?.cached_tokens || undefined } }
      } else if (t === "response.failed" || t === "error" || ev?.error) {
        const err = ev.response?.error ?? ev.error ?? ev
        throw new ProviderError(`${m.ref}: ${err.message ?? JSON.stringify(err)}`, statusOf(err), undefined, !out.output)
      }
    }
    const message = out.message()
    if (finish !== "length" && message.parts.some((p) => p.type === "tool_call")) finish = "tool_calls"
    yield usage ?? {
      type: "usage",
      usage: { input: estimateTokens(JSON.stringify(body.input)), output: message.parts.reduce((n, p) => n + estimateTokens(p.type === "tool_call" ? p.args : p.text), 0), estimated: true },
    }
    yield { type: "finish", reason: finish, message }
  }

  async listModels(): Promise<DiscoveredModel[]> {
    const res = await request(joinUrl(this.m.connection.base_url, "models"), { headers: this.headers(), timeoutMs: 15_000, tls: tlsFor(this.m.connection) }, this.m.connectionName)
    const j = (await res.json()) as any
    return (Array.isArray(j?.data) ? j.data : []).map((x: any) => ({ id: String(x.id), context: contextFrom(x) })).filter((x: DiscoveredModel) => x.id)
  }
}
