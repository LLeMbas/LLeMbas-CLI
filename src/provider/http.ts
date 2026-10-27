import { readFileSync } from "node:fs"
import { expandHome } from "../config/paths.ts"
import type { Connection } from "../config/schema.ts"
import { ProviderError } from "./types.ts"
import { duration } from "../duration.ts"

const caCache = new Map<string, string>()

/** Bun's fetch `tls` option for a connection, or undefined for the defaults. */
export function tlsFor(c: Pick<Connection, "tls">): { ca?: string; rejectUnauthorized?: boolean } | undefined {
  if (!c.tls) return undefined
  const out: { ca?: string; rejectUnauthorized?: boolean } = {}
  if (c.tls.ca) {
    const file = expandHome(c.tls.ca)
    let pem = caCache.get(file)
    if (!pem) {
      try {
        pem = readFileSync(file, "utf8")
      } catch {
        throw new ProviderError(`cannot read tls.ca file ${c.tls.ca}`)
      }
      caCache.set(file, pem)
    }
    out.ca = pem
  }
  if (c.tls.insecure) out.rejectUnauthorized = false
  return out
}

/** The server's token as a bearer, plus the connection's and model's own headers. */
export function authHeaders(c: Pick<Connection, "headers">, key: string | undefined, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json", ...extra }
  if (key) h.authorization = `Bearer ${key}`
  return { ...h, ...c.headers }
}

export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "")
}

/** Turn an HTTP error body into one readable line: provider JSON errors nest the message differently. */
export function describeError(status: number, body: string): string {
  let msg = body.trim()
  try {
    const j = JSON.parse(body) as any
    msg = j?.error?.message ?? j?.error ?? j?.message ?? j?.detail ?? msg
    if (typeof msg !== "string") msg = JSON.stringify(msg)
  } catch {
    // not JSON
  }
  if (msg.length > 600) msg = msg.slice(0, 600) + "…"
  return `HTTP ${status}: ${msg || "(empty body)"}`
}

/** At most `max` bytes of a body, as text: an error page can be endless, or a gzip bomb. */
async function cappedText(res: Response, max: number): Promise<string> {
  if (!res.body) return ""
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done || !value) break
    chunks.push(value)
    size += value.length
    if (size >= max) {
      await reader.cancel().catch(() => {})
      break
    }
  }
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, max))
}

export async function request(
  url: string,
  init: RequestInit & { timeoutMs?: number; tls?: { ca?: string; rejectUnauthorized?: boolean } },
  what: string,
): Promise<Response> {
  // The timeout is for silence, not for length: waiting for the response, then any gap between two
  // pieces of the body. A reply may stream for as long as it keeps streaming — with a large
  // max_output a model can think for half an hour, and a total limit cut that off mid-reply.
  const ms = init.timeoutMs ?? 600_000
  const ctl = new AbortController()
  let silent = false
  let timer = setTimeout(() => ((silent = true), ctl.abort()), ms)
  const signal = init.signal ? AbortSignal.any([init.signal, ctl.signal]) : ctl.signal
  let res: Response
  try {
    res = await fetch(url, { ...init, signal })
  } catch (e) {
    clearTimeout(timer)
    const err = e as Error
    if (init.signal?.aborted) throw new ProviderError("cancelled")
    if (silent || err.name === "TimeoutError") throw new ProviderError(`${what}: timed out — no response in ${duration(ms, true)}`, undefined, undefined, true, true)
    const code = (err as { code?: string }).code ?? ""
    if (/CERT|SIGNATURE|SELF_SIGNED/.test(code))
      throw new ProviderError(`${what}: TLS certificate of ${new URL(url).host} is not trusted (${code}). Install its CA system-wide, or set tls.ca on the connection.`)
    throw new ProviderError(`${what}: cannot reach ${new URL(url).host} — ${err.message}`, undefined, undefined, true, true)
  }
  clearTimeout(timer)
  // A redirect asked to be handled by hand is a response, not an error.
  if (!res.ok && !(init.redirect === "manual" && res.status >= 300 && res.status < 400)) {
    const body = await cappedText(res, 64 * 1024).catch(() => "")
    throw new ProviderError(`${what}: ${describeError(res.status, body)}`, res.status, body)
  }
  if (!res.body) return res
  const reader = res.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(c) {
      timer = setTimeout(() => ((silent = true), ctl.abort()), ms)
      try {
        const r = await reader.read()
        if (r.done) c.close()
        else c.enqueue(r.value)
      } catch (e) {
        if (init.signal?.aborted) throw new ProviderError("cancelled")
        if (silent) throw new ProviderError(`${what}: timed out — the server sent nothing for ${duration(ms, true)}`, undefined, undefined, false)
        throw e
      } finally {
        clearTimeout(timer)
      }
    },
    cancel(reason) {
      clearTimeout(timer)
      return reader.cancel(reason)
    },
  })
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers })
}
