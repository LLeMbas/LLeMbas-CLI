// The agent loop. Stream a reply; if it called tools, check each call against the permission
// engine (asking the user when needed), run what is allowed, feed the results back, repeat.
// It ends when a reply calls nothing, when stopped, or at the step ceiling — which is a runaway
// backstop, not a budget (LLeMbas generation._run / _wrap_up).
// The text is the harness spec's, so LLeMbas's Continue sends the same words.
import continueText from "../../harness/prompts/tasks/continue.md" with { type: "text" }
import type { Asker, AttachmentInfo, Bus } from "../bus/index.ts"
import type { Effort, Mode } from "../config/schema.ts"
import { evaluate, shadowsDeny, type Context as PermContext, type Rule } from "../permission/evaluate.ts"
import { ProviderError, type Client, type ImagePart, type Message, type ResolvedModel, type ToolCallPart, type Usage } from "../provider/types.ts"
import type { Plan } from "../plan/plan.ts"
import { LOOP } from "../harness.ts"
import { fillPrompt } from "../prompt/fill.ts"
import { splitPurpose, toSpec, ToolError, type Tool, type ToolContext, type ToolResult } from "../tool/tool.ts"
import { fill, promptText } from "../prompt/assemble.ts"
import { resolveCall } from "../tool/names.ts"
import { contextWindow } from "../provider/discover.ts"
import { summaryTurns, type Store } from "./store.ts"
import { estimateTokens, estimateValue } from "../provider/tokens.ts"
import { duration } from "../duration.ts"
import { memoryResults, presentIds, ResultContext } from "./results.ts"

export interface EngineOptions {
  bus: Bus
  asker: Asker
  client: Client
  model: ResolvedModel
  tools: Tool[]
  store?: Store
  sessionId?: string
  /** The system prompt for a step; `plan`: the session's plan, for `{{plan_context}}`. */
  system: (mode: Mode, model: ResolvedModel, plan?: Plan) => string
  mode: Mode
  effort: Effort | null
  perm: Omit<PermContext, "mode">
  toolCtx: Omit<ToolContext, "signal">
  maxSteps?: number
  /** Budgets for one prompt (harness spec loop.json, from LLeMbas): time not counting waiting for
   *  the user, the bytes of tool output read, the tokens written. Unset: no budget. */
  budget?: { wall_seconds?: number; output_bytes?: number; completion_tokens?: number }
  /** Rules added by "always allow (project)" are handed here to persist. */
  persistRule?: (rule: Rule) => void
  compaction?: { autoAt?: number }
  /** Starts a subagent for the task tool; absent in a subagent. */
  spawn?: ToolContext["spawn"]
  /** The model to switch to when this one's server cannot be reached (its `fallback` list), or
   *  undefined when there is none left to try. */
  fallback?: (current: ResolvedModel, tried: Set<string>) => { model: ResolvedModel; client: Client; effort: Effort | null } | undefined
  /** What a message sent mid-turn starts with: the user's words for a session, the main agent's for
   *  a subagent (loop.json jobs.marks to_subagent). */
  steerMark?: string
}

/** What a prompt carries besides its text. */
export interface PromptMeta {
  turnId?: string
  attachments?: AttachmentInfo[]
  /** The harness started this turn — a job's note — not the person. */
  machine?: true
}

const MAX_PARALLEL = LOOP.parallel.max
/** What a message sent mid-turn starts with. Said, not hidden: Hermes found that a model refuses an
 *  unmarked one as an injection. A resumed session shows the message without it. */
/** What /continue (ctrl+g) sends: carry on after being stopped, or after an answer that ended
 *  too soon. */
export const CONTINUE_PROMPT = continueText.replace(/<!--[\s\S]*?-->\n?/g, "").trim()

export const STEER_MARK = "[The user sent this while you were working — take it into account from here:]"
/** The mark on a finished command's note (the spec's text; jobs/note.ts composes the notes). */
export const JOB_MARK = LOOP.jobs.marks.command

/** Neighbouring user messages as one: a message sent mid-turn after the image message, or after a
 *  nudge, would otherwise be two user turns in a row, which strict chat templates (llama.cpp's
 *  Jinja ones) refuse. Anthropic and Gemini merge them anyway. */
export function mergeUsers(messages: Message[]): Message[] {
  const out: Message[] = []
  for (const m of messages) {
    const last = out[out.length - 1]
    if (m.role === "user" && last?.role === "user") out[out.length - 1] = { role: "user", parts: [...last.parts, ...m.parts] }
    else out.push(m)
  }
  return out
}
const NO_ANSWER =
  "Your last reply contained only thinking and no answer, so the user saw nothing. Write your reply to the user now."
const CUT_THINKING =
  "Your last reply hit the output limit while you were still thinking, so nothing was said or done. Think less this time: act now with a tool call, or answer."
const CUT_TEXT = "Your last reply was cut off at the output limit. Carry on from exactly where it stopped."
/** Replies in a row that say nothing (only thinking, or cut off) get asked again this many times. */
const MAX_NUDGES = LOOP.nudges.max
/** The wrap-up: the spec's words, with which limit was reached. */
const wrapUpText = (limit: string) => fillPrompt(LOOP.wrap_up.message, { limit })
/** The session_meta key the plan is kept under. */
export const PLAN_META = "plan"

export class Engine {
  messages: Message[] = []
  mode: Mode
  private _effort: Effort | null
  usage: Usage | undefined
  /** messages.length when `usage` was reported: everything after it is not yet counted. */
  usageAt = 0
  /** The user message that started the running turn, and automatic compactions within it. */
  private turnPrompt: Message | undefined
  private autoCompactions = 0
  model: ResolvedModel
  client: Client
  sessionId: string | undefined
  busy = false
  /** Store row id of the last message pushed (for /undo ranges). */
  lastRowId = 0
  /** Output of `!` commands, sent along with the next prompt. */
  pendingContext: string[] = []
  /** Messages the user sent while a task runs, not yet given to the model. */
  private inbox: string[] = []
  /** Beside the inbox, entry for entry: the id the sender gave a message (the web UI's message id), so where it was taken in can be shown at that point of the reply. */
  private inboxIds: (string | undefined)[] = []
  /** What happened while the task ran that is not the user's word: background jobs that finished,
   *  a subagent's message. Each begins with its mark (jobs/note.ts). Given to the model at the next
   *  step, like a steer; left over at the end, `takeNotes` hands them out to start a turn of their own. */
  private notes: string[] = []
  /** Those given to the model in this turn: kept word for word through a compaction, like the prompt. */
  private turnSteers: string[] = []
  /** busy_input: steer — the inbox goes in at the next step; queue — it waits for the task to end. */
  busyInput: "steer" | "queue" = "steer"
  /** The session's plan (plan_write / plan_update), kept with the session and put into the
   *  prompt on every step while it exists. */
  plan: Plan | undefined
  private sessionRules: Rule[] = []
  private recentCalls: string[] = []
  /** Tools refused with no one able to approve them: no longer offered. */
  private withdrawn = new Set<string>()
  /** This prompt's spending, against `budget`: time waiting for the user, tool output, tokens written. */
  private turnWaitedMs = 0
  private turnOutputBytes = 0
  private turnCompletion = 0
  private abort: AbortController | undefined
  /** The step's "background now" signal (ToolContext.backgroundNow), while its tools run. */
  private bgNow: AbortController | undefined

  /** The session's tool results: their ids, what each insertion says, what recall shows
   *  (session/results.ts, harness context.md). */
  results: ResultContext

  constructor(readonly o: EngineOptions) {
    this.mode = o.mode
    this._effort = o.effort
    this.model = o.model
    this.client = o.client
    this.sessionId = o.sessionId
    this.plan = this.storedPlan()
    this.results = this.resultsFor(o.sessionId)
  }

  /** A session's results: kept with it in the store, or in memory without one. A stub may point
   *  only at a result still in this conversation. */
  private resultsFor(sessionId: string | undefined): ResultContext {
    return new ResultContext(this.o.store && sessionId ? this.o.store.results(sessionId) : memoryResults(), () => presentIds(this.messages))
  }

  /** The plan the store holds for this session, if any. */
  private storedPlan(): Plan | undefined {
    if (!this.o.store || !this.sessionId) return undefined
    const p = this.o.store.meta<Plan | null>(this.sessionId, PLAN_META)
    return p && typeof p === "object" && "version" in p ? p : undefined
  }

  /** Replace the plan (null clears it): kept with the session, and said on the bus so every
   *  front end's card follows. */
  setPlan(plan: Plan | null) {
    this.plan = plan ?? undefined
    if (this.o.store && this.sessionId) this.o.store.setMeta(this.sessionId, PLAN_META, plan)
    this.o.bus.emit({ type: "plan", plan: this.plan })
  }

  get effort(): Effort | null {
    return this._effort
  }
  /** Said on the bus when it changes: the web UI's chat shows the device's model and effort,
   *  whoever changed them. */
  set effort(v: Effort | null) {
    if (v === this._effort) return
    this._effort = v
    this.o.bus.emit({ type: "model", ref: this.model.ref, effort: v ?? "off", connection: this.model.connectionName })
  }

  /** Switch model mid-session. The conversation carries over; the effort resets to the new model's. */
  setModel(model: ResolvedModel, client: Client, effort: Effort | null) {
    const changed = model.ref !== this.model.ref || effort !== this._effort
    this.model = model
    this.client = client
    this._effort = effort
    if (changed) this.o.bus.emit({ type: "model", ref: model.ref, effort: effort ?? "off", connection: model.connectionName })
  }

  /** Start over: a fresh conversation (and session row). Approvals given "for the session" end. */
  newSession(sessionId: string | undefined) {
    this.messages = []
    this.usage = undefined
    this.sessionId = sessionId
    this.sessionRules = []
    this.recentCalls = []
    this.withdrawn.clear()
    this.results = this.resultsFor(sessionId)
    // A new session's plan is whatever the store holds for it: none for a fresh one, the old one
    // on a resume.
    this.plan = this.storedPlan()
    this.o.bus.emit({ type: "plan", plan: this.plan })
    this.o.toolCtx.readFiles.clear()
    this.o.toolCtx.fileStamps.clear()
  }

  /** Continue a stored session. Files must be read again before they are changed. */
  resume(sessionId: string, messages: Message[]) {
    this.newSession(sessionId)
    this.messages = messages
  }

  /** Replace the conversation with a summary of it (/compact). */
  async compact(): Promise<string> {
    if (this.busy) throw new Error("busy")
    if (this.messages.length < 2) throw new Error("nothing to compact yet")
    this.busy = true
    this.abort = new AbortController()
    try {
      return await this.summarise(this.abort.signal)
    } finally {
      this.busy = false
    }
  }

  private async summarise(signal: AbortSignal): Promise<string> {
    const previous = this.messages[0]?.role === "user" && this.messages[0].parts[0]?.type === "text" && this.messages[0].parts[0].text.startsWith("The earlier part of this conversation was compacted")
      ? this.messages[0].parts[0].text
      : ""
    const prompt = fill(promptText("tasks/compact.md"), {
      previous_summary: previous ? `## Summary of even earlier turns\n\n${previous}` : "",
      transcript: transcript(this.messages, 60_000),
    })
    let summary = ""
    for await (const ev of this.client.stream({ system: "", messages: [{ role: "user", parts: [{ type: "text", text: prompt }] }], tools: [], effort: null, signal }))
      if (ev.type === "finish") summary = ev.message.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("").trim()
    if (!summary) throw new Error("the model returned an empty summary")
    // The harness's own table of the reads still in the conversation (context.md §7), after the
    // summary; the conversation is then the summary alone, so no stub can point at a result before it.
    const table = this.results.compactionTable()
    if (table) summary = `${summary}\n\n${table}`
    if (this.o.store && this.sessionId) this.o.store.compaction(this.sessionId, summary)
    this.messages = summaryTurns(summary)
    this.usage = undefined
    this.usageAt = 0
    // Said on the bus: the web UI marks the point in a shared session, as the TUI does.
    this.o.bus.emit({ type: "compacted", summary })
    return summary
  }

  /** Tokens in use now: the last reported usage plus an estimate of what was added since. The
   *  reply's thinking is left out where the dialect never sends it back (openai-chat): it is in the
   *  last reply's output but will not be in the next request. */
  contextUsed(): number | undefined {
    if (!this.usage) return undefined
    return this.usage.input + this.usage.output - this.droppedThinking() + estimateValue(this.messages.slice(this.usageAt))
  }

  private droppedThinking(): number {
    if (!this.usage || this.model.connection.dialect !== "openai-chat") return 0
    const reply = this.messages[this.usageAt - 1]
    if (reply?.role !== "assistant") return 0
    const estimate = reply.parts.reduce((n, p) => n + (p.type === "reasoning" ? estimateTokens(p.text) : 0), 0)
    return Math.min(this.usage.output, this.usage.reasoning ?? estimate)
  }

  /** Before a step: past compaction.auto_at of the window, compact. Old tool results are never
   *  pruned in place (harness context.md: nothing already sent is rewritten — it would throw the
   *  prompt cache away from that point); compaction is the one deliberate break. */
  private async manageContext(signal: AbortSignal) {
    const window = contextWindow(this.model)
    const autoAt = this.o.compaction?.autoAt ?? 0.85
    if (!window || autoAt >= 1) return
    const limit = window * autoAt
    const used = this.contextUsed()
    if (used === undefined || used < limit) return
    // Compacting again and again within one turn loses more each time: the window is simply too
    // small for the task. Say so once and stop, rather than summarising in circles.
    if (this.autoCompactions >= 2) {
      if (this.autoCompactions === 2) {
        this.autoCompactions++
        this.o.bus.emit({ type: "notice", message: `the ${window}-token window is too small for this task even after compacting twice; carrying on without compacting again — a model with a larger window would do better` })
      }
      return
    }
    this.autoCompactions++
    this.o.bus.emit({ type: "notice", message: `context at ${Math.round((used / window) * 100)}% of ${window}: compacting the conversation` })
    try {
      await this.summarise(signal)
      // The task is never left to the summary: the prompt that started this turn comes back word
      // for word (found on a real run, where a small model's summary lost the task entirely).
      const original = this.turnPrompt?.role === "user" ? this.turnPrompt.parts : []
      const steers = this.turnSteers.map((s) => ({ type: "text" as const, text: `(Sent while you were working:) ${s}` }))
      this.push({
        role: "user",
        parts: [
          ...original,
          ...steers,
          { type: "text", text: "(The conversation was compacted to fit the context window; the summary above records what was done so far. This was the request — continue it from where the summary leaves off.)" },
        ],
      })
      this.o.bus.emit({ type: "notice", message: "compacted — carrying on from the summary, with your request kept word for word" })
    } catch (e) {
      this.o.bus.emit({ type: "notice", message: `automatic compaction failed: ${(e as Error).message}` })
    }
  }

  /** Time spent waiting for the user does not count against the wall-clock budget: somebody who
   *  thinks for ten minutes about one command has not spent the agent's time. */
  private async waiting<T>(p: Promise<T>): Promise<T> {
    const t0 = performance.now()
    try {
      return await p
    } finally {
      this.turnWaitedMs += performance.now() - t0
    }
  }

  /** Which budget this prompt has run past — `limit` names it for the wrap-up message, `said` is
   *  for the user's notice — or undefined while there is room. */
  private overBudget(started: number): { limit: string; said: string } | undefined {
    const b = this.o.budget
    if (!b) return undefined
    const spent = (performance.now() - started - this.turnWaitedMs) / 1000
    if (b.wall_seconds && spent > b.wall_seconds) return { limit: "time budget", said: `after ${duration(spent * 1000, true)}` }
    if (b.output_bytes && this.turnOutputBytes > b.output_bytes) return { limit: "tool output budget", said: "with too much tool output to read" }
    if (b.completion_tokens && this.turnCompletion > b.completion_tokens) return { limit: "output budget", said: `after writing about ${this.turnCompletion.toLocaleString("en")} tokens` }
    return undefined
  }

  /** Tools a model can use at all: view_image only with vision, plan_submit only in plan mode
   *  (`requires: "plan"`; plan_write and plan_update are offered in every mode). */
  private offered(name: string): boolean {
    const t = this.o.tools.find((x) => x.name === name)
    if (name === "task" && !this.o.spawn) return false
    if (!t?.requires) return true
    if (t.requires === "vision") return this.model.spec.vision === true
    if (t.requires === "project") return this.o.toolCtx.projectDir !== undefined
    if (t.requires === "display") return this.o.toolCtx.show !== undefined
    if (t.requires === "knowledge") {
      const L = this.o.toolCtx.library
      const have = L?.lib.bases().filter((b) => b.documents > 0).map((b) => b.name) ?? []
      return have.some((b) => !L!.bases || L!.bases.includes(b))
    }
    return this.mode === "plan"
  }

  cancel() {
    this.abort?.abort()
  }

  /** The person wants the foreground command running in this step in the background now (ctrl+b):
   *  bash hands it to the job registry and the call returns. False when no tools run. */
  backgroundNow(): boolean {
    if (!this.bgNow || this.bgNow.signal.aborted) return false
    this.bgNow.abort()
    return true
  }

  /** A message the user sent while a task runs. It goes to the model at the next step (steer), or
   *  is held for the task's end (queue, or a turn that ends first): `takeInbox` gives it back. */
  enqueue(text: string, id?: string) {
    this.inbox.push(text)
    this.inboxIds.push(id)
    this.o.bus.emit({ type: "inbox", texts: [...this.inbox], mode: this.busyInput })
  }

  /** How many messages wait. */
  get queued(): number {
    return this.inbox.length
  }

  /** Take one waiting message out (↑ in the box, to look at or edit it); `putBack` returns it. */
  unqueue(index: number): string | undefined {
    if (index < 0 || index >= this.inbox.length) return undefined
    const [text] = this.inbox.splice(index, 1)
    this.inboxIds.splice(index, 1)
    this.o.bus.emit({ type: "inbox", texts: [...this.inbox], mode: this.busyInput })
    return text
  }

  putBack(index: number, text: string) {
    const at = Math.max(0, Math.min(index, this.inbox.length))
    this.inbox.splice(at, 0, text)
    this.inboxIds.splice(at, 0, undefined)
    this.o.bus.emit({ type: "inbox", texts: [...this.inbox], mode: this.busyInput })
  }

  /** What is still waiting, emptied: the task ended (or was stopped) before it was delivered. */
  takeInbox(): string[] {
    const texts = this.inbox.splice(0)
    this.inboxIds.splice(0)
    if (texts.length) this.o.bus.emit({ type: "inbox", texts: [], mode: this.busyInput })
    return texts
  }

  /** A background job ended while a task runs: it goes to the model at the next step. The text
   *  carries its own mark. */
  note(text: string) {
    this.notes.push(text)
  }

  /** Notes the task ended before delivering. */
  takeNotes(): string[] {
    return this.notes.splice(0)
  }

  /** At a step boundary — every tool result of the last step is in — hand the inbox to the model. */
  private deliverInbox(): boolean {
    const notes = this.notes.splice(0)
    if (notes.length) {
      this.push({ role: "user", parts: [{ type: "text", text: notes.join("\n\n") }] })
      // Said as what happened, not as its mark: the line after it.
      this.o.bus.emit({ type: "notice", message: notes.map((n) => n.split("\n").find((l, i) => i > 0 && l.trim()) ?? n.split("\n")[0]!).join("; ") })
    }
    if (this.busyInput !== "steer" || !this.inbox.length) return notes.length > 0
    const texts = this.inbox.splice(0)
    const ids = this.inboxIds.splice(0).filter((i): i is string => typeof i === "string")
    this.turnSteers.push(...texts)
    this.push({ role: "user", parts: [{ type: "text", text: `${this.o.steerMark ?? STEER_MARK}\n${texts.join("\n\n")}` }] })
    this.o.bus.emit({ type: "steered", texts, ...(ids.length ? { ids } : {}) })
    this.o.bus.emit({ type: "inbox", texts: [], mode: this.busyInput })
    return true
  }

  private push(m: Message) {
    this.messages.push(m)
    if (this.o.store && this.sessionId) this.lastRowId = this.o.store.append(this.sessionId, m)
  }

  /** `extra`: attachments (@files, images) and the like — sent to the model after the text, never shown as typed.
   *  `meta`: the turn's id and what was attached, said on the `prompt` event. */
  async prompt(text: string, extra: (string | ImagePart)[] = [], shown = text, meta: PromptMeta = {}): Promise<"stop" | "steps" | "budget" | "cancelled" | "error"> {
    if (this.busy) throw new Error("busy")
    this.busy = true
    this.o.bus.emit({ type: "prompt", text: shown, ...(meta.turnId ? { turnId: meta.turnId } : {}), ...(meta.attachments?.length ? { attachments: meta.attachments } : {}), ...(meta.machine ? { machine: true as const } : {}) })
    try {
      return await this.run(text, [...this.pendingContext.splice(0), ...extra], meta.turnId, meta.machine)
    } finally {
      this.busy = false
    }
  }

  private async run(text: string, extra: (string | ImagePart)[], turnId?: string, machine?: true): Promise<"stop" | "steps" | "budget" | "cancelled" | "error"> {
    const { bus } = this.o
    this.abort = new AbortController()
    const signal = this.abort.signal
    this.push({ role: "user", parts: [{ type: "text", text }, ...extra.map((t) => (typeof t === "string" ? { type: "text" as const, text: t } : t))], ...(turnId ? { turnId } : {}), ...(machine ? { machine } : {}) })
    this.turnPrompt = this.messages[this.messages.length - 1]
    this.turnSteers = []
    this.autoCompactions = 0
    const toolMap = new Map(this.o.tools.map((t) => [t.name, t]))
    const allSpecs = this.o.tools.map(toSpec)
    const maxSteps = this.o.maxSteps ?? LOOP.steps.default
    const started = performance.now()
    this.turnWaitedMs = 0
    this.turnOutputBytes = 0
    this.turnCompletion = 0
    // Why the prompt is being wound up early, once a budget has run out: then, as past the step
    // limit, the tools are withdrawn and the model answers from what it has.
    let ranOut: { limit: string; said: string } | undefined
    let nudges = 0
    let midRetries = 0
    const tried = new Set<string>()

    for (let step = 1; ; step++) {
      // Checked between steps, never mid-reply: a reply cut off mid-sentence is worth nothing.
      if (!ranOut && step > 1) {
        ranOut = this.overBudget(started)
        if (ranOut) bus.emit({ type: "notice", message: `stopped ${ranOut.said} — the model answers from what it has; send a message to carry on` })
      }
      const wrapUp = step > maxSteps || ranOut !== undefined
      if (!wrapUp) await this.manageContext(signal)
      // After compacting, so what was just sent is never folded into a summary.
      if (!wrapUp) this.deliverInbox()
      bus.emit({ type: "step", n: step })
      let assistant: Extract<Message, { role: "assistant" }> | undefined
      let finish = "stop"
      let usage: Usage | undefined
      // Output speed: from the first piece of the reply to the last.
      let firstOut = 0
      let lastOut = 0
      // What was said before a stop: kept, so /continue picks up from there.
      let partial = ""
      try {
        const stream = this.client.stream({
          system: this.o.system(this.mode, this.model, this.plan),
          messages: mergeUsers(wrapUp ? [...this.messages, { role: "user", parts: [{ type: "text", text: wrapUpText(ranOut ? ranOut.limit : "step limit") }] }] : this.messages),
          tools: wrapUp ? [] : allSpecs.filter((s) => !this.withdrawn.has(s.name) && this.offered(s.name)),
          effort: this.effort,
          signal,
        })
        for await (const ev of stream) {
          if (ev.type === "finish") {
            assistant = ev.message
            finish = ev.reason
          } else if (ev.type === "usage") usage = ev.usage
          else {
            if (ev.type === "text" || ev.type === "reasoning" || ev.type === "tool_call_delta") {
              lastOut = performance.now()
              firstOut ||= lastOut
            }
            if (ev.type === "text") partial += ev.text
            bus.emit(ev)
          }
        }
      } catch (e) {
        if (signal.aborted) {
          // The reply stays on screen; it stays in the history too, so the model knows what it
          // had already said when it is asked to continue.
          if (partial.trim()) this.push({ role: "assistant", parts: [{ type: "text", text: partial }] })
          bus.emit({ type: "done", reason: "cancelled" })
          return "cancelled"
        }
        // The server is not there at all: the model's fallback, if it has one, for the rest of the
        // session — said, and shown in the status bar.
        if (e instanceof ProviderError && e.unreachable && this.o.fallback) {
          tried.add(this.model.ref)
          const next = this.o.fallback(this.model, tried)
          if (next) {
            bus.emit({ type: "notice", message: `${e.message.split("\n")[0]!.slice(0, 160)} — switching to ${next.model.ref}, its fallback` })
            this.setModel(next.model, next.client, next.effort)
            bus.emit({ type: "setting", key: "model", value: next.model.ref })
            step--
            continue
          }
        }
        // A server failure part-way through a reply (llama.cpp failing to parse gpt-oss's own
        // output is the one seen) is worth two more goes. What was already shown is discarded.
        if (e instanceof ProviderError && !e.beforeOutput && (e.status ?? 0) >= 500 && midRetries < 2) {
          midRetries++
          bus.emit({ type: "retract" })
          bus.emit({ type: "notice", message: `the server failed mid-reply (${e.message.split("\n")[0]!.slice(0, 120)}); the partial reply is discarded and the step retried` })
          step--
          continue
        }
        bus.emit({ type: "error", message: (e as Error).message })
        bus.emit({ type: "done", reason: "error" })
        return "error"
      }
      if (!assistant) {
        bus.emit({ type: "error", message: "the stream ended without a reply" })
        bus.emit({ type: "done", reason: "error" })
        return "error"
      }
      this.push(assistant)
      if (usage) {
        this.turnCompletion += usage.output
        // Counted once the reply is in the history, so the reply itself is not estimated again.
        this.usage = usage
        this.usageAt = this.messages.length
        const secs = (lastOut - firstOut) / 1000
        const rate = usage.output > 0 && secs > 0.3 ? usage.output / secs : undefined
        bus.emit({ type: "usage", usage, context: contextWindow(this.model), used: this.contextUsed(), rate })
      }
      const calls = assistant.parts.filter((p): p is ToolCallPart => p.type === "tool_call")
      const said = assistant.parts.some((p) => p.type === "text" && p.text.trim())
      const cut = finish === "length"
      const limit = this.model.spec.max_output ? ` (${this.model.spec.max_output.toLocaleString("en")} tokens)` : ""
      if (calls.length) nudges = 0
      // A thinking model can finish its whole answer inside the reasoning channel, or spend the
      // whole output limit thinking. Ask again — a few times in a row, then stop and say so.
      if (calls.length === 0 && (!said || cut) && !wrapUp) {
        if (nudges < MAX_NUDGES) {
          nudges++
          bus.emit({
            type: "notice",
            message: !cut
              ? "the reply had no answer outside its thinking; asking for one"
              : said
                ? `the reply was cut off at the output limit${limit}; asking it to carry on`
                : `the model used the whole output limit${limit} thinking; asking it to act`,
          })
          this.push({ role: "user", parts: [{ type: "text", text: !cut ? NO_ANSWER : said ? CUT_TEXT : CUT_THINKING }] })
          continue
        }
        bus.emit({
          type: "notice",
          level: "warn",
          message: cut
            ? `stopped: ${MAX_NUDGES + 1} replies in a row ran into the output limit${limit}. Raise max_output for this model, lower the effort, or say what to do next`
            : `stopped: ${MAX_NUDGES + 1} replies in a row had only thinking in them. Say what to do next`,
        })
      }
      if (cut && calls.length)
        bus.emit({ type: "notice", level: "warn", message: `the reply hit the output limit${limit} while writing a tool call; a call cut short is not run, and the model is told to split it` })
      // The model is done, but the user said something meanwhile: it carries on with that, in the
      // same task.
      if (calls.length === 0 && !wrapUp && (this.notes.length || (this.busyInput === "steer" && this.inbox.length))) continue
      if (calls.length === 0 || wrapUp) {
        const reason = wrapUp ? (ranOut ? "budget" : "steps") : "stop"
        bus.emit({ type: "done", reason })
        return reason
      }

      // Decide every call first — asking is sequential — then run what was allowed.
      const results = new Map<string, ToolResult>()
      /** Each call's arguments as its tool got them: a repeated listing or search is compared by them. */
      const argsOf = new Map<string, unknown>()
      const runnable: { call: ToolCallPart; tool: Tool; args: unknown; paths: string[]; writes: boolean; edited?: string }[] = []
      for (const call of calls) {
        if (signal.aborted) break
        const decided = await this.decide(call, toolMap, cut)
        if ("result" in decided) {
          results.set(call.id, decided.result)
          if (decided.denied) bus.emit({ type: "tool_denied", id: call.id, name: call.name, reason: decided.result.output })
        } else {
          runnable.push({ call, ...decided })
          argsOf.set(call.id, decided.args)
        }
      }
      const bgNow = new AbortController()
      this.bgNow = bgNow
      const toolCtx: ToolContext = {
        ...this.o.toolCtx,
        signal,
        backgroundNow: bgNow.signal,
        question: this.o.asker.question ? (req, id) => this.waiting(this.o.asker.question!(req, id)) : undefined,
        plan: {
          get: () => this.plan,
          set: (p) => this.setPlan(p),
          ask: this.o.asker.plan ? (req, id) => this.waiting(this.o.asker.plan!(req, id)) : undefined,
        },
        setMode: (m) => {
          this.mode = m
          bus.emit({ type: "mode", mode: m })
        },
        spawn: this.o.spawn,
      }
      // Consecutive ordinary calls run together (up to MAX_PARALLEL); an exclusive one — it waits
      // on the user — runs on its own, in its place in the order.
      const groups: (typeof runnable)[] = []
      // Two calls on the same file never run together: each reads, changes and writes it whole,
      // so the second would write over the first.
      for (const r of runnable) {
        const last = groups[groups.length - 1]
        const clash = last?.some((o) => o.paths.some((p) => r.paths.includes(p)) && (o.writes || r.writes))
        if (r.tool.exclusive || !last || last[0]!.tool.exclusive || last.length >= MAX_PARALLEL || clash) groups.push([r])
        else last.push(r)
      }
      for (const group of groups) {
        await Promise.all(
          group.map(async ({ call, tool, args, edited }) => {
            bus.emit({ type: "tool_start", id: call.id, name: call.name, args })
            const t0 = performance.now()
            let result: ToolResult
            try {
              result = await tool.run(args, { ...toolCtx, callId: call.id })
            } catch (e) {
              result = { output: e instanceof ToolError ? e.message : `${tool.name} failed: ${(e as Error).message}`, isError: true }
            }
            // Said first, so the model knows the line that ran is not the one it wrote.
            if (edited) result = { ...result, output: `The user changed the command before allowing it. What ran: ${edited}\n\n${result.output}` }
            results.set(call.id, result)
            bus.emit({ type: "tool_end", id: call.id, name: call.name, result, ms: performance.now() - t0 })
          }),
        )
      }
      this.bgNow = undefined
      const images: ImagePart[] = []
      for (const call of calls) {
        const r = results.get(call.id) ?? { output: "Not run: the reply was cancelled.", isError: true }
        this.turnOutputBytes += Buffer.byteLength(r.output)
        this.push({ role: "tool", callId: call.id, name: call.name, content: this.inserted(call.name, argsOf.get(call.id), r), isError: r.isError })
        if (r.images) images.push(...r.images)
      }
      // No dialect takes an image inside a tool result the same way; a user turn right after the
      // results works everywhere.
      if (images.length) this.push({ role: "user", parts: [{ type: "text", text: "The image(s) you asked to view:" }, ...images] })
      if (signal.aborted) {
        bus.emit({ type: "done", reason: "cancelled" })
        return "cancelled"
      }
    }
  }

  /** What a result becomes in the conversation (harness context.md): its id first, a read's lines
   *  and hash, a stub for an unchanged re-read or a repeated listing, an edit's diff, a long output's
   *  head and tail. Decided now, once: nothing already sent is rewritten. */
  private inserted(tool: string, args: unknown, r: ToolResult): string {
    const c = r.context
    if (c?.kind === "read" && !r.isError) return this.results.insert({ ...c, body: r.output })
    if (c && c.kind !== "read" && c.kind !== "output" && !r.isError) return this.results.insert(c)
    return this.results.insert({ kind: "output", tool, args: args ?? {}, text: r.output, ...(r.isError ? { error: true } : {}) })
  }

  private async decide(
    call: ToolCallPart,
    toolMap: Map<string, Tool>,
    cut = false,
  ): Promise<{ tool: Tool; args: unknown; paths: string[]; writes: boolean; edited?: string } | { result: ToolResult; denied?: boolean }> {
    // A former name (harness spec v1 renamed a few) runs the tool it now is.
    let tool = toolMap.get(call.name) ?? toolMap.get(resolveCall(call.name, {}).name)
    if (!tool)
      return { result: { output: `There is no tool named "${call.name}". The tools are: ${[...toolMap.keys()].join(", ")}.`, isError: true } }
    let raw: unknown
    try {
      raw = call.args.trim() ? JSON.parse(call.args) : {}
    } catch {
      if (cut)
        return {
          result: {
            output:
              `Not run: your reply hit the output limit${this.model.spec.max_output ? ` of ${this.model.spec.max_output} tokens` : ""} before these arguments were complete. ` +
              "Do not send the same call again whole. Split large content over several calls — create the file with the first part, then add the rest with edit — and think less before acting.",
            isError: true,
          },
        }
      this.o.bus.emit({ type: "notice", message: `a ${call.name} call's arguments were not valid JSON; it was not run and the model was told` })
      return { result: { output: `The arguments were not valid JSON: ${call.args.slice(0, 200)}`, isError: true } }
    }
    const resolved = resolveCall(call.name, raw)
    tool = toolMap.get(resolved.name) ?? tool
    raw = resolved.raw
    // What the call is for goes to the user when they are asked; the tool never sees an added `purpose`.
    const { args: own, purpose } = splitPurpose(tool, raw)
    const parsed = tool.schema.safeParse(own)
    if (!parsed.success) {
      const why = parsed.error.issues.map((i) => `${i.path.join(".") || "(arguments)"}: ${i.message}`).join("; ")
      return { result: { output: `Invalid arguments for ${tool.name}: ${why}`, isError: true } }
    }
    let args = parsed.data
    const toolCtx: ToolContext = { ...this.o.toolCtx, signal: new AbortController().signal }
    let request = tool.permission(args, toolCtx)
    let edited: string | undefined
    const ctx: PermContext = { ...this.o.perm, mode: this.mode, rules: [...this.o.perm.rules, ...this.sessionRules] }
    let decision = evaluate(request, ctx)

    // Doom-loop guard: the same call three times running is asked about, whatever the mode.
    const key = `${call.name} ${JSON.stringify(args)}`
    this.recentCalls = [...this.recentCalls.slice(-2), key]
    const looping = this.recentCalls.length === 3 && this.recentCalls.every((k) => k === key)
    if (decision.action === "allow" && looping) decision = { ...decision, action: "ask", reason: "the same call three times in a row" }

    if (decision.action === "deny") return { result: { output: `Denied: ${decision.reason}`, isError: true }, denied: true }
    if (decision.action === "ask") {
      // The change itself, so the user sees what they are allowing — not just the file's name.
      let preview: { diff?: string; error?: string } | undefined
      if (tool.preview)
        preview = await tool.preview(args, toolCtx).then(
          (diff) => ({ diff }),
          (e) => ({ error: (e as Error).message }),
        )
      const reply = await this.waiting(this.o.asker.ask({ tool: tool.name, args, request, decision, preview, purpose }))
      if (reply.kind === "deny" && looping)
        return {
          result: {
            output: `Not run: this is the same ${tool.name} call three times in a row, and its result will not change. Use what you already have, or do something different.`,
            isError: true,
          },
          denied: true,
        }
      // Withdrawing a tool is for "this kind of action cannot happen here" — a change or a command.
      // A refused read (a .env, a path outside the project) refuses that call, not reading.
      const withdraw = reply.kind === "deny" && reply.final && (request.class === "write" || request.class === "execute") && !decision.reason.startsWith("outside")
      if (reply.kind === "deny" && withdraw) {
        // Every tool behind the same permission goes: edit and write share "edit".
        const siblings = this.o.tools.filter((t) => t.access === tool.access)
        for (const t of siblings) this.withdrawn.add(t.name)
        const gone = siblings.map((t) => t.name).join(", ")
        return {
          result: {
            output: `Refused: ${reply.feedback ?? "nobody can approve this"} It will be refused every time in this session, so ${gone} ${gone.includes(",") ? "are" : "is"} no longer offered. Do not look for a way around it. Finish with what you can do without it, and say exactly what you would have done — the change, the command — so the user can do it.`,
            isError: true,
          },
          denied: true,
        }
      }
      if (reply.kind === "deny") {
        const output = reply.feedback
          ? `The user declined this, and said why: ${reply.feedback}\nTake that as their instruction and carry on from it.`
          : "The user declined this call. Do not retry it unchanged; adjust, or ask what they want."
        return { result: { output, isError: true }, denied: true }
      }
      // The user corrected the command before allowing it. What they wrote is judged again — the
      // hardline and a written deny hold for it too — and runs as allowed; the model is told.
      if (reply.kind === "once" && reply.command !== undefined && request.command !== undefined && reply.command.trim() && reply.command.trim() !== request.command) {
        const line = reply.command.trim()
        const changed = tool.schema.safeParse({ ...(args as Record<string, unknown>), command: line })
        const again = changed.success ? tool.permission(changed.data, toolCtx) : undefined
        const verdict = again ? evaluate(again, ctx) : undefined
        if (!changed.success || !again || verdict!.action === "deny")
          return { result: { output: `The user changed the command to \`${line}\`, and that is refused: ${verdict?.reason ?? "it is not a valid command"}. Nothing ran.`, isError: true }, denied: true }
        args = changed.data
        request = again
        edited = line
      }
      if (reply.kind === "session" || reply.kind === "project") {
        for (const pattern of decision.always) {
          // Learned: an approval never overrides a deny somebody wrote (see evaluate).
          const rule: Rule = { permission: request.permission, pattern, action: "allow", learned: true }
          this.sessionRules.push(rule)
          // Written to the project, it would come back as an ordinary rule and win over such a
          // deny by coming last; it stays for this session only instead.
          if (reply.kind === "project" && !shadowsDeny(rule, this.o.perm.rules)) this.o.persistRule?.({ permission: rule.permission, pattern, action: "allow" })
        }
      }
    }
    // A command's path is its working directory, not a file it changes.
    return { tool, args, paths: request.command === undefined ? (request.paths ?? []) : [], writes: request.class !== "read", edited }
  }
}


/** The conversation as plain text for the summariser, newest kept when it is too long. */
export function transcript(messages: Message[], maxChars: number): string {
  const lines: string[] = []
  for (const m of messages) {
    if (m.role === "tool") lines.push(`[${m.name} result${m.isError ? ", error" : ""}]\n${m.content.slice(0, 2000)}`)
    else
      for (const p of m.parts) {
        if (p.type === "text") lines.push(`${m.role === "user" ? "User" : "Assistant"}: ${p.text}`)
        else if (p.type === "tool_call") lines.push(`[assistant called ${p.name} ${p.args.slice(0, 400)}]`)
      }
  }
  const all = lines.join("\n\n")
  return all.length <= maxChars ? all : "[…earlier turns cut…]\n\n" + all.slice(-maxChars)
}
