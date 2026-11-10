// Progress (harness spec 3.4.0, harness/progress.md): one fixed set of phases every client shows
// the same way. The object, its text from loop.json `progress.texts` and the one line drawn for it.
import { LOOP } from "../harness.ts"
import { fillPrompt } from "../prompt/fill.ts"
import { duration } from "../duration.ts"

const P = LOOP.progress

export type Phase =
  | "queued"
  | "waiting_for_model"
  | "loading_model"
  | "reading_prompt"
  | "thinking"
  | "writing"
  | "running_tool"
  | "waiting_for_person"
  | "waiting_for_subagents"
  | "compacting"
  | "retrying"
  | "stopped"
  | "failed"

/** The structured progress object: the phase, when it began (Unix ms), and its data. */
export type Progress = { phase: Phase; since: number } & {
  ahead?: number
  model?: string
  reason?: string
  done?: number
  total?: number
  rate?: number
  tool?: string
  what?: string
  running?: number
  in?: number
  attempt?: number
}

export const PHASES = P.phases as readonly Phase[]

const fill = (t: string, v: Record<string, string | number>) => fillPrompt(t, Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x)])))

/** A call's short title as `what`: one line, at most what_max characters. */
export function shortWhat(s: string | undefined): string | undefined {
  if (!s) return undefined
  const line = s.split("\n")[0]!.trim()
  if (!line) return undefined
  return line.length > P.what_max ? `${line.slice(0, P.what_max - 1)}…` : line
}

/** The phase's text (progress.md §2), its fields filled; `now` for retrying's countdown. */
export function progressText(p: Progress, now = Date.now()): string {
  const T = P.texts as Record<string, string>
  switch (p.phase) {
    case "queued":
      return p.ahead !== undefined ? fill(T["queued.ahead"]!, { ahead: p.ahead }) : T.queued!
    case "waiting_for_model":
      return fill(T.waiting_for_model!, { model: p.model ?? "", reason: (P.reason as Record<string, string>)[p.reason ?? ""] ?? p.reason ?? "" })
    case "loading_model":
      return fill(T.loading_model!, { model: p.model ?? "" })
    case "reading_prompt":
      if (p.total === undefined || p.done === undefined || p.total <= 0) return T["reading_prompt.bare"]!
      return fill(T.reading_prompt!, { done: p.done, total: p.total, percent: Math.floor((p.done * 100) / p.total) })
    case "writing":
      return p.rate !== undefined && Number.isFinite(p.rate) ? fill(T.writing!, { rate: p.rate.toFixed(1) }) : T["writing.bare"]!
    case "running_tool":
      return p.what ? fill(T.running_tool!, { tool: p.tool ?? "", what: p.what }) : fill(T["running_tool.bare"]!, { tool: p.tool ?? "" })
    case "waiting_for_person": {
      const W = P.what as Record<string, string>
      const what = p.what === "approval" ? (p.tool ? fill(W.approval!, { tool: p.tool }) : W["approval.bare"]!) : (W[p.what ?? ""] ?? p.what ?? "")
      return fill(T.waiting_for_person!, { what })
    }
    case "waiting_for_subagents":
      return fill(T.waiting_for_subagents!, { running: p.running ?? 0 })
    case "retrying": {
      const left = Math.max(0, (p.in ?? 0) - Math.floor((now - p.since) / 1000))
      return fill(T.retrying!, { in: left, reason: p.reason ?? "" })
    }
    case "stopped":
      return p.reason ? fill(T["stopped.reason"]!, { reason: (P.stopped_reason as Record<string, string>)[p.reason] ?? p.reason }) : T.stopped!
    case "failed":
      return fill(T.failed!, { reason: p.reason ?? "" })
    default:
      return T[p.phase] ?? p.phase
  }
}

/** The line a client draws (progress.md §3): the text and the time since it began, or the text
 *  alone for stopped and failed. */
export function progressLine(p: Progress, now = Date.now()): string {
  const text = progressText(p, now)
  if ((P.no_elapsed as string[]).includes(p.phase)) return text
  return fill(P.line, { text, elapsed: duration(now - p.since, true) })
}

/** Whether two objects are the same phase for the same thing (so `since` is kept). */
export function samePhase(a: Progress | null | undefined, b: Omit<Progress, "since">): boolean {
  if (!a || a.phase !== b.phase) return false
  if (b.phase === "running_tool") return a.tool === b.tool && a.what === b.what
  if (b.phase === "waiting_for_model" || b.phase === "loading_model") return a.model === b.model && a.reason === b.reason
  if (b.phase === "waiting_for_person") return a.what === b.what && a.tool === b.tool
  if (b.phase === "retrying") return a.attempt === b.attempt && a.reason === b.reason
  return true
}

/** What a tool call does, in a line (`what` of running_tool): the command, the path, the query. */
export function callWhat(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined
  const a = args as Record<string, unknown>
  for (const k of ["command", "path", "file_path", "pattern", "query", "url", "description", "name"]) if (typeof a[k] === "string" && a[k]) return shortWhat(a[k] as string)
  return undefined
}

type BusLike = { on(fn: (e: any) => void): () => void; emit(e: any): void }

/** The progress of one engine, derived from the events it emits (progress.md §4), and said on its
 *  bus as `phase` events: a new phase at once, a change of its data at most pace_per_second times a
 *  second. Explicit phases (compacting, waiting for the person or a model, queued) are `set` by
 *  whoever knows them. */
export class ProgressTracker {
  current: Progress | null = null
  private rate: number | undefined
  private running = new Map<string, Omit<Progress, "since">>()
  private lastEmit = 0
  private pendingTimer: ReturnType<typeof setTimeout> | undefined
  private error: string | undefined
  private held: Progress | null = null
  private off: () => void

  constructor(
    private bus: BusLike,
    private now: () => number = Date.now,
  ) {
    this.off = bus.on((e) => this.on(e))
  }

  dispose() {
    this.off()
    if (this.pendingTimer) clearTimeout(this.pendingTimer)
  }

  /** Set the phase (or null). Same phase for the same thing keeps `since`. */
  set(next: Omit<Progress, "since"> | null) {
    if (next === null) {
      if (this.current === null) return
      this.current = null
      return this.emit(true)
    }
    if (samePhase(this.current, next)) {
      const merged = { ...this.current!, ...next, since: this.current!.since } as Progress
      if (JSON.stringify(merged) === JSON.stringify(this.current)) return
      this.current = merged
      return this.emit(false)
    }
    this.current = { ...next, since: this.now() } as Progress
    this.emit(true)
  }

  /** A phase that waits on something outside the turn (the person, a model): set now, and the
   *  phase before it put back by the function returned. */
  hold(next: Omit<Progress, "since">): () => void {
    const before = this.current
    this.held = before
    this.set(next)
    return () => {
      if (this.current && this.current.phase === next.phase) {
        this.current = before ? { ...before } : null
        this.emit(true)
      }
      this.held = null
    }
  }

  private emit(now: boolean) {
    const t = this.now()
    const gap = 1000 / LOOP.progress.pace_per_second
    if (!now && t - this.lastEmit < gap) {
      this.pendingTimer ??= setTimeout(() => {
        this.pendingTimer = undefined
        this.emit(true)
      }, gap - (t - this.lastEmit))
      return
    }
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer)
      this.pendingTimer = undefined
    }
    this.lastEmit = t
    this.bus.emit({ type: "phase", progress: this.current ? { ...this.current } : null })
  }

  private on(e: any) {
    switch (e.type) {
      case "task":
        if (e.state === "start") {
          this.rate = undefined
          this.running.clear()
          this.error = undefined
        }
        return
      case "step":
        this.running.clear()
        return this.set({ phase: "reading_prompt" })
      case "progress":
        return this.set({ phase: "reading_prompt", done: (e.cache ?? 0) + (e.processed ?? 0), total: e.total })
      case "reasoning":
        return this.set({ phase: "thinking" })
      case "text":
      case "tool_call_delta":
        return this.set(this.rate !== undefined ? { phase: "writing", rate: this.rate } : { phase: "writing" })
      case "usage":
        if (!e.child && typeof e.rate === "number" && Number.isFinite(e.rate)) this.rate = e.rate
        return
      case "tool_start": {
        const a = (e.args ?? {}) as Record<string, unknown>
        const p: Omit<Progress, "since"> = e.name === "task" && a.background !== true ? { phase: "waiting_for_subagents", running: 1 } : { phase: "running_tool", tool: e.name, ...(callWhat(e.args) ? { what: callWhat(e.args) } : {}) }
        this.running.set(e.id, p)
        if (this.running.size === 1) this.set(p)
        return
      }
      case "tool_end": {
        this.running.delete(e.id)
        const next = this.running.values().next()
        if (!next.done) this.set(next.value)
        return
      }
      case "notice":
        if (e.retry) this.set({ phase: "retrying", reason: shortWhat(e.retry.reason) ?? "", in: e.retry.in, ...(e.retry.attempt ? { attempt: e.retry.attempt } : {}) })
        return
      case "error":
        this.error = shortWhat(String(e.message ?? "")) ?? "error"
        return
      case "done":
        this.running.clear()
        if (e.reason === "stop") return this.set(null)
        if (e.reason === "error") return this.set({ phase: "failed", reason: this.error ?? "error" })
        return this.set({ phase: "stopped", reason: e.reason === "cancelled" ? "person" : e.reason })
    }
  }
}
