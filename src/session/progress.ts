// Progress (harness spec 3.4.0, harness/progress.md): one fixed set of phases every client shows
// the same way. The object, its text from loop.json `progress.texts` and the one line drawn for it.
import { LOOP } from "../harness.ts"
import { fillPrompt } from "../prompt/fill.ts"
import { duration } from "../duration.ts"
import { callTitle, plainNumber, type NumberFormat } from "./display.ts"

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

/** An error or a reason as one line (progress.md §2: "one line"). */
export function oneLine(s: string | undefined): string | undefined {
  const line = s?.trim().split("\n")[0]?.trim()
  return line || undefined
}

/** The phase's text (progress.md §2), its fields filled; `now` for retrying's countdown; `num`
 *  how numbers are written — plain unless the client passes its locale's (display.md §6). */
export function progressText(p: Progress, now = Date.now(), num: NumberFormat = plainNumber): string {
  const T = P.texts as Record<string, string>
  switch (p.phase) {
    case "queued":
      return p.ahead !== undefined ? fill(T["queued.ahead"]!, { ahead: num(p.ahead) }) : T.queued!
    case "waiting_for_model":
      return fill(T.waiting_for_model!, { model: p.model ?? "", reason: (P.reason as Record<string, string>)[p.reason ?? ""] ?? p.reason ?? "" })
    case "loading_model":
      return fill(T.loading_model!, { model: p.model ?? "" })
    case "reading_prompt":
      if (p.total === undefined || p.done === undefined || p.total <= 0) return T["reading_prompt.bare"]!
      return fill(T.reading_prompt!, { done: num(p.done), total: num(p.total), percent: num(Math.floor((p.done * 100) / p.total)) })
    case "writing":
      return p.rate !== undefined && Number.isFinite(p.rate) ? fill(T.writing!, { rate: num(p.rate, 1) }) : T["writing.bare"]!
    case "running_tool":
      return p.what ? fill(T.running_tool!, { tool: p.tool ?? "", what: p.what }) : fill(T["running_tool.bare"]!, { tool: p.tool ?? "" })
    case "waiting_for_person": {
      const W = P.what as Record<string, string>
      const what = p.what === "approval" ? (p.tool ? fill(W.approval!, { tool: p.tool }) : W["approval.bare"]!) : (W[p.what ?? ""] ?? p.what ?? "")
      return fill(T.waiting_for_person!, { what })
    }
    case "waiting_for_subagents":
      return fill(T.waiting_for_subagents!, { running: num(p.running ?? 0) })
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
export function progressLine(p: Progress, now = Date.now(), num: NumberFormat = plainNumber): string {
  const text = progressText(p, now, num)
  if ((P.no_elapsed as string[]).includes(p.phase)) return text
  return fill(P.line, { text, elapsed: duration(now - p.since, true) })
}

/** The line that stays on a reply that did not finish (display.md §4): the text of `stopped` or
 *  `failed`, alone; nothing for a reply that finished, or a phase that is not an end. */
export function endLine(p: Progress | null | undefined, now = Date.now(), num: NumberFormat = plainNumber): string | undefined {
  if (!p || !LOOP.display.end.includes(p.phase)) return undefined
  return progressLine(p, now, num)
}

/** How a turn that did not finish ended, from the engine's `done` reason (and the error said
 *  before it): the progress whose line stays on the reply (display.md §4). */
export function endOf(reason: string, error?: string): Pick<Progress, "phase" | "reason"> | undefined {
  if (reason === "stop") return undefined
  if (reason === "error") return { phase: "failed", reason: oneLine(error) ?? "error" }
  return { phase: "stopped", reason: reason === "cancelled" ? "person" : reason }
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

type BusLike = { on(fn: (e: any) => void): () => void; emit(e: any): void }

/** The progress of one engine, derived from the events it emits (progress.md §4), and said on its
 *  bus as `phase` events: a new phase at once, a change of its data at most pace_per_second times a
 *  second. Explicit phases (compacting, waiting for the person or a model, queued) are `set` by
 *  whoever knows them. */
export class ProgressTracker {
  current: Progress | null = null
  private rate: number | undefined
  private running = new Map<string, Omit<Progress, "since">>()
  private subagents = new Set<string>()
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

  /** waiting_for_subagents with the count as it is now: the foreground task calls of this step,
   *  or every subagent of the session that is running, whichever is more. */
  private counted(p: Omit<Progress, "since">): Omit<Progress, "since"> {
    if (p.phase !== "waiting_for_subagents") return p
    const calls = [...this.running.values()].filter((x) => x.phase === "waiting_for_subagents").length
    return { ...p, running: Math.max(1, calls, this.subagents.size) }
  }

  /** The count changed while the phase holds: the same phase, its data anew (`since` kept). */
  private recount() {
    if (this.current?.phase === "waiting_for_subagents") this.set(this.counted({ phase: "waiting_for_subagents" }))
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
        // One title for a call (display.md §1): the event's, made when the call started.
        const what: string | undefined = e.title ?? callTitle(e.args)
        const p: Omit<Progress, "since"> = e.name === "task" && a.background !== true ? { phase: "waiting_for_subagents", running: 1 } : { phase: "running_tool", tool: e.name, ...(what ? { what } : {}) }
        this.running.set(e.id, p)
        if (this.running.size === 1) this.set(this.counted(p))
        else this.recount()
        return
      }
      case "tool_end": {
        this.running.delete(e.id)
        const next = this.running.values().next()
        if (!next.done) this.set(this.counted(next.value))
        return
      }
      case "job":
        // The subagents working now, for waiting_for_subagents' count: this session's jobs.
        if (e.job?.kind !== "subagent") return
        if (e.state !== "end" && e.job.state === "running") this.subagents.add(e.job.id)
        else this.subagents.delete(e.job.id)
        return this.recount()
      case "notice":
        if (e.retry) this.set({ phase: "retrying", reason: oneLine(e.retry.reason) ?? "", in: e.retry.in, ...(e.retry.attempt ? { attempt: e.retry.attempt } : {}) })
        return
      case "error":
        this.error = oneLine(String(e.message ?? "")) ?? "error"
        return
      case "done":
        this.running.clear()
        if (e.reason === "stop") return this.set(null)
        if (e.reason === "error") return this.set({ phase: "failed", reason: this.error ?? "error" })
        return this.set({ phase: "stopped", reason: e.reason === "cancelled" ? "person" : e.reason })
    }
  }
}
