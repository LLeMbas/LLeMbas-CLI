// The agent loop. Stream a reply; if it called tools, check each call against the permission
// engine (asking the user when needed), run what is allowed, feed the results back, repeat.
// It ends when a reply calls nothing, when stopped, or at the step ceiling — which is a runaway
// backstop, not a budget (LLeMbas generation._run / _wrap_up).
// The text is the harness spec's, so LLeMbas's Continue sends the same words.
import continueText from "../../harness/prompts/tasks/continue.md" with { type: "text" }
import { isAbsolute } from "node:path"
import type { Asker, AttachmentInfo, Bus } from "../bus/index.ts"
import type { Mode } from "../config/schema.ts"
import type { Level } from "../provider/effort.ts"
import { evaluate, shadowsDeny, type Context as PermContext, type PermissionRequest, type Rule } from "../permission/evaluate.ts"
import { ProviderError, type Client, type ImagePart, type Message, type ResolvedModel, type ToolCallPart, type Usage } from "../provider/types.ts"
import type { Plan } from "../plan/plan.ts"
import { LOOP } from "../harness.ts"
import { fillPrompt } from "../prompt/fill.ts"
import { splitPurpose, toSpec, ToolError, type Tool, type ToolContext, type ToolResult } from "../tool/tool.ts"
import { promptText } from "../prompt/assemble.ts"
import { resolveCall } from "../tool/names.ts"
import { contextWindow } from "../provider/index.ts"
import { summaryTurns, type Store } from "./store.ts"
import { estimateTokens, estimateValue } from "../provider/tokens.ts"
import { duration } from "../duration.ts"
import { memoryResults, presentIds, ResultContext } from "./results.ts"
import { render } from "../plan/plan.ts"
import { personTexts } from "../team/subagents.ts"
import { ProgressTracker } from "./progress.ts"
import { callTitle } from "./display.ts"
import type { Verdict } from "../team/delegation.ts"
import { compactAsk, isNote, NO_CHANGING, noteFor, offeredFor, PREFIX_META, summaryOf, today, toldAt, unavailable, type Changing, type Kept, type Now, type Requirement, type Told } from "./prefix.ts"

/** A refused call's arguments and title, for those who draw it: the arguments as the model wrote
 *  them, when they are an object at all. */
function deniedTitle(raw: string): { args?: unknown; title?: string } {
  try {
    const args: unknown = raw.trim() ? JSON.parse(raw) : {}
    const title = callTitle(args)
    return { args, ...(title ? { title } : {}) }
  } catch {
    return {}
  }
}

export interface EngineOptions {
  bus: Bus
  asker: Asker
  client: Client
  model: ResolvedModel
  tools: Tool[]
  store?: Store
  sessionId?: string
  /** The session's system prompt, made from `changing` (what may change during the session, as it
   *  is now); `plan`: the session's plan, for `{{plan_context}}`. Called once per session, after a
   *  compaction and on a model switch — never per request (harness context.md §10). */
  system: (mode: Mode, model: ResolvedModel, plan: Plan | undefined, changing: Changing) => string
  /** What may change during the session, as it is now: compared at every user message, and a
   *  difference said in a note. Absent: nothing (a subagent's prompt holds none of it). */
  changing?: () => Changing
  /** The text a note gives for a permission mode (modes/<mode>.md as the prompt fills it). */
  modeText?: (mode: Mode) => string
  /** Awaited before a prompt is made at a turn's start: the app waits up to loop.json
   *  `context.mcp_wait_ms` for its MCP servers. */
  beforeFirst?: () => Promise<void>
  /** Today's date, as the note says it (tests set it). */
  today?: () => string
  mode: Mode
  /** The effort level (provider/effort.ts): an effort, `off` or `default`. */
  effort: Level
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
  /** What a message sent mid-turn starts with: the user's words for a session, the main agent's for
   *  a subagent (loop.json jobs.marks to_subagent). */
  steerMark?: string
  /** The team this engine's agent is on (spec 3.2.0, team.md): whether it is offered (decided as
   *  the prompt is made, for `model`), what a call answers before its permission check (the team
   *  tools' requirement, task's size, a manager's work), the lead's note lines, and — the lead —
   *  a slot of the model before a turn runs. */
  team?: {
    /** Decide whether the team is offered for a new prompt on `model` — or, for a prompt the
     *  session kept (a resume), take what it decided then (`offered`). */
    fix(model: string, offered?: boolean): boolean
    offered(): boolean
    refuse(tool: Tool, args: unknown): string | undefined
    note?(): string[]
    /** What the lead was told of the team is to be said again: a new prompt, or a rewind. */
    forget?(): void
    beforeTurn?(signal: AbortSignal): Promise<boolean>
    /** Spec 3.4.0 (subagents.md §7), a subagent: who decides its call — itself, the main agent
     *  (through a request), or the person. Replaces the plain evaluation. */
    permit?(request: PermissionRequest, ctx: Omit<PermContext, "mode">): Verdict
    /** Spec 3.4.0 §9, a subagent: its context reached `pause_at` of its window before a step.
     *  "stop": its turn ends now (it is paused; its final turn follows); "go": carry on without
     *  compacting (it is in its final turn). Undefined: not a subagent of the tree. */
    contextFull?(used: number, window: number): "stop" | "go" | undefined
    /** Spec 3.4.0, a subagent: it ended by its own call (team_finish): the turn stops after this step. */
    ended?(): boolean
  }
}

/** What a prompt carries besides its text. */
export interface PromptMeta {
  turnId?: string
  attachments?: AttachmentInfo[]
  /** The harness started this turn — a job's note — not the person. */
  machine?: true
  /** Spec 3.4.0: the steps this turn may take, when fewer than the engine's (a subagent's final turn). */
  maxSteps?: number
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
    // One that starts a turn makes the pair start one (context.md §8).
    if (m.role === "user" && last?.role === "user") out[out.length - 1] = { role: "user", parts: [...last.parts, ...m.parts], ...(last.turn === false && m.turn === false ? { turn: false as const } : {}) }
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
/** How the session's last turn ended when it did not finish (display.md §4): `{ reason, error? }`. */
export const END_META = "ended"

export class Engine {
  messages: Message[] = []
  mode: Mode
  private _effort: Level
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
  /** Tools refused with no one able to approve them, and the refusal: still listed (the tool list
   *  is the session's, harness context.md §10), and every further call answers that refusal. */
  private withdrawn = new Map<string, string>()
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

  /** The prefix (harness context.md §10): the system prompt this session sends, the tools left out
   *  of its list, and what the model has been told — made at the first request, kept with the
   *  session, made again only after a compaction or on a model switch. */
  private kept: Kept | undefined
  /** What was told when the prompt was made: where a rewind (/undo) goes back to, since the notes
   *  after it may be gone from the conversation. */
  private keptBase: Told | undefined
  /** The last request's usage, cached input tokens included, and what it was for. */
  lastRequest: { usage: Usage; kind: "step" | "compaction" } | undefined
  /** The prompt the team's offer was last decided for. */
  private teamFixed: Kept | undefined

  /** Spec 3.4.0 (harness/progress.md): what this agent is doing, said as `phase` events. */
  readonly progress: ProgressTracker

  constructor(readonly o: EngineOptions) {
    this.progress = new ProgressTracker(o.bus)
    // How a turn ended is kept with the session, so a reply that was stopped or failed says so
    // again when the session is shown from the store (display.md §4).
    let failure: string | undefined
    o.bus.on((e) => {
      if (e.type === "error") failure = e.message
      if (e.type !== "done") return
      if (this.o.store && this.sessionId) this.o.store.setMeta(this.sessionId, END_META, e.reason === "stop" ? null : { reason: e.reason, ...(e.reason === "error" && failure ? { error: failure } : {}) })
      failure = undefined
    })
    this.mode = o.mode
    this._effort = o.effort
    this.model = o.model
    this.client = o.client
    this.sessionId = o.sessionId
    this.plan = this.storedPlan()
    this.results = this.resultsFor(o.sessionId)
    this.kept = this.storedPrefix()
  }

  /** The prefix the store holds for this session, if any: a resumed session sends what it kept. */
  private storedPrefix(): Kept | undefined {
    if (!this.o.store || !this.sessionId) return undefined
    const k = this.o.store.meta<Kept | null>(this.sessionId, PREFIX_META)
    if (!k || typeof k !== "object" || typeof k.system !== "string" || !Array.isArray(k.left) || !k.told) return undefined
    this.keptBase = { ...structuredClone(k.told), date: undefined }
    return k
  }

  private saveKept() {
    if (this.o.store && this.sessionId) this.o.store.setMeta(this.sessionId, PREFIX_META, this.kept ?? null)
  }

  /** What could ever be met in this session (§10 rule 4), decided as the prompt is made: plan mode
   *  always can be entered; vision, a project directory, knowledge with documents and a display
   *  are as they are now, for the whole session. */
  private could(): Set<Requirement> {
    const could = new Set<Requirement>(["plan"])
    if (this.model.spec.vision === true) could.add("vision")
    if (this.o.toolCtx.projectDir !== undefined) could.add("project")
    if (this.o.toolCtx.show !== undefined) could.add("display")
    // The team tools' requirement: offered as the prompt is made; whether it is met is the team's
    // to answer at each call (team.md §2: one_agent or one_request).
    if (this.o.team?.offered()) could.add("team")
    const L = this.o.toolCtx.library
    const have = L?.lib.bases().filter((b) => b.documents > 0).map((b) => b.name) ?? []
    if (have.some((b) => !L!.bases || L!.bases.includes(b))) could.add("knowledge")
    return could
  }

  /** What is met now, for a call: the mode for plan, the display as it is; the rest are fixed. */
  private met(): Set<Requirement> {
    const met = this.could()
    if (this.mode !== "plan") met.delete("plan")
    if (this.o.toolCtx.show === undefined) met.delete("display")
    return met
  }

  /** Everything the note compares, as it is now. */
  private now(changing = this.o.changing?.() ?? NO_CHANGING): Now {
    const { source: _source, ...rest } = changing
    return { ...structuredClone(rest), date: (this.o.today ?? today)(), mode: this.mode, plan: this.plan ? render(this.plan) : "" }
  }

  /** The session's prefix, made now if there is none yet (or it was made for another model). */
  prefix(): Kept {
    if (this.kept && this.kept.model === this.model.ref) {
      // A kept prompt (a resumed session) decided whether the team is offered when it was made: its
      // tool list says so (team.md §2: fixed for as long as the prompt is).
      if (this.teamFixed !== this.kept) {
        this.teamFixed = this.kept
        this.o.team?.fix(this.model.ref, !this.kept.left.includes("team_add"))
      }
      return this.kept
    }
    // Whether a team is offered is decided here, with the prompt and the tool list (team.md §2).
    this.o.team?.fix(this.model.ref)
    // After a compaction the size is said again, as the date is: neither is in the prompt. A model
    // switch keeps the conversation, and what it said.
    if (!this.kept) this.o.team?.forget?.()
    const changing = this.o.changing?.() ?? NO_CHANGING
    const now = this.now(changing)
    const could = this.could()
    // Left out for the whole session: what it can never meet, and task where nothing can spawn.
    // Everything else — MCP tools arriving as their servers connect among them — is offered.
    const left = this.o.tools.filter((t) => (t.name === "task" && !this.o.spawn) || !offeredFor(t.requires ? [t.requires] : undefined, could)).map((t) => t.name)
    const told = toldAt(now)
    // A model switch keeps the conversation, and with it the date already said.
    if (this.kept?.told.date) told.date = this.kept.told.date
    this.keptBase = { ...structuredClone(told), date: undefined }
    this.kept = { system: this.o.system(this.mode, this.model, this.plan, changing), left, model: this.model.ref, told }
    this.teamFixed = this.kept
    this.saveKept()
    return this.kept
  }

  /** A system prompt as it would be made now, kept nowhere (what /context and tests look at
   *  before a session has made its own). */
  compose(mode: Mode = this.mode, plan: Plan | undefined = this.plan): string {
    return this.o.system(mode, this.model, plan, this.o.changing?.() ?? NO_CHANGING)
  }

  /** The system prompt this session sends (made now if it has none yet). */
  systemPrompt(): string {
    return this.prefix().system
  }

  /** The tools a request offers: the session's list, the same on every request — the wrap-up's
   *  included, and a tool withdrawn after a final refusal too (it answers that refusal). */
  private toolSpecs() {
    const left = new Set(this.prefix().left)
    return this.o.tools.filter((t) => !left.has(t.name)).map(toSpec)
  }

  /** The note for the next user message (§10 rule 3), "" when nothing changed; what it tells is
   *  the model's from then on. */
  private takeNote(): string {
    const kept = this.prefix()
    const { note, told } = noteFor(kept.told, this.now(), (m) => this.o.modeText?.(m) ?? fillPrompt(promptText(`modes/${m}.md`), { plan_dir: this.o.toolCtx.planDir ?? "" }), this.o.team?.note?.() ?? [])
    if (note) {
      kept.told = told
      this.saveKept()
    }
    return note
  }

  /** Something the model learnt from its own tool's result (a plan it wrote, the mode its
   *  plan_submit set, a memory or file it changed): told, so no note says it again. */
  private learnt(fields: Partial<Told>) {
    if (!this.kept) return
    Object.assign(this.kept.told, structuredClone(fields))
    this.saveKept()
  }

  /** The conversation was cut back (/undo, a rewind): the notes after the cut may be gone, so what
   *  the model knows is the prompt again, and the next user message says the rest. */
  rewound() {
    if (!this.kept || !this.keptBase) return
    this.kept.told = structuredClone(this.keptBase)
    this.o.team?.forget?.()
    this.saveKept()
  }

  /** A request's usage, kept with the session (cached input tokens included, §10 rule 6). */
  private recordUsage(usage: Usage, kind: "step" | "compaction") {
    this.lastRequest = { usage, kind }
    if (this.o.store && this.sessionId)
      try {
        this.o.store.request(this.sessionId, { model: this.model.ref, kind, ...usage })
      } catch {}
  }

  /** A session's results: kept with it in the store, or in memory without one. A stub may point
   *  only at a result still in this conversation. */
  private resultsFor(sessionId: string | undefined): ResultContext {
    return new ResultContext(this.o.store && sessionId ? this.o.store.results(sessionId) : memoryResults(), () => presentIds(this.messages))
  }

  /** How this session's last turn ended, when it did not finish — from the store. */
  storedEnd(): { reason: string; error?: string } | undefined {
    if (!this.o.store || !this.sessionId) return undefined
    const e = this.o.store.meta<{ reason?: unknown; error?: unknown } | null>(this.sessionId, END_META)
    return e && typeof e.reason === "string" ? { reason: e.reason, ...(typeof e.error === "string" ? { error: e.error } : {}) } : undefined
  }

  /** The plan the store holds for this session, if any. */
  private storedPlan(): Plan | undefined {
    if (!this.o.store || !this.sessionId) return undefined
    const p = this.o.store.meta<Plan | null>(this.sessionId, PLAN_META)
    return p && typeof p === "object" && "version" in p ? p : undefined
  }

  /** Replace the plan (null clears it): kept with the session, and said on the bus so every
   *  front end's card follows. `by`: the model's own tool, whose result shows it the plan; a
   *  change by the person reaches the model as a note on the next user message. */
  setPlan(plan: Plan | null, by: "person" | "model" = "person") {
    this.plan = plan ?? undefined
    if (this.o.store && this.sessionId) this.o.store.setMeta(this.sessionId, PLAN_META, plan)
    if (by === "model") this.learnt({ plan: this.plan ? render(this.plan) : "" })
    this.o.bus.emit({ type: "plan", plan: this.plan })
  }

  get effort(): Level {
    return this._effort
  }
  /** Said on the bus when it changes: the web UI's chat shows the device's model and effort,
   *  whoever changed them. */
  set effort(v: Level) {
    if (v === this._effort) return
    this._effort = v
    this.o.bus.emit({ type: "model", ref: this.model.ref, effort: v, connection: this.model.connectionName })
  }

  /** Switch model mid-session. The conversation carries over; the effort resets to the new model's.
   *  The prompt is made again for it at the next request (prefix(): it was made for another). */
  setModel(model: ResolvedModel, client: Client, effort: Level) {
    const changed = model.ref !== this.model.ref || effort !== this._effort
    this.model = model
    this.client = client
    this._effort = effort
    if (changed) this.o.bus.emit({ type: "model", ref: model.ref, effort, connection: model.connectionName })
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
    // on a resume; its prefix likewise.
    this.plan = this.storedPlan()
    this.kept = undefined
    this.keptBase = undefined
    this.lastRequest = undefined
    this.kept = this.storedPrefix()
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

  /** The summary, asked for as the next turn of this same conversation (harness context.md §7):
   *  the same system prompt and tools, every message as it is, then tasks/compact.md with an empty
   *  transcript and previous summary. Nothing of it is shown or stored as a turn; a tool call in the reply is not run. */
  private async summarise(signal: AbortSignal): Promise<string> {
    // No previous summary in the ask: an earlier one is already the conversation's first message.
    const ask: Message = { role: "user", parts: [{ type: "text", text: compactAsk() }] }
    let summary = ""
    for await (const ev of this.client.stream({ system: this.systemPrompt(), messages: mergeUsers([...this.messages, ask]), tools: this.toolSpecs(), effort: this.effort, signal })) {
      if (ev.type === "finish") summary = summaryOf(ev.message.parts)
      else if (ev.type === "usage") this.recordUsage(ev.usage, "compaction")
    }
    if (!summary) throw new Error("the model returned an empty summary")
    // The harness's own table of the reads still in the conversation (context.md §7), after the
    // summary; the conversation is then the summary alone, so no stub can point at a result before it.
    const table = this.results.compactionTable()
    if (table) summary = `${summary}\n\n${table}`
    if (this.o.store && this.sessionId) this.o.store.compaction(this.sessionId, summary)
    this.messages = summaryTurns(summary)
    this.usage = undefined
    this.usageAt = 0
    // Everything is read again now anyway: the prompt is made again at the next request, and the
    // next user message says the date again (what said it is in the summary, if anywhere).
    this.kept = undefined
    this.keptBase = undefined
    this.saveKept()
    // Said on the bus: the web UI marks the point in a shared session, as the TUI does.
    this.o.bus.emit({ type: "compacted", summary })
    return summary
  }

  /** Tokens in use now: the last reported usage plus an estimate of what was added since. A final
   *  reply's thinking is left out: it is in its output, but the next request starts a turn and
   *  sends no earlier turn's reasoning (context.md §8). A reply that called tools keeps it: its turn
   *  goes on, and its reasoning goes back. */
  contextUsed(): number | undefined {
    if (!this.usage) return undefined
    return this.usage.input + this.usage.output - this.droppedThinking() + estimateValue(this.messages.slice(this.usageAt))
  }

  private droppedThinking(): number {
    if (!this.usage) return 0
    const reply = this.messages[this.usageAt - 1]
    if (reply?.role !== "assistant" || reply.parts.some((p) => p.type === "tool_call")) return 0
    const estimate = reply.parts.reduce((n, p) => n + (p.type === "reasoning" ? estimateTokens(p.text) : 0), 0)
    return Math.min(this.usage.output, this.usage.reasoning ?? estimate)
  }

  /** Before a step: past compaction.auto_at of the window, compact. Old tool results are never
   *  pruned in place (harness context.md: nothing already sent is rewritten — it would throw the
   *  prompt cache away from that point); compaction is the one deliberate break. */
  private async manageContext(signal: AbortSignal): Promise<"stop" | void> {
    const window = contextWindow(this.model)
    // Spec 3.4.0 §9: a subagent of the tree does not compact; at pause_at it is paused instead.
    const full = this.o.team?.contextFull
    if (full && window) {
      const used = this.contextUsed()
      if (used !== undefined && used >= window * LOOP.team.context.pause_at) {
        const r = full(used, window)
        if (r === "stop") return "stop"
        if (r === "go") return
      }
      if (full(0, 0) !== undefined) return
    }
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
    this.progress.set({ phase: "compacting" })
    try {
      await this.summarise(signal)
      // The task is never left to the summary: the prompt that started this turn comes back word
      // for word (found on a real run, where a small model's summary lost the task entirely).
      // Its note is not: what it said may be out of date, and the new prompt's first user message
      // gets a note of its own.
      const original = this.turnPrompt?.role === "user" ? this.turnPrompt.parts.filter((p) => p.type !== "text" || !isNote(p.text)) : []
      const steers = this.turnSteers.map((s) => ({ type: "text" as const, text: `(Sent while you were working:) ${s}` }))
      const note = this.takeNote()
      this.push({
        role: "user",
        parts: [
          ...original,
          ...steers,
          { type: "text", text: "(The conversation was compacted to fit the context window; the summary above records what was done so far. This was the request — continue it from where the summary leaves off.)" },
          ...(note ? [{ type: "text" as const, text: note }] : []),
        ],
      })
      this.o.bus.emit({ type: "notice", message: "compacted — carrying on from the summary, with your request kept word for word" })
    } catch (e) {
      this.o.bus.emit({ type: "notice", message: `automatic compaction failed: ${(e as Error).message}` })
    }
  }

  /** Time spent waiting for the user does not count against the wall-clock budget: somebody who
   *  thinks for ten minutes about one command has not spent the agent's time. */
  private async waiting<T>(p: Promise<T>, what: "approval" | "question" | "plan" = "approval", tool?: string): Promise<T> {
    const t0 = performance.now()
    const back = this.progress.hold({ phase: "waiting_for_person", what, ...(tool ? { tool } : {}) })
    try {
      return await p
    } finally {
      back()
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
      this.push({ role: "user", parts: [{ type: "text", text: notes.join("\n\n") }], turn: false })
      // Said as what happened, not as its mark: the line after it.
      this.o.bus.emit({ type: "notice", message: notes.map((n) => n.split("\n").find((l, i) => i > 0 && l.trim()) ?? n.split("\n")[0]!).join("; ") })
    }
    if (this.busyInput !== "steer" || !this.inbox.length) return notes.length > 0
    const texts = this.inbox.splice(0)
    const ids = this.inboxIds.splice(0).filter((i): i is string => typeof i === "string")
    this.turnSteers.push(...texts)
    this.push({ role: "user", parts: [{ type: "text", text: `${this.o.steerMark ?? STEER_MARK}\n${texts.join("\n\n")}` }], turn: false })
    this.o.bus.emit({ type: "steered", texts, ...(ids.length ? { ids } : {}) })
    this.o.bus.emit({ type: "inbox", texts: [], mode: this.busyInput })
    return true
  }

  private push(m: Message) {
    this.messages.push(m)
    if (this.o.store && this.sessionId) this.lastRowId = this.o.store.append(this.sessionId, m)
  }

  /** What the person typed in this session, oldest first (subagents.md §2) — compacted messages
   *  included, as the store keeps them; never a note, a marked message or a machine turn. */
  personSaid(): string[] {
    const all = this.o.store && this.sessionId ? this.o.store.messages(this.sessionId) : this.messages
    return [...this.saidBefore, ...personTexts(all, this.o.steerMark ?? STEER_MARK)]
  }

  /** Spec 3.4.0 (acp.md, *Subagents in an agent chat*): the person's earlier words in a chat this
   *  device has not seen, as the client sent them (`said` on session/new). */
  saidBefore: string[] = []

  /** `extra`: attachments (@files, images) and the like — sent to the model after the text, never shown as typed.
   *  `meta`: the turn's id and what was attached, said on the `prompt` event. */
  async prompt(text: string, extra: (string | ImagePart)[] = [], shown = text, meta: PromptMeta = {}): Promise<"stop" | "steps" | "budget" | "cancelled" | "error"> {
    if (this.busy) throw new Error("busy")
    this.busy = true
    this.o.bus.emit({ type: "prompt", text: shown, ...(meta.turnId ? { turnId: meta.turnId } : {}), ...(meta.attachments?.length ? { attachments: meta.attachments } : {}), ...(meta.machine ? { machine: true as const } : {}) })
    try {
      return await this.run(text, [...this.pendingContext.splice(0), ...extra], meta.turnId, meta.machine, meta.maxSteps)
    } finally {
      this.busy = false
    }
  }

  private async run(text: string, extra: (string | ImagePart)[], turnId?: string, machine?: true, stepCap?: number): Promise<"stop" | "steps" | "budget" | "cancelled" | "error"> {
    const { bus } = this.o
    this.abort = new AbortController()
    const signal = this.abort.signal
    // Before a session's first request: the configured MCP servers get a moment to connect, so
    // their tools are in the first list (§10 rule 4).
    if (!this.kept || this.kept.model !== this.model.ref) await this.o.beforeFirst?.()
    // A team's lead holds a slot of its model while its turn runs (team.md §8): it may wait for one.
    if (this.o.team?.beforeTurn && !(await this.o.team.beforeTurn(signal))) {
      bus.emit({ type: "done", reason: "cancelled" })
      return "cancelled"
    }
    // What changed since the prompt was made goes after the person's words, as a note (§10 rule 3).
    const note = this.takeNote()
    this.push({
      role: "user",
      parts: [{ type: "text", text }, ...extra.map((t) => (typeof t === "string" ? { type: "text" as const, text: t } : t)), ...(note ? [{ type: "text" as const, text: note }] : [])],
      ...(turnId ? { turnId } : {}),
      ...(machine ? { machine } : {}),
    })
    this.turnPrompt = this.messages[this.messages.length - 1]
    this.turnSteers = []
    this.autoCompactions = 0
    const toolMap = new Map(this.o.tools.map((t) => [t.name, t]))
    const maxSteps = Math.min(this.o.maxSteps ?? LOOP.steps.default, stepCap ?? Infinity)
    const started = performance.now()
    this.turnWaitedMs = 0
    this.turnOutputBytes = 0
    this.turnCompletion = 0
    // Why the prompt is being wound up early, once a budget has run out: then, as past the step
    // limit, the tools are withdrawn and the model answers from what it has.
    let ranOut: { limit: string; said: string } | undefined
    let nudges = 0
    let midRetries = 0

    for (let step = 1; ; step++) {
      // Checked between steps, never mid-reply: a reply cut off mid-sentence is worth nothing.
      if (!ranOut && step > 1) {
        ranOut = this.overBudget(started)
        if (ranOut) bus.emit({ type: "notice", message: `stopped ${ranOut.said} — the model answers from what it has; send a message to carry on` })
      }
      const wrapUp = step > maxSteps || ranOut !== undefined
      if (!wrapUp && (await this.manageContext(signal)) === "stop") {
        bus.emit({ type: "done", reason: "stop" })
        return "stop"
      }
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
        // The same system prompt and tool list on every request of the session (§10).
        const stream = this.client.stream({
          system: this.systemPrompt(),
          messages: mergeUsers(wrapUp ? [...this.messages, { role: "user", parts: [{ type: "text", text: wrapUpText(ranOut ? ranOut.limit : "step limit") }], turn: false }] : this.messages),
          // The wrap-up too (loop.json wrap_up): its message says the tools are withdrawn, and a
          // call in its reply is not run.
          tools: this.toolSpecs(),
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
      // The wrap-up's answer is its text before any call: a call there is not run, and none is kept
      // without a result to go with it.
      if (wrapUp && assistant.parts.some((p) => p.type === "tool_call")) {
        const first = assistant.parts.findIndex((p) => p.type === "tool_call")
        assistant = { ...assistant, parts: assistant.parts.slice(0, first) }
        bus.emit({ type: "notice", message: "the wrap-up reply called a tool; it was not run" })
      }
      this.push(assistant)
      if (usage) {
        this.recordUsage(usage, "step")
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
          this.push({ role: "user", parts: [{ type: "text", text: !cut ? NO_ANSWER : said ? CUT_TEXT : CUT_THINKING }], turn: false })
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
          if (decided.denied) bus.emit({ type: "tool_denied", id: call.id, name: call.name, reason: decided.result.output, ...deniedTitle(call.args) })
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
        question: this.o.asker.question ? (req, id) => this.waiting(this.o.asker.question!(req, id), "question") : undefined,
        plan: {
          get: () => this.plan,
          set: (p) => this.setPlan(p, "model"),
          ask: this.o.asker.plan ? (req, id) => this.waiting(this.o.asker.plan!(req, id), "plan") : undefined,
        },
        setMode: (m) => {
          this.mode = m
          // Its own plan_submit's result tells the model the mode.
          this.learnt({ mode: m })
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
            const title = callTitle(args)
            bus.emit({ type: "tool_start", id: call.id, name: call.name, args, ...(title ? { title } : {}) })
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
      // A memory or instruction file changed by this step's tools is the model's own doing, which
      // their results showed it: no note says it again. Changed between turns, it is the person's.
      if (runnable.some((r) => r.writes) && this.o.changing && this.kept) {
        const now = this.now()
        // Files by their path only: the person's own instructions and an instance's (named by a
        // heading) are not something a tool of the model writes.
        const told = this.kept.told.files
        const files = Object.fromEntries([...Object.entries(told).filter(([k]) => !isAbsolute(k)), ...Object.entries(now.files).filter(([k]) => isAbsolute(k))])
        this.learnt({ memory: now.memory, files, ...(runnable.some((r) => r.tool.name === "settings") ? { personality: now.personality } : {}) })
      }
      const images: ImagePart[] = []
      for (const call of calls) {
        const r = results.get(call.id) ?? { output: "Not run: the reply was cancelled.", isError: true }
        this.turnOutputBytes += Buffer.byteLength(r.output)
        this.push({ role: "tool", callId: call.id, name: call.name, content: this.inserted(call.name, argsOf.get(call.id), r), isError: r.isError })
        if (r.images) images.push(...r.images)
      }
      // No dialect takes an image inside a tool result the same way; a user turn right after the
      // results works everywhere.
      if (images.length) this.push({ role: "user", parts: [{ type: "text", text: "The image(s) you asked to view:" }, ...images], turn: false })
      // Spec 3.4.0: a subagent that called team_finish has ended — nothing runs after that call.
      if (this.o.team?.ended?.()) {
        bus.emit({ type: "done", reason: "stop" })
        return "stop"
      }
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
    const team = this.o.team
    // Offered for the whole session; while what it needs is not met, the spec's sentence (§10 rule 4).
    const no = unavailable(tool.name, tool.requires ? [tool.requires] : undefined, this.met())
    if (no) return { result: { output: no, isError: true } }
    // Withdrawn after a final refusal: still listed, and the refusal is the answer.
    const refused = this.withdrawn.get(tool.name)
    if (refused !== undefined) return { result: { output: refused, isError: true }, denied: true }
    // What the call is for goes to the user when they are asked; the tool never sees an added `purpose`.
    const { args: own, purpose } = splitPurpose(tool, raw)
    const parsed = tool.schema.safeParse(own)
    if (!parsed.success) {
      const spoken = tool.invalid?.(own, { ...this.o.toolCtx, signal: new AbortController().signal })
      if (spoken) return { result: { output: spoken, isError: true } }
      const why = parsed.error.issues.map((i) => `${i.path.join(".") || "(arguments)"}: ${i.message}`).join("; ")
      return { result: { output: `Invalid arguments for ${tool.name}: ${why}`, isError: true } }
    }
    let args = parsed.data
    // A team's answers come before the permission check — nothing is asked (team.md §6).
    const byTeam = team?.refuse(tool, args)
    if (byTeam) return { result: { output: byTeam, isError: true } }
    const toolCtx: ToolContext = { ...this.o.toolCtx, signal: new AbortController().signal }
    let request = tool.permission(args, toolCtx)
    let edited: string | undefined
    const ctx: PermContext = { ...this.o.perm, mode: this.mode, rules: [...this.o.perm.rules, ...this.sessionRules] }
    let decision = evaluate(request, ctx)
    // Spec 3.4.0 (subagents.md §7): a subagent of the tree — itself, the main agent, or the person.
    if (team?.permit) {
      const { mode: _m, ...rest } = ctx
      const v = team.permit(request, rest)
      if (v.answer === "refused") return { result: { output: v.text, isError: true }, denied: true }
      decision = { ...v.decision, action: v.answer === "run" ? "allow" : "ask" }
    }

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
      const reply = await this.waiting(this.o.asker.ask({ tool: tool.name, args, request, decision, preview, purpose }), "approval", tool.name)
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
        const gone = siblings.map((t) => t.name).join(", ")
        const output = `Refused: ${reply.feedback ?? "nobody can approve this"} It will be refused every time in this session: every further call to ${gone} answers this same refusal. Do not look for a way around it. Finish with what you can do without it, and say exactly what you would have done — the change, the command — so the user can do it.`
        for (const t of siblings) this.withdrawn.set(t.name, output)
        return { result: { output, isError: true }, denied: true }
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
