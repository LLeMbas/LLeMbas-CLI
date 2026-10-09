// Voice: talk to the agent, and have it talk back. One controller per app; the TUI binds a key
// to `toggle()` and shows `state`, `level` and `seconds`. After Hermes Agent's voice mode
// (tools/voice_mode.py, hermes_cli/cli_voice_mixin.py; MIT, © Nous Research), without its
// continuous conversation loop: a coding agent's replies are to be read, then maybe heard.
import type { Voice } from "../config/schema.ts"
import { play, playerFor, Recorder, recorderFor, type StopReason } from "./audio.ts"
import { synthesize, transcribe } from "./speech.ts"
import { believable, sentences, spokenText } from "./text.ts"

export type VoiceState = "idle" | "recording" | "transcribing"

export interface VoiceEvents {
  /** Anything the UI shows changed (state, speaking, level). */
  changed?: () => void
  /** What was said, believable and non-empty. */
  heard?: (text: string) => void
  /** Something to tell the user. */
  notice?: (message: string, warn?: boolean) => void
}

/** The longest reply read out; beyond it the rest is left to the screen. */
const MAX_SPOKEN = 3000

export class VoiceController {
  state: VoiceState = "idle"
  speaking = false
  /** Speak every reply. */
  speakReplies: boolean
  private rec?: Recorder
  private speech?: { abort: AbortController; stop?: () => void }

  constructor(
    readonly cfg: Voice | undefined,
    private ev: VoiceEvents = {},
  ) {
    this.speakReplies = cfg?.speak === true
  }

  get canListen() {
    return !!this.cfg?.stt
  }
  get canSpeak() {
    return !!this.cfg?.tts
  }
  get level() {
    return this.rec?.level ?? 0
  }
  get seconds() {
    return this.rec?.seconds ?? 0
  }

  /** The record key: start, or stop and transcribe. */
  async toggle(): Promise<void> {
    if (this.state === "recording") return this.finish("stopped")
    if (this.state === "transcribing") return
    this.start()
  }

  start() {
    if (this.state !== "idle") return
    if (!this.canListen) return this.ev.notice?.("voice input is not set up — add voice.stt to ~/.config/lembas/config.yaml (/voice shows how)", true)
    const cmd = recorderFor(this.cfg)
    if (typeof cmd === "string") return this.ev.notice?.(cmd, true)
    // Talking over the agent cuts it off.
    this.stopSpeaking()
    try {
      this.rec = new Recorder({
        command: cmd,
        silenceSeconds: this.cfg?.silence_seconds,
        maxSeconds: this.cfg?.max_seconds,
        threshold: this.cfg?.silence_threshold,
        onAutoStop: (reason) => void this.finish(reason),
      })
    } catch (e) {
      return this.ev.notice?.(`could not start ${cmd[0]}: ${(e as Error).message}`, true)
    }
    this.state = "recording"
    this.ev.changed?.()
  }

  /** Stop recording and throw it away. */
  async cancel() {
    if (this.state !== "recording" || !this.rec) return
    await this.rec.stop("cancelled")
    this.rec = undefined
    this.state = "idle"
    this.ev.changed?.()
  }

  private async finish(reason: StopReason) {
    const rec = this.rec
    if (this.state !== "recording" || !rec) return
    this.state = "transcribing"
    this.ev.changed?.()
    try {
      const r = await rec.stop(reason)
      if (r.empty) {
        if (r.empty !== "cancelled") this.ev.notice?.(r.reason === "no-speech" ? "no speech heard" : r.empty, r.reason === "error")
        return
      }
      const text = believable(await transcribe(this.cfg, r.wav))
      if (!text) this.ev.notice?.("nothing recognisable was said")
      else this.ev.heard?.(text)
    } catch (e) {
      this.ev.notice?.(`transcription failed: ${(e as Error).message}`, true)
    } finally {
      this.rec = undefined
      this.state = "idle"
      this.ev.changed?.()
    }
  }

  /** Read a reply aloud, sentence by sentence, making the next while the last one plays. */
  async speak(markdown: string): Promise<void> {
    // Never into an open microphone: the reply would end up in the transcript.
    if (this.state !== "idle") return
    if (!this.canSpeak) return this.ev.notice?.("voice output is not set up — add voice.tts to ~/.config/lembas/config.yaml", true)
    const player = playerFor(this.cfg)
    if (typeof player === "string") return this.ev.notice?.(player, true)
    this.stopSpeaking()
    let text = spokenText(markdown)
    if (!text) return
    if (text.length > MAX_SPOKEN) text = `${text.slice(0, MAX_SPOKEN).replace(/[^.!?]*$/, "")} The rest is on the screen.`
    const abort = new AbortController()
    const run: { abort: AbortController; stop?: () => void } = { abort }
    this.speech = run
    this.speaking = true
    this.ev.changed?.()
    try {
      const parts = sentences(text)
      let next: Promise<Uint8Array> | undefined = synthesize(this.cfg, parts[0]!, abort.signal)
      for (let i = 0; i < parts.length && !abort.signal.aborted; i++) {
        const audio = await next!
        next = i + 1 < parts.length ? synthesize(this.cfg, parts[i + 1]!, abort.signal) : undefined
        next?.catch(() => {})
        if (abort.signal.aborted) break
        const p = play(player, audio)
        run.stop = p.stop
        await p.done
      }
    } catch (e) {
      if (!abort.signal.aborted) this.ev.notice?.(`speaking failed: ${(e as Error).message}`, true)
    } finally {
      if (this.speech === run) {
        this.speech = undefined
        this.speaking = false
        this.ev.changed?.()
      }
    }
  }

  stopSpeaking() {
    const s = this.speech
    if (!s) return
    s.abort.abort()
    s.stop?.()
    this.speech = undefined
    this.speaking = false
    this.ev.changed?.()
  }

  async close() {
    this.stopSpeaking()
    await this.cancel()
  }
}

const MODIFIERS: Record<string, "ctrl" | "alt" | "shift"> = { ctrl: "ctrl", control: "ctrl", alt: "alt", option: "alt", opt: "alt", meta: "alt", shift: "shift" }
const NAMED = new Set(["space", "enter", "return", "tab", "backspace", "delete", "insert", "home", "end", "pageup", "pagedown", "up", "down", "left", "right", ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`)])

export interface KeyMatcher {
  label: string
  /** Set when the configured key was not usable and the default is used instead. */
  warning?: string
  matches(k: { name?: string; ctrl?: boolean; meta?: boolean; option?: boolean; shift?: boolean }): boolean
  /** A release: only the key's name counts — the modifier may be let go first. */
  released(k: { name?: string }): boolean
}

/** "ctrl+t", "alt+space", "f9" → a matcher for OpenTUI key events. A key that types a character
 *  needs ctrl or alt, or it would swallow every "t" typed; an unknown modifier is refused. */
export function keyMatcher(spec = "ctrl+t"): KeyMatcher {
  const parts = spec.toLowerCase().split("+").map((s) => s.trim()).filter(Boolean)
  const raw = parts.pop() ?? ""
  const name = raw === "spc" ? "space" : raw === "esc" ? "escape" : raw
  const unknown = parts.filter((m) => !MODIFIERS[m])
  const mods = new Set(parts.map((m) => MODIFIERS[m]).filter((m): m is "ctrl" | "alt" | "shift" => !!m))
  const printable = name.length === 1 || name === "space"
  const bad = !name ? "no key" : unknown.length ? `unknown modifier ${unknown.join(", ")}` : name === "escape" || (mods.has("ctrl") && ["c", "d", "j", "r", "o"].includes(name)) ? `${spec} is taken` : name.length > 1 && !NAMED.has(name) ? `unknown key ${raw}` : printable && !mods.has("ctrl") && !mods.has("alt") ? `${spec} would swallow typing — add ctrl+ or alt+` : undefined
  if (bad) return { ...keyMatcher("ctrl+t"), warning: `voice.record_key: ${bad}; using Ctrl+T` }
  const label = [...mods].map((m) => m[0]!.toUpperCase() + m.slice(1)).concat(name.length === 1 ? name.toUpperCase() : name[0]!.toUpperCase() + name.slice(1)).join("+")
  return {
    label,
    matches: (k) => k.name === name && !!k.ctrl === mods.has("ctrl") && !!(k.meta || k.option) === mods.has("alt") && !!k.shift === mods.has("shift"),
    released: (k) => k.name === name,
  }
}
