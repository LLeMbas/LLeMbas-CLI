// Recording and playing, through whatever the system has. Every recorder is asked for the same
// thing — raw 16 kHz mono signed 16-bit little-endian on stdout — so loudness can be measured as
// it comes (the level meter, and stopping on silence, as Hermes Agent's voice mode does:
// tools/voice_mode.py, MIT, © Nous Research) and the WAV file is written here.
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Voice } from "../config/schema.ts"

export const RATE = 16000

/** Recorders and players still running, ended with LLeMbas CLI however it ends; and the players'
 *  temporary files. */
const live = new Set<{ kill(sig?: number | NodeJS.Signals): void }>()
const tempDirs = new Set<string>()
process.once("exit", () => {
  for (const p of live)
    try {
      p.kill("SIGKILL")
    } catch {}
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true })
})
const BLOCK = 480 // samples: 30 ms

/** What each player is, for someone who has not met it. */
export const PLAYER_NAMES: Record<string, string> = {
  "pw-play": "PipeWire's player",
  paplay: "PulseAudio's player",
  aplay: "ALSA's player",
  ffplay: "FFmpeg's player",
  mpv: "the mpv media player",
  afplay: "macOS's player",
}

export const RECORDERS: Record<string, () => string[]> = {
  // --raw: without it pw-cat writes stdout as a Sun AU file (a header, then big-endian samples).
  "pw-record": () => ["pw-record", "--raw", "--rate", String(RATE), "--channels", "1", "--format", "s16", "-"],
  parec: () => ["parec", "--format=s16le", `--rate=${RATE}`, "--channels=1", "--raw"],
  arecord: () => ["arecord", "-q", "-t", "raw", "-f", "S16_LE", "-r", String(RATE), "-c", "1"],
  sox: () => [process.platform === "darwin" && Bun.which("rec") ? "rec" : "sox", "-q", ...(process.platform === "darwin" && Bun.which("rec") ? [] : ["-d"]), "-t", "raw", "-r", String(RATE), "-c", "1", "-b", "16", "-e", "signed-integer", "-"],
  ffmpeg: () => ["ffmpeg", "-loglevel", "error", ...(process.platform === "darwin" ? ["-f", "avfoundation", "-i", ":0"] : ["-f", "pulse", "-i", "default"]), "-ac", "1", "-ar", String(RATE), "-f", "s16le", "-"],
}
const RECORDER_ORDER = ["pw-record", "parec", "arecord", "sox", "ffmpeg"]

const PLAYERS: Record<string, string[]> = {
  afplay: ["afplay"],
  "pw-play": ["pw-play"],
  paplay: ["paplay"],
  aplay: ["aplay", "-q"],
  ffplay: ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet"],
  mpv: ["mpv", "--no-video", "--really-quiet"],
}
const PLAYER_ORDER = ["afplay", "pw-play", "paplay", "aplay", "ffplay", "mpv"]

/** The recording command, or why there is none. */
export function recorderFor(v: Voice | undefined): string[] | string {
  if (v?.recorder_command) return v.recorder_command
  const want = v?.recorder && v.recorder !== "auto" ? [v.recorder] : RECORDER_ORDER
  for (const name of want) {
    const cmd = RECORDERS[name]!()
    if (Bun.which(cmd[0]!)) return cmd
  }
  return v?.recorder && v.recorder !== "auto" ? `${v.recorder} is not installed` : "no recorder found — install pipewire (pw-record), pulseaudio-utils (parec), alsa-utils (arecord), sox or ffmpeg"
}

export function playerFor(v: Voice | undefined): string[] | string {
  if (v?.player_command) return v.player_command
  const want = v?.player && v.player !== "auto" ? [v.player] : PLAYER_ORDER
  for (const name of want) if (Bun.which(PLAYERS[name]![0]!)) return PLAYERS[name]!
  return v?.player && v.player !== "auto" ? `${v.player} is not installed` : "no audio player found — install pipewire (pw-play), pulseaudio-utils (paplay), alsa-utils (aplay), ffmpeg (ffplay) or mpv"
}

/** A WAV file around raw 16-bit mono samples. */
export function wav(pcm: Uint8Array, rate = RATE): Uint8Array {
  const out = new Uint8Array(44 + pcm.length)
  const d = new DataView(out.buffer)
  const text = (at: number, s: string) => [...s].forEach((c, i) => d.setUint8(at + i, c.charCodeAt(0)))
  text(0, "RIFF")
  d.setUint32(4, 36 + pcm.length, true)
  text(8, "WAVE")
  text(12, "fmt ")
  d.setUint32(16, 16, true)
  d.setUint16(20, 1, true) // PCM
  d.setUint16(22, 1, true) // mono
  d.setUint32(24, rate, true)
  d.setUint32(28, rate * 2, true)
  d.setUint16(32, 2, true)
  d.setUint16(34, 16, true)
  text(36, "data")
  d.setUint32(40, pcm.length, true)
  out.set(pcm, 44)
  return out
}

/** Root mean square of 16-bit little-endian samples. */
export function rms(pcm: Uint8Array): number {
  const n = Math.floor(pcm.length / 2)
  if (!n) return 0
  const d = new DataView(pcm.buffer, pcm.byteOffset, n * 2)
  let sum = 0
  for (let i = 0; i < n; i++) {
    const s = d.getInt16(i * 2, true)
    sum += s * s
  }
  return Math.sqrt(sum / n)
}

export type StopReason = "stopped" | "silence" | "no-speech" | "max" | "cancelled" | "error"

export interface Recording {
  /** 16-bit mono WAV; empty when nothing worth transcribing was heard. */
  wav: Uint8Array
  seconds: number
  reason: StopReason
  /** Why nothing came of it, when nothing did. */
  empty?: string
}

export interface RecorderOptions {
  command: string[]
  silenceSeconds?: number
  maxSeconds?: number
  threshold?: number
  /** Seconds to wait for any speech before giving up (Hermes: 15). */
  maxWait?: number
  /** Called when the recording ends by itself (silence, no speech, the limit, the recorder dying). */
  onAutoStop?: (reason: StopReason) => void
}

/** One recording: start it, read `level` for a meter, stop it (or let silence stop it).
 *  The recorder runs in a process group of its own, so a pipeline (`sh -c "arecord | sox …"`)
 *  is stopped whole, and a stop never waits more than a couple of seconds for it. */
export class Recorder {
  level = 0
  private chunks: Uint8Array[] = []
  private bytes = 0
  private pending = new Uint8Array(0)
  private proc: ChildProcess
  private done: Promise<Recording>
  private resolveDone!: (r: Recording) => void
  private speechRun = 0 // seconds above the threshold, running
  private dipRun = 0
  private speech = false
  private silentFor = 0
  private peak = 0
  private stderr = ""
  private problem?: string
  private ended?: StopReason
  private finished = false
  private exited = false
  private drained = false

  constructor(private o: RecorderOptions) {
    this.done = new Promise((r) => (this.resolveDone = r))
    const [cmd, ...args] = o.command
    this.proc = spawn(cmd!, args, { stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env } })
    live.add(this.group)
    this.proc.stdout!.on("data", (c: Buffer) => this.data(new Uint8Array(c)))
    this.proc.stdout!.on("end", () => ((this.drained = true), this.settle()))
    this.proc.stderr!.on("data", (c: Buffer) => (this.stderr = (this.stderr + c.toString()).slice(-2000)))
    this.proc.on("error", (e) => ((this.stderr += e.message), (this.exited = true), (this.drained = true), this.settle()))
    this.proc.on("exit", () => ((this.exited = true), this.settle()))
  }

  /** Signals go to the whole group. */
  private group = {
    kill: (sig: NodeJS.Signals | number = "SIGTERM") => {
      try {
        if (this.proc.pid) process.kill(-this.proc.pid, sig)
      } catch {}
    },
  }

  get seconds() {
    return this.bytes / 2 / RATE
  }

  private data(chunk: Uint8Array) {
    if (this.finished || this.ended === "error") return
    // A recorder writing a sound file rather than raw samples would be heard as noise: refuse it.
    if (!this.bytes && chunk.length >= 4) {
      const magic = String.fromCharCode(...chunk.subarray(0, 4))
      const kind = magic === ".snd" ? "an AU file" : magic === "RIFF" ? "a WAV file" : magic === "OggS" ? "an Ogg file" : magic === "fLaC" ? "a FLAC file" : ""
      if (kind) {
        this.problem = `it writes ${kind}, not raw 16 kHz mono s16le samples${this.o.command[0] === "pw-record" ? " (pw-record needs --raw)" : ""}`
        this.end("error", true)
        return
      }
    }
    this.chunks.push(chunk)
    this.bytes += chunk.length
    const joined = new Uint8Array(this.pending.length + chunk.length)
    joined.set(this.pending)
    joined.set(chunk, this.pending.length)
    let at = 0
    for (; at + BLOCK * 2 <= joined.length; at += BLOCK * 2) this.block(joined.subarray(at, at + BLOCK * 2))
    this.pending = joined.slice(at)
  }

  /** Hermes' auto-stop: speech counts after 0.3 s above the threshold (dips up to 0.3 s allowed);
   *  after speech, `silenceSeconds` below it ends the recording; no speech in `maxWait` ends it too. */
  private block(b: Uint8Array) {
    const threshold = this.o.threshold ?? 200
    const dt = BLOCK / RATE
    this.level = rms(b)
    this.peak = Math.max(this.peak, this.level)
    if (this.level > threshold) {
      this.speechRun += dt
      this.dipRun = 0
      if (this.speechRun >= 0.3) {
        this.speech = true
        this.silentFor = 0
      }
    } else {
      this.dipRun += dt
      if (this.dipRun > 0.3) this.speechRun = 0
      if (this.speech) this.silentFor += dt
    }
    if (this.speech && this.silentFor >= (this.o.silenceSeconds ?? 3)) this.end("silence", true)
    else if (!this.speech && this.seconds >= (this.o.maxWait ?? 15)) this.end("no-speech", true)
    else if (this.seconds >= (this.o.maxSeconds ?? 120)) this.end("max", true)
  }

  /** Ask the recorder to stop, then make sure: SIGKILL to the group after 1.5 s, and after 2.5 s
   *  stop waiting for its output whatever it does. */
  private end(reason: StopReason, auto: boolean) {
    if (this.ended) return
    this.ended = reason
    this.group.kill("SIGINT")
    setTimeout(() => this.group.kill("SIGKILL"), 1500).unref?.()
    setTimeout(() => ((this.exited = true), (this.drained = true), this.settle()), 2500).unref?.()
    if (auto) this.o.onAutoStop?.(reason)
  }

  /** Stop and get the audio. */
  stop(reason: StopReason = "stopped"): Promise<Recording> {
    this.end(reason, false)
    return this.done
  }

  private settle() {
    if (this.finished || !this.exited || !this.drained) return
    // Ended by itself (a missing device, a crash): say so, or whoever waits never learns.
    if (!this.ended) {
      this.ended = "error"
      this.o.onAutoStop?.("error")
    }
    this.finished = true
    live.delete(this.group)
    this.finish(this.ended)
  }

  private finish(reason: StopReason) {
    const pcm = new Uint8Array(this.bytes)
    let at = 0
    for (const c of this.chunks) {
      pcm.set(c, at)
      at += c.length
    }
    const seconds = this.seconds
    const threshold = this.o.threshold ?? 200
    let empty: string | undefined
    if (reason === "error" || (!this.bytes && reason !== "cancelled")) empty = this.problem ? `the recorder stopped: ${this.problem}` : `the recorder stopped${this.stderr.trim() ? `: ${this.stderr.trim().split("\n").slice(-2).join(" ")}` : " without any audio"}`
    else if (reason === "cancelled") empty = "cancelled"
    else if (reason === "no-speech" || seconds < 0.3 || this.peak < threshold) empty = "no speech heard"
    this.resolveDone({ wav: empty ? new Uint8Array(0) : wav(pcm), seconds, reason: this.bytes || reason === "cancelled" ? reason : "error", empty })
  }
}

/** Play a WAV; `stop()` cuts it off. */
export function play(command: string[], audio: Uint8Array): { done: Promise<void>; stop(): void } {
  const dir = mkdtempSync(join(tmpdir(), "lembas-say-"))
  tempDirs.add(dir)
  const clean = () => {
    tempDirs.delete(dir)
    rmSync(dir, { recursive: true, force: true })
  }
  const file = join(dir, "say.wav")
  let p: ReturnType<typeof Bun.spawn>
  try {
    writeFileSync(file, audio)
    p = Bun.spawn([...command, file], { stdout: "ignore", stderr: "ignore", stdin: "ignore", env: { ...process.env } })
  } catch (e) {
    clean()
    throw e
  }
  live.add(p)
  const done = p.exited.then(() => {
    live.delete(p)
    clean()
  })
  return { done, stop: () => p.kill() }
}
