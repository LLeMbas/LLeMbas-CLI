// Background work, one registry per process (harness spec loop.json `jobs`): a job is a command run
// in the background — bash `background: true`, or a foreground command still running when its
// timeout passed — or a subagent run in the background. Every job is owned by a session and every
// lookup is scoped by it, so a subagent's tools see only what it started. A job that ends wakes the
// session that owns it with a marked note (note.ts): the owning front end is attached here and
// decides whether the note goes in mid-turn or starts a turn of its own; a session nobody has open
// keeps the note on its row until it is resumed. Processes die with this one: on exit every group
// gets SIGTERM, then SIGKILL, synchronously — an unref'd timer never fires at exit.
import { spawn, type ChildProcess } from "node:child_process"
import type { Bus } from "../bus/index.ts"
import type { Engine } from "../session/engine.ts"
import type { Store, StoredJob } from "../session/store.ts"
import { LOOP } from "../harness.ts"
import { commandLine, jobNote, shownLine, stripMark } from "./note.ts"

export type JobKind = "command" | "subagent"
export type JobState = "running" | "done" | "stopped" | "error" | "lost"

/** The public shape of a job (harness/acp.md `JobInfo`): what a front end lists and shows. */
export interface JobInfo {
  id: string
  kind: JobKind
  state: JobState
  /** What is shown for it: a command's `description` or its first line; a subagent's description. */
  description: string
  command?: string
  agent?: string
  model?: string
  started: number
  ended?: number
  /** A command's exit code; null when a signal stopped it. */
  exit?: number | null
  /** Characters of output the model has not read. */
  unread: number
  steps?: number
  tools?: number
  /** Set on a job a subagent started: the subagent's own job id. */
  ownerJobId?: string
}

/** How the registry drives a subagent (app.ts spawn builds one): its bus, its engine, and the
 *  three things done to it from outside. */
export interface SubagentHandle {
  bus: Bus
  engine: Engine
  /** A message while it runs: its inbox, delivered at its next step under the to_subagent mark. */
  send(text: string): void
  /** Once finished: start it again with this text as a new prompt, its context intact. */
  restart(text: string): Promise<void>
  /** Stop it where it is; its partial report goes out as its end note. */
  cancel(): void
}

export interface Job {
  id: string
  kind: JobKind
  /** The session that owns it: a subagent's own session for what the subagent started. */
  sessionId: string
  /** The tool call that started it. */
  ownerCallId?: string
  ownerJobId?: string
  description: string
  command?: string
  cwd?: string
  agent?: string
  model?: string
  state: JobState
  started: number
  ended?: number
  exit?: number | null
  /** A command's output, or a subagent's transcript lines: the tail, sliding at MAX_BUFFER. */
  output: string
  /** How much of `output` the model has already been given. */
  read: number
  /** A subagent's own session row (sessions.parent_id). */
  childSessionId?: string
  steps?: number
  tools?: number
  /** A note composed while nobody had the owning session open, kept until it is resumed. */
  note?: string
  /** The process, while a command runs. */
  child?: ChildProcess
  subagent?: SubagentHandle
  /** The last error the subagent's engine reported, for the tail of its report. */
  lastError?: string
  /** No end note: a subagent's own commands stopped because the subagent ended. */
  quiet?: boolean
  /** Set when the note's wake should not happen: a synchronous subagent whose result goes back
   *  as the task call's output. */
  silent?: boolean
}

/** A front end holding a session: where its jobs' events go, and how a note wakes it. The
 *  session id is read when needed — it changes under one app on /new and on a resume. */
export interface Attachment {
  sessionId(): string | undefined
  bus: Bus
  /** Deliver a note: mid-turn to the model's next step, or as a turn of its own (`machine`). */
  wake(text: string, shown: string): void
  store?: Store
  /** Background commands the session may have running at once (limits.jobs). */
  runningMax?(): number
}

export interface StartCommand {
  sessionId: string
  command: string
  cwd: string
  env: Record<string, string | undefined>
  ownerCallId?: string
  ownerJobId?: string
  description?: string
}

export interface AdoptCommand {
  sessionId: string
  command: string
  cwd: string
  child: ChildProcess
  output: string
  read: number
  started: number
  ownerCallId?: string
  ownerJobId?: string
  description?: string
}

export interface SubagentStart {
  sessionId: string
  agent: string
  model: string
  description: string
  handle: SubagentHandle
  ownerCallId?: string
  ownerJobId?: string
  childSessionId?: string
  /** Its result goes back as the task call's output: no note when it ends. */
  silent?: boolean
}

export interface SubagentEnd {
  reason: string
  report: string
  error?: string
  worktree?: string
}

/** Characters of output kept per job; the model only ever reads what is new. */
const MAX_BUFFER = 2_000_000
/** Of that, what a job's row in the store keeps. */
const STORED_TAIL = 64_000
/** `update` events at most this often per job. */
const UPDATE_MS = 250
/** After `exit`, how long the pipes are drained before the job counts as ended: a daemon the
 *  command left behind may hold stdout open for ever. */
const DRAIN_MS = 300

const key = (sessionId: string, id: string) => `${sessionId}\u0000${id}`

export class JobRegistry {
  private jobs = new Map<string, Job>()
  private seq = new Map<string, number>()
  private loaded = new Set<string>()
  private attachments: Attachment[] = []
  private updates = new Map<string, { last: number; timer?: ReturnType<typeof setTimeout> }>()
  readonly limits = { runningMax: LOOP.jobs.running_max.default, finishedKept: LOOP.jobs.finished_kept.default, noteTailChars: LOOP.jobs.note_tail_chars.default }

  constructor(private o: { store?: Store } = {}) {
    process.once("exit", () => this.killAllSync())
  }

  /** A front end takes a session (and the next one it moves to): detach when it closes. */
  attach(a: Attachment): () => void {
    this.attachments.push(a)
    return () => {
      this.attachments = this.attachments.filter((x) => x !== a)
    }
  }

  private attachmentFor(sessionId: string): Attachment | undefined {
    return this.attachments.find((a) => a.sessionId() === sessionId)
  }

  private storeFor(sessionId: string): Store | undefined {
    return this.attachmentFor(sessionId)?.store ?? this.attachments.find((a) => a.store)?.store ?? this.o.store
  }

  /** The store's jobs of a session, read once: one that was running when the process that ran it
   *  died is `lost`, with the last tail it kept. */
  private ensureLoaded(sessionId: string) {
    if (this.loaded.has(sessionId)) return
    this.loaded.add(sessionId)
    const store = this.storeFor(sessionId)
    if (!store) return
    let max = this.seq.get(sessionId) ?? 0
    for (const row of store.jobs(sessionId)) {
      const n = Number(row.id.replace(/^job/, ""))
      if (Number.isFinite(n)) max = Math.max(max, n)
      if (this.jobs.has(key(sessionId, row.id))) continue
      const job = { ...(JSON.parse(row.json) as Omit<Job, "child" | "subagent">), state: row.state as JobState } as Job
      if (job.state === "running") {
        job.state = "lost"
        job.ended = Date.now()
        this.persist(job)
      }
      this.jobs.set(key(sessionId, job.id), job)
    }
    this.seq.set(sessionId, max)
  }

  private persist(job: Job) {
    const store = this.storeFor(job.sessionId)
    if (!store) return
    const { child: _c, subagent: _s, output, read, ...rest } = job
    const cut = Math.max(0, output.length - STORED_TAIL)
    const row: StoredJob = { id: job.id, session_id: job.sessionId, kind: job.kind, state: job.state, started: job.started, ended: job.ended ?? null, json: JSON.stringify({ ...rest, output: output.slice(cut), read: Math.max(0, read - cut) }) }
    try {
      store.saveJob(row)
    } catch {}
  }

  /** The next id of a session: `job1, job2…`, continuing from what the store holds. */
  nextId(sessionId: string): string {
    this.ensureLoaded(sessionId)
    const n = (this.seq.get(sessionId) ?? 0) + 1
    this.seq.set(sessionId, n)
    return `job${n}`
  }

  list(sessionId: string): Job[] {
    this.ensureLoaded(sessionId)
    const all = [...this.jobs.values()].filter((j) => j.sessionId === sessionId)
    // Running first, each group in the order they were started.
    return [...all.filter((j) => j.state === "running"), ...all.filter((j) => j.state !== "running")]
  }

  running(sessionId: string): Job[] {
    return this.list(sessionId).filter((j) => j.state === "running")
  }

  get(sessionId: string, id: string): Job | undefined {
    this.ensureLoaded(sessionId)
    return this.jobs.get(key(sessionId, id))
  }

  info(job: Job): JobInfo {
    return {
      id: job.id,
      kind: job.kind,
      state: job.state,
      description: job.description,
      ...(job.command !== undefined ? { command: job.command } : {}),
      ...(job.agent !== undefined ? { agent: job.agent } : {}),
      ...(job.model !== undefined ? { model: job.model } : {}),
      started: job.started,
      ...(job.ended !== undefined ? { ended: job.ended } : {}),
      ...(job.exit !== undefined ? { exit: job.exit } : {}),
      unread: Math.max(0, job.output.length - job.read),
      ...(job.steps !== undefined ? { steps: job.steps } : {}),
      ...(job.tools !== undefined ? { tools: job.tools } : {}),
      ...(job.ownerJobId !== undefined ? { ownerJobId: job.ownerJobId } : {}),
    }
  }

  /** How many background commands a session may have at once. */
  runningMax(sessionId: string): number {
    return this.attachmentFor(sessionId)?.runningMax?.() ?? this.limits.runningMax
  }

  /** Start a command in the background: its own process group, so stopping it takes the whole
   *  tree down. Refused past the session's cap. */
  start(o: StartCommand): Job {
    const commands = this.running(o.sessionId).filter((j) => j.kind === "command")
    const max = this.runningMax(o.sessionId)
    if (commands.length >= max) throw new Error(`This session already has ${commands.length} background command${commands.length === 1 ? "" : "s"} running (limits.jobs: ${max}). Stop one with job_stop, or wait for one to end.`)
    const child = spawn("bash", ["-c", `exec 2>&1\n${o.command}`], { cwd: o.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], env: o.env })
    return this.adopt({ ...o, child, output: "", read: 0, started: Date.now() })
  }

  /** Take over a command somebody else started — bash's foreground child at its timeout, with what
   *  it had printed — and follow it from here. */
  adopt(o: AdoptCommand): Job {
    const job: Job = {
      id: this.nextId(o.sessionId),
      kind: "command",
      sessionId: o.sessionId,
      ownerCallId: o.ownerCallId,
      ownerJobId: o.ownerJobId,
      description: o.description ?? commandLine(o.command, 80),
      command: o.command,
      cwd: o.cwd,
      state: "running",
      started: o.started,
      output: o.output,
      read: o.read,
      child: o.child,
    }
    this.jobs.set(key(job.sessionId, job.id), job)
    this.follow(job, o.child)
    this.persist(job)
    this.emit(job, "start")
    return job
  }

  private follow(job: Job, child: ChildProcess) {
    child.stdout?.on("data", (d: Buffer) => {
      this.append(job, d.toString())
    })
    let exited = false
    let closed = false
    let ended = false
    const end = () => {
      if (ended) return
      ended = true
      job.exit = child.exitCode ?? (child.signalCode ? null : (job.exit ?? null))
      this.finishCommand(job)
    }
    child.on("close", () => {
      closed = true
      if (exited) end()
    })
    child.on("exit", (code, signal) => {
      exited = true
      job.exit = signal ? null : code
      if (closed) return end()
      // The pipes may still hold output; a grandchild that keeps them open must not keep the job
      // "running" for ever.
      setTimeout(end, DRAIN_MS).unref()
    })
    child.on("error", () => end())
    // Adopted after it had already ended: nothing more will come.
    if (child.exitCode !== null || child.signalCode !== null) {
      job.exit = child.signalCode ? null : child.exitCode
      end()
    }
  }

  /** Output (or a subagent's transcript line) arrived: kept to the tail, the model's read mark
   *  moved with it. */
  append(job: Job, text: string) {
    if (!text) return
    job.output += text
    if (job.output.length > MAX_BUFFER) {
      const cut = job.output.length - MAX_BUFFER
      job.output = job.output.slice(cut)
      job.read = Math.max(0, job.read - cut)
    }
    this.scheduleUpdate(job)
  }

  /** What the model has not read, and that it has now. */
  takeUnread(job: Job): string {
    const fresh = job.output.slice(job.read)
    job.read = job.output.length
    return fresh
  }

  /** Stop a job: a command gets SIGTERM and, two seconds later, SIGKILL; a subagent is cancelled. */
  stop(job: Job) {
    if (job.state !== "running") return
    if (job.kind === "subagent") return void job.subagent?.cancel()
    const pid = job.child?.pid
    if (!pid) return
    try {
      process.kill(-pid, "SIGTERM")
    } catch {}
    setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL")
      } catch {}
    }, 2000).unref()
  }

  /** Every running job of a session: on its deletion, or a subagent's end for its own commands
   *  (`quiet`: those end without a note — nobody is left to read it). */
  stopAll(sessionId: string, quiet = false): number {
    const running = this.running(sessionId)
    for (const j of running) {
      if (quiet) j.quiet = true
      this.stop(j)
    }
    return running.length
  }

  /** On process exit: TERM every command's group, a moment for it to take, then KILL — done
   *  synchronously, since nothing runs after this. */
  killAllSync() {
    const alive = [...this.jobs.values()].filter((j) => j.kind === "command" && j.state === "running" && j.child?.pid)
    if (!alive.length) return
    for (const j of alive)
      try {
        process.kill(-j.child!.pid!, "SIGTERM")
      } catch {}
    Bun.sleepSync(100)
    for (const j of alive)
      try {
        process.kill(-j.child!.pid!, "SIGKILL")
      } catch {}
  }

  private finishCommand(job: Job) {
    if (job.state !== "running") return
    job.ended = Date.now()
    job.state = job.exit === null ? "stopped" : job.exit === 0 ? "done" : "error"
    job.child = undefined
    this.flushUpdate(job)
    const note = job.quiet ? undefined : this.commandNote(job)
    this.persist(job)
    this.forget(job.sessionId)
    this.emit(job, "end")
    if (note) this.deliver(job, note)
  }

  /** The note about a finished command; what it carries counts as read, so job_output does not
   *  repeat it. */
  private commandNote(job: Job): string {
    const unread = this.takeUnread(job)
    const max = this.limits.noteTailChars
    const tail = unread.length > max ? `…${unread.slice(-max)}` : unread
    return jobNote({ kind: "command", id: job.id, command: job.command ?? "", exit: job.exit ?? null, seconds: Math.round(((job.ended ?? Date.now()) - job.started) / 1000), unread: tail }).text
  }

  /** A subagent starts as a job: its bus is followed from here — its text and tool lines become the
   *  job's transcript (job_output), its tool calls are announced under the task line (`sub_tool`),
   *  and its tokens count toward the owner's task. */
  startSubagent(o: SubagentStart): Job {
    const job: Job = {
      id: this.nextId(o.sessionId),
      kind: "subagent",
      sessionId: o.sessionId,
      ownerCallId: o.ownerCallId,
      ownerJobId: o.ownerJobId,
      description: o.description,
      agent: o.agent,
      model: o.model,
      state: "running",
      started: Date.now(),
      output: "",
      read: 0,
      childSessionId: o.childSessionId,
      steps: 0,
      tools: 0,
      subagent: o.handle,
      silent: o.silent,
    }
    this.jobs.set(key(job.sessionId, job.id), job)
    o.handle.bus.on((e) => {
      const owner = this.attachmentFor(job.sessionId)
      switch (e.type) {
        case "prompt":
          this.append(job, `${job.output ? "\n\n" : ""}> ${e.text}\n`)
          break
        case "step":
          job.steps = (job.steps ?? 0) + 1
          this.scheduleUpdate(job)
          break
        case "text":
          this.append(job, e.text)
          break
        case "steered":
          this.append(job, `\n${e.texts.map((t) => `> ${stripMark(t).body}`).join("\n")}\n`)
          break
        case "tool_end":
        case "tool_denied": {
          job.tools = (job.tools ?? 0) + 1
          const title = e.type === "tool_end" ? (e.result.title ?? e.name) : `denied — ${e.reason.split("\n")[0]!.slice(0, 80)}`
          const isError = e.type === "tool_denied" || e.result.isError === true
          this.append(job, `\n[${e.name}] ${title}${isError && e.type === "tool_end" ? " (error)" : ""}\n`)
          if (job.ownerCallId) owner?.bus.emit({ type: "sub_tool", callId: job.ownerCallId, jobId: job.id, name: e.name, title, ...(isError ? { isError } : {}) })
          break
        }
        case "notice":
          this.append(job, `\n(${e.message})\n`)
          break
        case "error":
          job.lastError = e.message
          this.append(job, `\n(error: ${e.message})\n`)
          break
        case "usage":
          owner?.bus.emit({ type: "usage", usage: e.usage, child: true })
          break
      }
    })
    this.persist(job)
    this.emit(job, "start")
    return job
  }

  /** A finished subagent starts again (job_send to it): the same job, running once more. */
  restartSubagent(job: Job) {
    job.state = "running"
    job.started = Date.now()
    job.ended = undefined
    job.exit = undefined
    job.lastError = undefined
    this.persist(job)
    this.emit(job, "start")
  }

  /** The subagent ended: its state from the reason; its own background commands are stopped, and
   *  its end note goes to the owner (unless its result goes back as the task call's output). */
  finishSubagent(job: Job, r: SubagentEnd): { text: string; stopped: number } {
    if (job.state !== "running") return { text: "", stopped: 0 }
    job.ended = Date.now()
    job.state = r.reason === "stop" || r.reason === "steps" || r.reason === "budget" ? "done" : r.reason === "cancelled" ? "stopped" : "error"
    const stopped = job.childSessionId ? this.stopAll(job.childSessionId, true) : 0
    this.flushUpdate(job)
    const error = r.error ?? (r.reason === "error" ? job.lastError : undefined)
    const note = jobNote({
      kind: "subagent",
      id: job.id,
      agent: job.agent ?? "",
      description: job.description,
      report: r.report,
      steps: job.steps ?? 0,
      tools: job.tools ?? 0,
      reason: r.reason === "cancelled" ? "stopped" : r.reason,
      ...(error ? { error } : {}),
      seconds: Math.round((job.ended - job.started) / 1000),
      ...(r.worktree ? { worktree: r.worktree } : {}),
    }).text
    const text = stopped ? `${note}\n${stoppedLine(stopped)}` : note
    this.persist(job)
    this.forget(job.sessionId)
    this.emit(job, "end")
    if (!job.silent) this.deliver(job, text)
    return { text, stopped }
  }

  /** A subagent's `report`: a message to its owner now, before its final reply. */
  message(job: Job, text: string) {
    const note = jobNote({ kind: "message", id: job.id, agent: job.agent ?? "", description: job.description, text }).text
    this.deliver(job, note)
  }

  /** Hand a note to the owning session: the front end holding it decides how it goes in; with
   *  nobody holding it, the note waits on the job's row for a resume. */
  private deliver(job: Job, text: string) {
    const a = this.attachmentFor(job.sessionId)
    if (!a) {
      job.note = text
      this.persist(job)
      return
    }
    a.bus.emit({ type: "job_note", jobId: job.id, text })
    try {
      a.wake(text, shownLine(text))
    } catch {}
  }

  /** Notes kept for a session nobody had open: delivered now that it is. */
  deliverPending(sessionId: string) {
    for (const job of this.list(sessionId)) {
      if (!job.note) continue
      const text = job.note
      job.note = undefined
      this.persist(job)
      this.deliver(job, text)
    }
  }

  /** Finished jobs beyond the cap are forgotten, oldest first. */
  private forget(sessionId: string) {
    const done = this.list(sessionId).filter((j) => j.state !== "running")
    const extra = done.slice(0, Math.max(0, done.length - this.limits.finishedKept))
    const store = this.storeFor(sessionId)
    for (const j of extra) {
      this.jobs.delete(key(sessionId, j.id))
      try {
        store?.deleteJob(sessionId, j.id)
      } catch {}
    }
  }

  private emit(job: Job, state: "start" | "update" | "end") {
    this.attachmentFor(job.sessionId)?.bus.emit({ type: "job", state, job: this.info(job) })
  }

  private scheduleUpdate(job: Job) {
    const k = key(job.sessionId, job.id)
    const u = this.updates.get(k) ?? { last: 0 }
    this.updates.set(k, u)
    if (u.timer) return
    const wait = UPDATE_MS - (Date.now() - u.last)
    if (wait <= 0) {
      u.last = Date.now()
      return this.update(job)
    }
    u.timer = setTimeout(() => {
      u.timer = undefined
      u.last = Date.now()
      if (job.state === "running") this.update(job)
    }, wait)
    u.timer.unref()
  }

  /** News of a running job: said, and its tail kept — so a job the process dies under is found
   *  with what it had printed, not as it was at its start. */
  private update(job: Job) {
    this.persist(job)
    this.emit(job, "update")
  }

  private flushUpdate(job: Job) {
    const u = this.updates.get(key(job.sessionId, job.id))
    if (u?.timer) clearTimeout(u.timer)
    this.updates.delete(key(job.sessionId, job.id))
  }
}

/** The sentence under a subagent's note when its own background commands were stopped with it. */
export function stoppedLine(n: number): string {
  return `Its ${n} background command${n === 1 ? " was" : "s were"} stopped with it.`
}

let shared: JobRegistry | undefined
/** The process's one registry (createApp attaches every front end to it). */
export function jobRegistry(): JobRegistry {
  return (shared ??= new JobRegistry())
}
