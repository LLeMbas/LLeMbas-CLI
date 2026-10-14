// What every dialect shares: the retry rule, the part builder, the stream recorder, and
// llama-swap's loading banner.
import type { ReasoningPart, StreamEvent, TextPart, ToolCallPart, Message } from "./types.ts"
import { ProviderError } from "./types.ts"
import { resolve } from "node:path"
import { env, localRoot } from "../config/paths.ts"

type Assistant = Extract<Message, { role: "assistant" }>

/** Builds an assistant message as deltas arrive, and knows whether anything real has been said —
 *  the line after which a retry would duplicate output. */
export class Parts {
  readonly parts: Assistant["parts"] = []
  output = false

  add(kind: "text" | "reasoning", text: string) {
    if (!text) return
    if (text.trim()) this.output = true
    const last = this.parts[this.parts.length - 1]
    if (last && last.type === kind && !(last as ReasoningPart).signature && !(last as ReasoningPart).opaque) (last as TextPart | ReasoningPart).text += text
    else this.parts.push({ type: kind, text } as TextPart | ReasoningPart)
  }

  push(p: ReasoningPart | ToolCallPart) {
    this.output = true
    this.parts.push(p)
  }

  message(): Assistant {
    return { role: "assistant", parts: this.parts }
  }
}

/** One decision per failed attempt: retry (optionally saying why), or give up. */
export type RetryHandler = (e: ProviderError) => { retry: boolean; notice?: string }

/** Run attempts until one succeeds. A retry is only ever considered while nothing of the reply has
 *  been passed on (`beforeOutput`); a server error gets two retries on top of whatever `handle` allows. */
export async function* retrying(attempt: () => AsyncGenerator<StreamEvent>, handle?: RetryHandler): AsyncGenerator<StreamEvent> {
  let retried5xx = 0
  for (let n = 0; ; n++) {
    try {
      yield* attempt()
      return
    } catch (e) {
      if (!(e instanceof ProviderError) || !e.beforeOutput || n >= 3) throw e
      const h = handle?.(e)
      if (h?.retry) {
        if (h.notice) yield { type: "notice", message: h.notice }
        continue
      }
      // Often the model's own output failing the server's parser (llama.cpp + gpt-oss), or the
      // model swapped out under us (llama-swap): sampling differs on a second go.
      // Twice: the first at once, the second after a pause (a model still loading, a busy server).
      if ((e.status ?? 0) >= 500 && retried5xx < 2) {
        retried5xx++
        yield { type: "notice", message: `server error, retrying (${retried5xx} of 2) — ${e.message.split("\n")[0]!.slice(0, 160)}` }
        if (retried5xx === 2) await new Promise((r) => setTimeout(r, 2000))
        continue
      }
      throw e
    }
  }
}

/** Status for an error object inside a stream: a numeric code is HTTP; llama-swap's
 *  `type: "server_error"` / `code: "internal_error"` is a 500 too. */
export function statusOf(err: any): number | undefined {
  if (typeof err?.code === "number") return err.code
  if (typeof err?.status === "number") return err.status
  if (err?.type === "server_error" || err?.type === "overloaded_error" || err?.type === "api_error" || /internal/i.test(String(err?.code ?? ""))) return 500
  return undefined
}

/** LEMBAS_RECORD, where it may be written: in local mode only inside the project's local root. */
function recordDir(): string | undefined {
  const dir = env("RECORD")
  const root = localRoot()
  if (!dir || !root) return dir
  const abs = resolve(dir)
  return abs === root || abs.startsWith(`${root}/`) ? abs : undefined
}

export function recordName(ref: string) {
  return `${recordDir()}/${new Date().toISOString().replace(/[:.]/g, "-")}-${ref.replace(/[^\w.-]+/g, "_")}`
}

export function recordFailure(ref: string, request: unknown, e: unknown) {
  if (!recordDir()) return
  const name = recordName(ref)
  void Bun.write(`${name}.request.json`, JSON.stringify(request, null, 2))
  const err = e as ProviderError
  void Bun.write(`${name}.error.json`, JSON.stringify({ status: err.status, message: err.message, body: err.body }, null, 2))
}

/** LEMBAS_RECORD=<dir>: keep each request body and its raw SSE, to become test fixtures. */
export function record(body: ReadableStream<Uint8Array>, ref: string, request: unknown): ReadableStream<Uint8Array> {
  const dir = recordDir()
  if (!dir) return body
  const [a, b] = body.tee()
  const name = recordName(ref)
  void Bun.write(`${name}.request.json`, JSON.stringify(request, null, 2))
  void new Response(b).text().then((raw) => Bun.write(`${name}.sse`, raw))
  return a
}

/** llama-swap streams its model-loading progress as reasoning, fenced by "━━━━━" lines, before the
 *  model's own first token. That is not the model thinking: it becomes one notice. */
export class SwapBanner {
  private buf = ""
  private state: "start" | "inside" | "done" = "start"

  private skipSpace = false

  feed(text: string): { text: string; notice?: string } {
    if (this.state === "done") {
      // The banner is followed by blank lines, streamed token by token; they are its, not the model's.
      if (this.skipSpace) {
        text = text.trimStart()
        if (text) this.skipSpace = false
      }
      return { text }
    }
    this.buf += text
    if (this.state === "start") {
      const probe = this.buf.trimStart()
      if (probe.length < 5 && "━━━━━".startsWith(probe)) return { text: "" }
      if (!probe.startsWith("━━━━━")) {
        this.state = "done"
        const out = this.buf
        this.buf = ""
        return { text: out }
      }
      this.state = "inside"
    }
    const open = this.buf.indexOf("━━━━━")
    const close = this.buf.indexOf("━━━━━", open + 5)
    if (close === -1) {
      if (this.buf.length > 4000) {
        this.state = "done"
        const out = this.buf
        this.buf = ""
        return { text: out }
      }
      return { text: "" }
    }
    const inner = this.buf.slice(open + 5, close).replace(/━+/g, "").trim()
    let rest = this.buf.slice(close).replace(/^━+\s*/, "")
    this.state = "done"
    this.buf = ""
    rest = rest.trimStart()
    this.skipSpace = rest === ""
    const lines = inner.split("\n").map((l) => l.trim()).filter(Boolean)
    const done = lines.find((l) => /^Done!/.test(l)) ?? ""
    const what = lines[0] ?? "model loading"
    return { text: rest, notice: `${what}${done ? " — " + done.toLowerCase() : ""}` }
  }
}

/** A tool call's arguments as they go back to the server in the history. A call cut off mid-way
 *  (the output limit) or garbled by the model has arguments that are not JSON, and llama.cpp parses
 *  the history's arguments again on every request — one broken call there fails each request after
 *  it with a 500. The tool result beside it already told the model what went wrong. */
export function historyArgs(args: string): string {
  try {
    const v = JSON.parse(args)
    if (v && typeof v === "object" && !Array.isArray(v)) return args
  } catch {}
  return "{}"
}
