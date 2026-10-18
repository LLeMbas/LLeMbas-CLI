// OpenAI chat completions — and every server that imitates it: llama.cpp / llama-swap, vLLM,
// LM Studio, Ollama's /v1, OpenRouter, DeepSeek. The quirks handled here are the ones LLeMbas
// catalogued in production (see its Working-notes): usage that is never sent, `stream_options`
// that is a 400, reasoning in `reasoning_content` or `reasoning` or inline <think> tags, tool-call
// fragments without an index, arguments sent as an object, and chat templates that refuse efforts.
import type { Effort } from "../config/schema.ts"
import { resolveKey } from "../config/load.ts"
import { advertisedEfforts, applyEffort, effortRefused, effortsFor, stripEffort } from "./effort.ts"
import { authHeaders, request, joinUrl, tlsFor } from "./http.ts"
import { learned, learnEfforts, learnNoProgress, learnNoStreamOptions } from "./learned.ts"
import { historyArgs, Parts, record, recordFailure, retrying, statusOf, SwapBanner } from "./common.ts"
import { sseJson } from "./sse.ts"
import { ThinkSplitter } from "./think.ts"
import { estimateTokens } from "./tokens.ts"
import {
  ProviderError,
  type ChatRequest,
  type Client,
  type DiscoveredModel,
  type Message,
  type ResolvedModel,
  type StreamEvent,
  type ToolCallPart,
  type ReasoningPart,
  type TextPart,
} from "./types.ts"

type Assistant = Extract<Message, { role: "assistant" }>

export function toOpenAIMessages(system: string, messages: Message[], vision: boolean): unknown[] {
  const out: unknown[] = []
  if (system) out.push({ role: "system", content: system })
  for (const m of messages) {
    if (m.role === "user") {
      const images = m.parts.filter((p) => p.type === "image")
      if (images.length === 0 || !vision) {
        const text = m.parts.map((p) => (p.type === "text" ? p.text : "[image omitted: model has no vision]")).join("\n")
        out.push({ role: "user", content: text })
      } else {
        out.push({
          role: "user",
          content: m.parts.map((p) =>
            p.type === "text"
              ? { type: "text", text: p.text }
              : { type: "image_url", image_url: { url: `data:${p.mime};base64,${p.data}` } },
          ),
        })
      }
    } else if (m.role === "assistant") {
      const text = m.parts.filter((p): p is TextPart => p.type === "text").map((p) => p.text).join("")
      const calls = m.parts.filter((p): p is ToolCallPart => p.type === "tool_call")
      const msg: Record<string, unknown> = { role: "assistant", content: text || null }
      if (calls.length)
        msg.tool_calls = calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: historyArgs(c.args) } }))
      out.push(msg)
    } else {
      out.push({ role: "tool", tool_call_id: m.callId, content: m.content })
    }
  }
  return out
}

/** Reassembles streamed tool-call fragments, keyed by index (the only field on every fragment). */
export class ToolCallAccumulator {
  private calls = new Map<number, { id: string; name: string; args: string }>()
  /** The index of the call started last: a delta without one continues it (quirks.json
   *  tool-call-without-index; conformance toolcall_index.json). */
  private last = 0

  feed(fragments: unknown): { index: number; name?: string; argsDelta: string }[] {
    const deltas: { index: number; name?: string; argsDelta: string }[] = []
    if (!Array.isArray(fragments)) return deltas
    for (const f of fragments as any[]) {
      if (!f || typeof f !== "object") continue
      // Some servers omit the index: the fragment belongs to the call started last, and the
      // first fragment of a stream without one starts call 0.
      const index = Number.isInteger(f.index) ? (f.index as number) : this.last
      this.last = index
      let call = this.calls.get(index)
      if (!call) this.calls.set(index, (call = { id: "", name: "", args: "" }))
      if (f.id) call.id = String(f.id)
      const fn = f.function ?? {}
      let name: string | undefined
      if (fn.name) name = call.name = String(fn.name)
      let delta = ""
      if (typeof fn.arguments === "string") delta = fn.arguments
      else if (fn.arguments && typeof fn.arguments === "object") delta = JSON.stringify(fn.arguments)
      call.args += delta
      deltas.push({ index, name, argsDelta: delta })
    }
    return deltas
  }

  result(): ToolCallPart[] {
    return [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .filter(([, c]) => c.name)
      .map(([i, c]) => ({ type: "tool_call", id: c.id || `call_${i}_${Date.now().toString(36)}`, name: c.name, args: c.args }))
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content))
    return content.map((p: any) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : "")).join("")
  return ""
}

export class OpenAIChatClient implements Client {
  constructor(private m: ResolvedModel) {}

  private headers(): Record<string, string> {
    return authHeaders(this.m.connection, resolveKey(this.m.connectionName, this.m.connection), this.m.spec.headers)
  }

  buildBody(req: ChatRequest): Record<string, unknown> {
    const { m } = this
    const body: Record<string, unknown> = {
      model: m.id,
      messages: toOpenAIMessages(req.system, req.messages, m.spec.vision === true),
      stream: true,
      ...m.connection.body,
      ...m.spec.body,
    }
    if (req.tools.length && m.spec.tools !== false)
      body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }))
    if (m.spec.max_output) body[m.connection.quirks?.max_tokens_field ?? "max_tokens"] = m.spec.max_output
    if (m.spec.temperature !== undefined) body.temperature = m.spec.temperature
    if (m.spec.top_p !== undefined) body.top_p = m.spec.top_p
    applyEffort(body, m, req.effort)
    return body
  }

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    const { m } = this
    const base = m.connection.base_url
    let body = this.buildBody(req)
    const usageQuirk = m.connection.quirks?.stream_usage ?? "auto"
    let wantUsage = usageQuirk === "on" || (usageQuirk === "auto" && !learned().noStreamOptions.includes(base))
    // llama.cpp says how far it is through reading the prompt — minutes, for a long conversation
    // on a local model. Asked for everywhere; a server that ignores it sends nothing more, and one
    // that refuses it is retried without and remembered.
    const progressQuirk = m.connection.quirks?.prompt_progress ?? "auto"
    let wantProgress = progressQuirk === "on" || (progressQuirk === "auto" && !learned().noProgress.includes(base))
    let droppedProgress = false

    // Beyond the shared rule, three quirks of OpenAI-compatible servers are retried: a chat template
    // refusing the effort (llama.cpp — learned, then dropped), and a 400 for return_progress, then
    // for stream_options.
    yield* retrying(
      () => this.attempt(req, body, wantUsage, wantProgress),
      (e) => {
        const refused = (body.reasoning_effort ?? (body.chat_template_kwargs as any)?.reasoning_effort) as Effort | undefined
        if (refused && effortRefused(e.message)) {
          const advertised = advertisedEfforts(e.message).filter((x) => x !== refused)
          const narrowed = advertised.length ? advertised : effortsFor(m).filter((x) => x !== refused)
          if (narrowed.length) learnEfforts(m.ref, narrowed)
          body = stripEffort(body)
          return { retry: true, notice: `${m.ref} refused effort "${refused}"; retried without it (now offering ${narrowed.join(", ") || "none"})` }
        }
        // A 400 that names stream_options is about that; one that names neither field drops
        // progress first (the newer and rarer of the two).
        if (wantProgress && progressQuirk === "auto" && (e.status === 400 || e.status === 422) && !/stream_options/i.test(e.message)) {
          wantProgress = false
          droppedProgress = true
          // Remembered at once when the server names it; otherwise only if the retry then works,
          // so a 400 for something else (a prompt too long) does not switch progress off for good.
          if (/return_progress/i.test(e.message)) learnNoProgress(base)
          return { retry: true }
        }
        if (wantUsage && usageQuirk === "auto" && (e.status === 400 || e.status === 422)) {
          wantUsage = false
          learnNoStreamOptions(base)
          return { retry: true }
        }
        return { retry: false }
      },
    )
    if (droppedProgress) learnNoProgress(base)
  }

  private async *attempt(req: ChatRequest, body: Record<string, unknown>, wantUsage: boolean, wantProgress = false): AsyncGenerator<StreamEvent> {
    const { m } = this
    const sent = { ...body, ...(wantUsage ? { stream_options: { include_usage: true } } : {}), ...(wantProgress ? { return_progress: true } : {}) }
    const res = await request(
      joinUrl(m.connection.base_url, "chat/completions"),
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(sent),
        signal: req.signal,
        timeoutMs: (m.connection.timeout ?? 600) * 1000,
        tls: tlsFor(m.connection),
      },
      m.ref,
    ).catch((e) => {
      recordFailure(m.ref, sent, e)
      throw e
    })
    if (!res.body) throw new ProviderError(`${m.ref}: empty response`)
    const stream = record(res.body, m.ref, sent)

    const splitter = m.connection.quirks?.think_tags === "off" ? undefined : new ThinkSplitter()
    const acc = new ToolCallAccumulator()
    const banner = new SwapBanner()
    const out = new Parts()
    const addText = (kind: "text" | "reasoning", text: string) => out.add(kind, text)
    let finish = "stop"
    let usage: StreamEvent | undefined

    for await (const { data } of sseJson(stream)) {
      const chunk = data as any
      if (chunk?.error) {
        const err = chunk.error
        const msg = typeof err === "string" ? err : (err.message ?? JSON.stringify(err))
        // llama-swap's "group: model unloaded" (another request swapped the model out) carries a
        // string code; statusOf() still reads it as the server error it is.
        throw new ProviderError(`${m.ref}: ${String(msg).trim()}`, statusOf(err), undefined, !out.output)
      }
      if (chunk?.usage && typeof chunk.usage === "object") {
        const u = chunk.usage
        usage = {
          type: "usage",
          usage: {
            input: u.prompt_tokens ?? 0,
            output: u.completion_tokens ?? 0,
            reasoning: u.completion_tokens_details?.reasoning_tokens,
            cached: u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens,
          },
        }
      }
      // llama.cpp, while it reads the prompt: { total, cache, processed, time_ms }. Anything not
      // shaped like that is ignored, never an error.
      const pp = chunk?.prompt_progress
      if (pp && typeof pp === "object" && Number.isFinite(pp.total) && pp.total > 0 && !out.output)
        yield { type: "progress", total: Number(pp.total), cache: Number(pp.cache) || 0, processed: Number(pp.processed) || 0, ms: Number(pp.time_ms) || 0 }
      const choice = chunk?.choices?.[0]
      if (!choice) continue
      const delta = choice.delta ?? choice.message ?? {}
      let reasoning = delta.reasoning_content ?? delta.reasoning
      if (typeof reasoning === "string" && reasoning) {
        const b = banner.feed(reasoning)
        if (b.notice) yield { type: "notice", message: b.notice }
        reasoning = b.text
      }
      if (typeof reasoning === "string" && reasoning) {
        addText("reasoning", reasoning)
        yield { type: "reasoning", text: reasoning }
      }
      const content = textOf(delta.content)
      if (content) {
        for (const piece of splitter ? splitter.feed(content) : [{ kind: "text" as const, text: content }]) {
          addText(piece.kind, piece.text)
          yield { type: piece.kind, text: piece.text }
        }
      }
      for (const d of acc.feed(delta.tool_calls)) {
        out.output = true
        yield { type: "tool_call_delta", ...d }
      }
      if (choice.finish_reason) finish = String(choice.finish_reason)
    }
    for (const piece of splitter?.flush() ?? []) {
      addText(piece.kind, piece.text)
      yield { type: piece.kind, text: piece.text }
    }

    const calls = acc.result()
    for (const c of calls) out.push(c)
    // finish_reason is a hint only: some servers say "stop" after tool calls.
    // …except "length": a call cut off at the output limit has broken arguments, and the engine says so.
    if (calls.length && finish !== "length") finish = "tool_calls"
    const message = out.message()
    const parts = message.parts
    if (!usage) {
      const out = parts.reduce((n, p) => n + estimateTokens(p.type === "tool_call" ? p.name + p.args : p.text), 0)
      usage = { type: "usage", usage: { input: estimateTokens(JSON.stringify(body.messages)), output: out, estimated: true } }
    }
    yield usage
    yield { type: "finish", reason: finish, message }
  }

  async listModels(): Promise<DiscoveredModel[]> {
    const res = await request(joinUrl(this.m.connection.base_url, "models"), { headers: this.headers(), timeoutMs: 15_000, tls: tlsFor(this.m.connection) }, this.m.connectionName)
    const j = (await res.json()) as any
    const list: any[] = Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : []
    return list
      .map((x) => ({ id: String(x?.id ?? x?.name ?? ""), context: contextFrom(x) }))
      .filter((x) => x.id)
  }
}

/** Context window from a /models entry — every server names it differently. */
export function contextFrom(x: any): number | undefined {
  for (const v of [x?.context_length, x?.max_model_len, x?.context_window, x?.max_context_length, x?.meta?.n_ctx, x?.meta?.n_ctx_train]) {
    const n = Number(v)
    if (Number.isFinite(n) && n > 0) return n
  }
  return undefined
}

