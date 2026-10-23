// Ollama, native (`POST {base}/api/chat`, NDJSON), base e.g. http://localhost:11434. Its
// OpenAI-compatible /v1 works through openai-chat too; the native API adds num_ctx (without it
// Ollama silently cuts every conversation to its small default window) and `think` levels.
// UNTESTED: no Ollama server has been available to try it against (see the wiki). Checked against
// Hermes Agent's handling (agent/model_metadata.py, agent/reasoning_params.py): /api/show decides
// the window to ask for and whether `think` may be sent at all.
import { resolveKey } from "../config/load.ts"
import { Parts, record, recordFailure, retrying, statusOf } from "./common.ts"
import { authHeaders, joinUrl, request, tlsFor } from "./http.ts"
import { estimateTokens, estimateValue } from "./tokens.ts"
import { ProviderError, type ChatRequest, type Client, type DiscoveredModel, type Message, type ResolvedModel, type StreamEvent } from "./types.ts"

export function toOllamaMessages(system: string, messages: Message[], vision: boolean): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  if (system) out.push({ role: "system", content: system })
  for (const m of messages) {
    if (m.role === "user") {
      const images = vision ? m.parts.filter((p) => p.type === "image").map((p) => (p as { data: string }).data) : []
      const text = m.parts.map((p) => (p.type === "text" ? p.text : vision ? "" : "[image omitted: this model has no vision]")).filter(Boolean).join("\n")
      out.push({ role: "user", content: text, ...(images.length ? { images } : {}) })
    } else if (m.role === "assistant") {
      const text = m.parts.map((p) => (p.type === "text" ? p.text : "")).join("")
      const thinking = m.parts.map((p) => (p.type === "reasoning" ? p.text : "")).join("")
      const calls = m.parts.flatMap((p) => {
        if (p.type !== "tool_call") return []
        let args: unknown = {}
        try {
          args = p.args.trim() ? JSON.parse(p.args) : {}
        } catch {}
        return [{ function: { name: p.name, arguments: args } }]
      })
      out.push({ role: "assistant", content: text, ...(thinking ? { thinking } : {}), ...(calls.length ? { tool_calls: calls } : {}) })
    } else out.push({ role: "tool", content: m.content, tool_name: m.name })
  }
  return out
}

/** NDJSON: one JSON object per line. */
async function* ndjson(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const dec = new TextDecoder()
  let buf = ""
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true })
    let nl: number
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line)
        try {
          yield JSON.parse(line)
        } catch {}
    }
  }
  const last = (buf + dec.decode()).trim()
  if (last)
    try {
      yield JSON.parse(last)
    } catch {}
}

/** What /api/show says about a model. */
export interface OllamaShow {
  /** "completion", "tools", "thinking", "vision"…; absent before Ollama 0.6. */
  capabilities?: string[]
  /** The runtime window the Modelfile sets (`num_ctx`), which the owner of the server chose. */
  numCtx?: number
  /** The trained maximum (`model_info["<arch>.context_length"]`). */
  trained?: number
}

export function parseShow(j: any): OllamaShow {
  const out: OllamaShow = {}
  if (Array.isArray(j?.capabilities)) out.capabilities = j.capabilities.map(String)
  for (const line of String(j?.parameters ?? "").split("\n")) {
    const f = line.trim().split(/\s+/)
    if (f[0] === "num_ctx" && Number(f[1]) > 0) out.numCtx = Number(f[1])
  }
  const info = j?.model_info ?? {}
  const key = Object.keys(info).find((k) => k.endsWith(".context_length"))
  if (key && Number(info[key]) > 0) out.trained = Number(info[key])
  return out
}

export class OllamaClient implements Client {
  private shown?: Promise<OllamaShow | undefined>
  constructor(private m: ResolvedModel) {}

  /** /api/show for this model, asked once; undefined when the server does not answer it. */
  show(id = this.m.id): Promise<OllamaShow | undefined> {
    const ask = async () => {
      const res = await request(joinUrl(this.m.connection.base_url, "api/show"), { method: "POST", headers: this.headers(), body: JSON.stringify({ model: id, name: id }), timeoutMs: 15_000, tls: tlsFor(this.m.connection) }, this.m.connectionName)
      return parseShow(await res.json())
    }
    if (id !== this.m.id) return ask().catch(() => undefined)
    return (this.shown ??= ask().catch(() => undefined))
  }

  private headers() {
    return authHeaders(this.m.connection, resolveKey(this.m.connectionName, this.m.connection), this.m.spec.headers)
  }

  buildBody(req: ChatRequest, show?: OllamaShow): Record<string, unknown> {
    const { m } = this
    const options: Record<string, unknown> = {}
    // Without num_ctx Ollama cuts every conversation to its small default window. Configured wins;
    // else the Modelfile's, else the trained maximum (set `context` to cap it to what memory holds).
    const ctx = m.spec.context ?? show?.numCtx ?? show?.trained
    if (ctx) options.num_ctx = ctx
    if (m.spec.max_output) options.num_predict = m.spec.max_output
    if (m.spec.temperature !== undefined) options.temperature = m.spec.temperature
    if (m.spec.top_p !== undefined) options.top_p = m.spec.top_p
    const body: Record<string, unknown> = { model: m.id, messages: toOllamaMessages(req.system, req.messages, m.spec.vision === true), stream: true, options, ...m.connection.body, ...m.spec.body }
    if (req.tools.length && m.spec.tools !== false)
      body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }))
    // gpt-oss takes a level; other thinking models take a switch. A model /api/show says cannot
    // think gets no `think` at all: Ollama refuses the request.
    const thinks = !show?.capabilities || show.capabilities.includes("thinking")
    if (thinks && req.effort) body.think = /gpt-oss/.test(m.id) ? (req.effort === "minimal" ? "low" : req.effort === "xhigh" || req.effort === "max" ? "high" : req.effort) : true
    else if (thinks && m.spec.efforts?.length) body.think = false
    return body
  }

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    const body = this.buildBody(req, await this.show())
    yield* retrying(() => this.attempt(req, body))
  }

  private async *attempt(req: ChatRequest, body: Record<string, unknown>): AsyncGenerator<StreamEvent> {
    const { m } = this
    const res = await request(joinUrl(m.connection.base_url, "api/chat"), { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal: req.signal, timeoutMs: (m.connection.timeout ?? 600) * 1000, tls: tlsFor(m.connection) }, m.ref).catch((e) => {
      recordFailure(m.ref, body, e)
      throw e
    })
    if (!res.body) throw new ProviderError(`${m.ref}: empty response`)
    const out = new Parts()
    let finish = "stop"
    let usage: StreamEvent | undefined
    let calls = 0
    for await (const chunk of ndjson(record(res.body, m.ref, body)) as AsyncGenerator<any>) {
      if (chunk?.error) throw new ProviderError(`${m.ref}: ${chunk.error}`, statusOf(chunk) ?? 500, undefined, !out.output)
      const msg = chunk?.message ?? {}
      if (msg.thinking) {
        out.add("reasoning", msg.thinking)
        yield { type: "reasoning", text: msg.thinking }
      }
      if (msg.content) {
        out.add("text", msg.content)
        yield { type: "text", text: msg.content }
      }
      for (const tc of msg.tool_calls ?? []) {
        const args = JSON.stringify(tc.function?.arguments ?? {})
        yield { type: "tool_call_delta", index: calls, name: tc.function?.name, argsDelta: args }
        out.push({ type: "tool_call", id: tc.id ?? `ollama_call_${calls}`, name: tc.function?.name ?? "", args })
        calls++
      }
      if (chunk?.done) {
        finish = chunk.done_reason === "length" ? "length" : "stop"
        if (chunk.prompt_eval_count !== undefined || chunk.eval_count !== undefined) usage = { type: "usage", usage: { input: chunk.prompt_eval_count ?? 0, output: chunk.eval_count ?? 0 } }
      }
    }
    const message = out.message()
    if (calls && finish !== "length") finish = "tool_calls"
    yield usage ?? { type: "usage", usage: { input: estimateValue(body.messages), output: message.parts.reduce((n, p) => n + estimateTokens(p.type === "tool_call" ? p.args : p.text), 0), estimated: true } }
    yield { type: "finish", reason: finish, message }
  }

  async listModels(): Promise<DiscoveredModel[]> {
    const res = await request(joinUrl(this.m.connection.base_url, "api/tags"), { headers: this.headers(), timeoutMs: 15_000, tls: tlsFor(this.m.connection) }, this.m.connectionName)
    const j = (await res.json()) as any
    return (j?.models ?? []).map((x: any) => ({ id: String(x.name ?? x.model ?? "") })).filter((x: DiscoveredModel) => x.id)
  }

  /** The model's window: the Modelfile's num_ctx, else its trained maximum. */
  async contextOf(id: string): Promise<number | undefined> {
    const s = await this.show(id)
    return s?.numCtx ?? s?.trained
  }
}
