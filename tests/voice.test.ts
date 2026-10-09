import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { paths } from "../src/config/paths.ts"
import { loadConfig } from "../src/config/load.ts"
import { Recorder, rms, wav } from "../src/voice/audio.ts"
import { keyMatcher, VoiceController } from "../src/voice/index.ts"
import { synthesize, transcribe } from "../src/voice/speech.ts"
import { believable, sentences, spokenText } from "../src/voice/text.ts"

const FIX = join(import.meta.dir, "fixtures", "voice")
const BUN = process.execPath
const mic = (tone: number, silence = -1) => [BUN, join(FIX, "mic.ts"), String(tone), String(silence)]

let servers: { stop(b?: boolean): void }[] = []
afterEach(() => {
  for (const s of servers) s.stop(true)
  servers = []
})

/** A fake voice server: /v1/audio/transcriptions, /inference, /v1/audio/speech and a piper-style "/". */
function voiceServer() {
  const seen: { path: string; auth: string | null; fields: Record<string, string>; json?: any }[] = []
  const s = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url)
      const auth = req.headers.get("authorization")
      if (u.pathname.endsWith("/audio/transcriptions") || u.pathname === "/inference") {
        const f = await req.formData()
        const fields: Record<string, string> = {}
        for (const [k, v] of f.entries()) fields[k] = typeof v === "string" ? v : `file:${(v as File).name}:${(v as File).size}`
        seen.push({ path: u.pathname, auth, fields })
        return Response.json({ text: " Make the tests pass. " })
      }
      const json = await req.json()
      seen.push({ path: u.pathname, auth, fields: {}, json })
      return new Response(wav(new Uint8Array(3200)))
    },
  })
  servers.push(s)
  return { url: `http://127.0.0.1:${s.port}`, seen }
}

describe("what is said aloud", () => {
  test("markdown becomes speech: no code, no links or URLs, headings and lists as sentences, symbols as words", () => {
    const md = "## Result\n\nThe **build** passed — see [the log](https://ci/x) or https://ci/y.\n\n```ts\nconst x = 1\n```\n\n- 3 tests fixed\n- coverage 85%\n\nIt costs €12/month → cheap 🎉"
    expect(spokenText(md)).toBe("Result. The build passed — see the log or. 3 tests fixed. coverage 85 percent. It costs 12 euros per month to cheap.")
    expect(spokenText("| a | b |\n|---|---|\n| 1 | 2 |")).toBe("a; b. 1; 2.")
  })

  test("sentences: whole ones, small ones merged, none over the limit", () => {
    const s = sentences("One. Two. " + "Long sentence with words, ".repeat(30) + "end. Last one here.", 200)
    expect(s[0]).toStartWith("One. Two. Long sentence")
    expect(s.length).toBeGreaterThan(3)
    expect(s.every((x) => x.length <= 200)).toBe(true)
    expect(s.at(-1)).toContain("Last one here.")
    // no punctuation at all: split at spaces, nothing dropped
    const run = "word ".repeat(150).trim()
    const pieces = sentences(run, 200)
    expect(pieces.every((x) => x.length <= 200)).toBe(true)
    expect(pieces.join(" ")).toBe(run)
  })

  test("what Whisper hears in silence is dropped; real speech is kept", () => {
    expect(believable(" Thank you. ")).toBe("")
    expect(believable("you")).toBe("")
    expect(believable("[BLANK_AUDIO]")).toBe("")
    expect(believable("Okay. Thanks!")).toBe("")
    expect(believable("Thank you, now fix the test.")).toBe("Thank you, now fix the test.")
  })
})

describe("recording", () => {
  test("a WAV header, and loudness", () => {
    const w = wav(new Uint8Array(32000))
    expect(new TextDecoder().decode(w.slice(0, 4))).toBe("RIFF")
    expect(new DataView(w.buffer).getUint32(24, true)).toBe(16000)
    expect(new DataView(w.buffer).getUint32(40, true)).toBe(32000)
    const loud = new Uint8Array(4)
    new DataView(loud.buffer).setInt16(0, 1000, true)
    new DataView(loud.buffer).setInt16(2, -1000, true)
    expect(rms(loud)).toBe(1000)
  })

  test("speech then silence stops by itself; the WAV holds it all", async () => {
    let auto = ""
    const r = new Recorder({ command: mic(1), silenceSeconds: 0.5, onAutoStop: (why) => (auto = why) })
    const until = Date.now() + 10_000
    while (!auto && Date.now() < until) await Bun.sleep(20)
    expect(auto).toBe("silence")
    const rec = await r.stop()
    expect(rec.reason).toBe("silence")
    expect(rec.empty).toBeUndefined()
    expect(rec.seconds).toBeGreaterThan(1.4)
    expect(rec.seconds).toBeLessThan(2.2)
    expect(rec.wav.length).toBe(44 + Math.round(rec.seconds * 16000) * 2)
  })

  test("a pipeline that ignores SIGINT still stops, whole, within seconds", async () => {
    const [bun, script] = mic(1)
    const r = new Recorder({ command: ["sh", "-c", `trap '' INT; "${bun}" "${script}" 1 | cat`], silenceSeconds: 0.3 })
    const t0 = Date.now()
    let auto = ""
    ;(r as any).o.onAutoStop = (why: string) => (auto = why)
    while (!auto && Date.now() - t0 < 10_000) await Bun.sleep(20)
    const rec = await r.stop()
    expect(rec.reason).toBe("silence")
    expect(Date.now() - t0).toBeLessThan(8000)
    expect(rec.wav.length).toBeGreaterThan(44)
    const pid = (r as any).proc.pid as number
    let alive = true
    try {
      process.kill(-pid, 0)
    } catch {
      alive = false
    }
    expect(alive).toBe(false)
  })

  test("only silence: no speech, nothing to transcribe; a recorder that fails says why", async () => {
    let auto = ""
    const r = new Recorder({ command: mic(0), maxWait: 0.5, onAutoStop: (why) => (auto = why) })
    while (!auto) await Bun.sleep(20)
    const rec = await r.stop()
    expect([auto, rec.empty]).toEqual(["no-speech", "no speech heard"])
    let died = ""
    const failing = new Recorder({ command: [BUN, "-e", "console.error('no such device'); process.exit(1)"], onAutoStop: (why) => (died = why) })
    while (!died) await Bun.sleep(20)
    const bad = await failing.stop()
    expect([died, bad.empty]).toEqual(["error", "the recorder stopped: no such device"])
  })

  test("a recorder that writes a sound file instead of raw samples is refused, not heard as noise", async () => {
    // What pw-record writes to stdout without --raw: a Sun AU header, then big-endian samples.
    let why = ""
    const au = new Recorder({ command: [BUN, "-e", "process.stdout.write('.snd' + '\\0'.repeat(3196)); setInterval(() => {}, 1000)"], onAutoStop: (w) => (why = w) })
    while (!why) await Bun.sleep(20)
    const rec = await au.stop()
    expect([why, rec.empty, rec.wav.length]).toEqual(["error", "the recorder stopped: it writes an AU file, not raw 16 kHz mono s16le samples", 0])
  })
})

test("pw-record is asked for raw samples", async () => {
  const { RECORDERS } = await import("../src/voice/audio.ts")
  expect(RECORDERS["pw-record"]!()).toContain("--raw")
})

describe("speech services", () => {
  test("openai: multipart with model, language, prompt and a bearer; TTS asks for WAV with model, voice, speed", async () => {
    const f = voiceServer()
    const v = { stt: { base_url: `${f.url}/v1`, api_key: "k1", model: "whisper-1", language: "en", prompt: "LLeMbas" }, tts: { base_url: `${f.url}/v1`, key_cmd: "echo k2", model: "kokoro", voice: "af_heart", speed: 1.2 } } as any
    expect(await transcribe(v, wav(new Uint8Array(10)))).toBe("Make the tests pass.")
    expect(f.seen[0]).toMatchObject({ path: "/v1/audio/transcriptions", auth: "Bearer k1", fields: { model: "whisper-1", language: "en", prompt: "LLeMbas", response_format: "json", file: "file:speech.wav:54" } })
    const audio = await synthesize(v, "Hello there.")
    expect(new TextDecoder().decode(audio.slice(0, 4))).toBe("RIFF")
    expect(f.seen[1]).toMatchObject({ path: "/v1/audio/speech", auth: "Bearer k2", json: { model: "kokoro", voice: "af_heart", input: "Hello there.", response_format: "wav", speed: 1.2 } })
  })

  test("whispercpp /inference and piper-http", async () => {
    const f = voiceServer()
    await transcribe({ stt: { provider: "whispercpp", base_url: f.url } } as any, wav(new Uint8Array(10)))
    expect(f.seen[0]).toMatchObject({ path: "/inference", auth: null, fields: { response_format: "json", temperature: "0.0" } })
    expect(f.seen[0]!.fields.model).toBeUndefined()
    await synthesize({ tts: { provider: "piper-http", base_url: f.url, speed: 2 } } as any, "Hi.")
    expect(f.seen[1]).toMatchObject({ path: "/", json: { text: "Hi.", length_scale: 0.5 } })
  })

  test("piper-cli: the text on stdin, the model and the output file as flags; a failure says why", async () => {
    const piper = join(mkdtempSync(join(tmpdir(), "ph-piper-")), "piper")
    writeFileSync(piper, `#!/bin/sh\nexec "${BUN}" "${join(FIX, "piper.ts")}" "$@"\n`)
    chmodSync(piper, 0o755)
    const out = await synthesize({ tts: { provider: "piper-cli", command: piper, model_path: "/v/en.onnx" } } as any, "hello")
    expect(new TextDecoder().decode(out)).toBe("RIFFhello")
    await expect(synthesize({ tts: { provider: "piper-cli", command: piper, model_path: "/v/en.bin" } } as any, "x")).rejects.toThrow("no such model")
  })
})

describe("the controller", () => {
  test("record → silence → transcribed → heard; a reply is spoken sentence by sentence; esc cuts it off", async () => {
    const f = voiceServer()
    const log = join(mkdtempSync(join(tmpdir(), "ph-play-")), "log")
    writeFileSync(log, "")
    process.env.PLAYLOG = log
    const heard: string[] = []
    const v = new VoiceController(
      {
        stt: { base_url: `${f.url}/v1` },
        tts: { base_url: `${f.url}/v1` },
        recorder_command: mic(1),
        silence_seconds: 0.4,
        player_command: [BUN, join(FIX, "player.ts")],
      },
      { heard: (t) => heard.push(t) },
    )
    v.start()
    expect(v.state).toBe("recording")
    const until = Date.now() + 10_000
    while (!heard.length && Date.now() < until) await Bun.sleep(20)
    expect(heard).toEqual(["Make the tests pass."])
    expect(v.state).toBe("idle")
    const long = (w: string) => `${w} ${"and it goes on for a while ".repeat(4).trim()}.`
    await v.speak(`${long("First")} ${long("Second")}\n\n\`\`\`\ncode\n\`\`\`\n\nThird.`)
    const said = f.seen.filter((x) => x.path.endsWith("/speech")).map((x) => x.json.input)
    expect(said).toEqual([long("First"), `${long("Second")} Third.`])
    const plays = readFileSync(log, "utf8").trim().split("\n")
    expect(plays).toHaveLength(2)
    // cut off: nothing more is played
    const p = v.speak("One. " + "Two. ".repeat(200))
    await Bun.sleep(30)
    v.stopSpeaking()
    await p
    expect(v.speaking).toBe(false)
  })

  test("not set up: a clear message, nothing started", () => {
    const notes: string[] = []
    const v = new VoiceController(undefined, { notice: (m) => notes.push(m) })
    v.start()
    expect(v.state).toBe("idle")
    expect(notes[0]).toContain("voice.stt")
  })

  test("the record key", () => {
    const k = keyMatcher()
    expect(k.label).toBe("Ctrl+T")
    expect(k.matches({ name: "t", ctrl: true })).toBe(true)
    expect(k.matches({ name: "t" })).toBe(false)
    expect(keyMatcher("alt+space").matches({ name: "space", meta: true })).toBe(true)
    expect(keyMatcher("f9").matches({ name: "f9" })).toBe(true)
    // refused, with the default in its place
    for (const bad of ["cmd+t", "super+r", "t", "space", "ctrl+c", "ctrl+nonsense"]) {
      const m = keyMatcher(bad)
      expect(m.warning).toContain("using Ctrl+T")
      expect(m.matches({ name: "t" })).toBe(false)
    }
    // a release is the key's name, whatever the modifiers do
    expect(k.released({ name: "t" })).toBe(true)
  })
})

describe("config", () => {
  test("voice is global only; a missing variable turns off that half only", () => {
    mkdirSync(paths.config, { recursive: true })
    process.env.PH_VOICE_KEY = "vk"
    writeFileSync(join(paths.config, "config.yaml"), `voice:\n  stt: { base_url: "http://x/v1", api_key: "{env:PH_VOICE_KEY}" }\n  tts: { base_url: "http://x/v1", api_key: "{env:PH_VOICE_NOPE}" }\n`)
    const proj = mkdtempSync(join(tmpdir(), "ph-vproj-"))
    // malformed too: it is dropped before validation, so it cannot break the project's config
    writeFileSync(join(proj, "config.yaml"), `mode: plan\nvoice:\n  stt: { base_url: "http://evil/v1", nonsense: 1 }\n`)
    const l = loadConfig({ projectConfigDir: proj, trusted: true })
    expect(l.config.voice?.stt?.base_url).toBe("http://x/v1")
    expect(l.config.mode).toBe("plan")
    expect(l.config.voice?.stt?.api_key).toBe("vk")
    expect(l.config.voice?.tts).toBeUndefined()
    expect(l.warnings.join("\n")).toContain("`voice` is honoured only in the global config")
    expect(l.warnings.join("\n")).toContain("voice output is off")
    writeFileSync(join(paths.config, "config.yaml"), "")
  })
})
