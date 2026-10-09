// Speech to text and text to speech, over the providers voice.stt / voice.tts name. `webui` is a
// LLeMbas instance's own (OpenAI's shapes at <url>/v1, filled in by the loader); a half with a
// `fallback` uses it when its provider cannot be reached.
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Voice } from "../config/schema.ts"
import { expandHome } from "../config/paths.ts"
import { runKeyCmd } from "../config/substitute.ts"
import { joinUrl, request, tlsFor } from "../provider/http.ts"

type Endpoint = { base_url?: string; api_key?: string; key_cmd?: string; tls?: { ca?: string; insecure?: boolean }; timeout?: number }

const keys = new Map<string, string>()
function keyOf(e: Endpoint, where: string): string | undefined {
  if (e.api_key) return e.api_key
  if (!e.key_cmd) return undefined
  if (!keys.has(e.key_cmd)) keys.set(e.key_cmd, runKeyCmd(e.key_cmd, `${where}.key_cmd`))
  return keys.get(e.key_cmd)
}

function endpoint(e: Endpoint, where: string): { base: string; headers: Record<string, string>; tls: ReturnType<typeof tlsFor>; timeoutMs: number } {
  if (!e.base_url) throw new Error(`${where}.base_url is not set`)
  const key = keyOf(e, where)
  return { base: e.base_url, headers: key ? { authorization: `Bearer ${key}` } : {}, tls: tlsFor(e), timeoutMs: (e.timeout ?? 60) * 1000 }
}

type Stt = NonNullable<Voice["stt"]>
type Tts = NonNullable<Voice["tts"]>

/** The primary, then the fallback when the primary failed for any reason but a cancel. */
async function withFallback<T, H extends { fallback?: unknown }>(h: H, run: (half: H) => Promise<T>, signal?: AbortSignal): Promise<T> {
  try {
    return await run(h)
  } catch (e) {
    if (signal?.aborted || !h.fallback) throw e
    return run(h.fallback as H)
  }
}

/** What was said in a WAV. */
export async function transcribe(v: Voice | undefined, audio: Uint8Array, signal?: AbortSignal): Promise<string> {
  const s = v?.stt
  if (!s) throw new Error("voice input is not set up — add voice.stt to ~/.config/lembas/config.yaml")
  return withFallback(s, (h) => transcribeWith(h, audio, signal), signal)
}

async function transcribeWith(s: Stt, audio: Uint8Array, signal?: AbortSignal): Promise<string> {
  const e = endpoint(s, "voice.stt")
  const form = new FormData()
  form.append("file", new Blob([audio], { type: "audio/wav" }), "speech.wav")
  form.append("response_format", "json")
  if (s.language) form.append("language", s.language)
  if (s.prompt) form.append("prompt", s.prompt)
  let url: string
  if ((s.provider ?? "openai") === "whispercpp") {
    url = joinUrl(e.base, "inference")
    form.append("temperature", "0.0")
    form.append("temperature_inc", "0.2")
  } else {
    url = joinUrl(e.base, "audio/transcriptions")
    // webui: the instance's own model, whatever is sent.
    if (s.provider !== "webui" || s.model) form.append("model", s.model ?? "whisper-1")
  }
  const res = await request(url, { method: "POST", headers: e.headers, body: form, signal, timeoutMs: e.timeoutMs, tls: e.tls }, "voice.stt")
  const body = await res.text()
  try {
    const j = JSON.parse(body)
    return String(j.text ?? "").trim()
  } catch {
    return body.trim()
  }
}

/** A WAV of `text` spoken. */
export async function synthesize(v: Voice | undefined, text: string, signal?: AbortSignal): Promise<Uint8Array> {
  const t = v?.tts
  if (!t) throw new Error("voice output is not set up — add voice.tts to ~/.config/lembas/config.yaml")
  return withFallback(t, (h) => synthesizeWith(h, text, signal), signal)
}

async function synthesizeWith(t: Tts, text: string, signal?: AbortSignal): Promise<Uint8Array> {
  const provider = t.provider ?? "openai"
  if (provider === "piper-cli") {
    if (!t.model_path) throw new Error("voice.tts.model_path (a piper .onnx voice) is not set")
    const dir = mkdtempSync(join(tmpdir(), "lembas-piper-"))
    const out = join(dir, "say.wav")
    try {
      const args = [t.command ?? "piper", "-m", expandHome(t.model_path), "-f", out, ...(t.speed && t.speed !== 1 ? ["--length-scale", String(1 / t.speed)] : [])]
      const p = Bun.spawn(args, { stdin: new TextEncoder().encode(text), stdout: "ignore", stderr: "pipe" })
      const onAbort = () => p.kill()
      signal?.addEventListener("abort", onAbort, { once: true })
      const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()])
      signal?.removeEventListener("abort", onAbort)
      if (code !== 0) throw new Error(`piper exited ${code}: ${err.trim().split("\n").slice(-2).join(" ")}`)
      return new Uint8Array(readFileSync(out))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  const e = endpoint(t, "voice.tts")
  const body =
    provider === "piper-http"
      ? { text, ...(t.voice ? { voice: t.voice } : {}), ...(t.speed && t.speed !== 1 ? { length_scale: 1 / t.speed } : {}) }
      : provider === "webui"
        ? // The account's own voice and speed on the instance, unless this config names them.
          { input: text, response_format: "wav", ...(t.voice ? { voice: t.voice } : {}), ...(t.speed ? { speed: t.speed } : {}) }
        : { model: t.model ?? "tts-1", voice: t.voice ?? "alloy", input: text, response_format: "wav", ...(t.speed && t.speed !== 1 ? { speed: t.speed } : {}) }
  const url = provider === "piper-http" ? e.base : joinUrl(e.base, "audio/speech")
  const res = await request(url, { method: "POST", headers: { ...e.headers, "content-type": "application/json" }, body: JSON.stringify(body), signal, timeoutMs: e.timeoutMs, tls: e.tls }, "voice.tts")
  return new Uint8Array(await res.arrayBuffer())
}
