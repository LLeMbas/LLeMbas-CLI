// Teams (harness spec 3.2.0, harness/team.md; 3.4.0, harness/subagents.md §5–§13): the main agent
// (`lead`) and its subagents, their room, who receives what, the size the person allows, a
// manager's refusals, the slots of the model they run on — and from 3.4.0 the tree only the main
// agent builds, modes and request options, findings, and a subagent's end.
// This file is the rules alone, without an engine: the conformance area `team` drives it step by
// step, and the app (team/runtime.ts) drives it from real turns — the effects say when an agent's
// turn starts (it was given a slot), when a message reaches an agent that is working, and when an
// agent is stopped.
import { LOOP, TOOL_SPECS } from "../harness.ts"
import { fillPrompt } from "../prompt/fill.ts"
import { DEFAULT_RULES, evaluate, toRules } from "../permission/evaluate.ts"
import { BUILTIN_HARDLINE } from "../permission/hardline.ts"
import { duration } from "../duration.ts"
import type { Mode } from "../config/schema.ts"
import type { ToolClass } from "../permission/evaluate.ts"
import { checkMode, strictest, type Grant } from "./delegation.ts"
import type { Progress } from "../session/progress.ts"

export const TEAM = LOOP.team
const TEXTS = TEAM.texts
const LEAD = TEAM.names.lead
export const TEAM_TOOLS = ["team_add", "team_assign", "team_decide", "team_findings", "team_finish", "team_read", "team_replace", "team_request", "team_send", "team_stop", "team_whoami"] as const
/** Spec 3.4.0 (subagents.md §8): the main agent's alone. */
export const MAIN_ONLY = TEAM.main_only.tools as readonly string[]
/** The main agent's team tools, and a subagent's (with team_request only when it has request options). */
export const LEAD_TOOLS = ["team_add", "team_assign", "team_decide", "team_findings", "team_read", "team_replace", "team_send", "team_stop", "team_whoami"] as const
export const MEMBER_TOOLS = ["team_findings", "team_finish", "team_read", "team_send", "team_whoami"] as const
export function memberTools(a: { request: readonly string[] }): string[] {
  return [...MEMBER_TOOLS, ...(a.request.length ? ["team_request"] : [])].sort()
}
const NAME = new RegExp(TEAM.names.pattern)

export type AgentState = "working" | "waiting" | "finished" | "idle" | "paused" | "done" | "out_of_context" | "stopped"
export type EndState = "done" | "out_of_context" | "stopped"

export interface Finding {
  n: number
  text: string
  time: number
}

export interface Request {
  id: string
  from: string
  tool: string
  pattern: string
  why: string
  open: boolean
}

/** What a model's server can do at once (models/schema.json capacity). */
export interface Capacity {
  parallel?: number
  single_session?: boolean
  group?: string
}

/** How many requests a model serves at once: `parallel`, else 1 for single_session, else no limit. */
export function parallelFrom(c: Capacity | undefined): number {
  if (c && Number.isInteger(c.parallel) && c.parallel! >= 1) return c.parallel!
  return c?.single_session ? 1 : Infinity
}

export interface TeamAgent {
  /** `lead` for the main agent; s1, s2, … for subagents, never reused (spec 3.4.0). */
  id: string
  name: string
  /** Its position (team_add's role). */
  role: string
  /** Its task, as given and as assigned since. */
  task: string
  mode: Mode
  /** Request options (spec 3.4.0 §7). */
  request: ToolClass[]
  /** What the main agent allowed it (team_decide). */
  grants: Grant[]
  findings: Finding[]
  /** Its context use, as its engine last said it. */
  context?: { used: number; window: number }
  /** Its current progress (progress.md). */
  progress?: Progress | null
  /** Who added it; null for the lead. */
  manager: string | null
  /** A sub-manager (team_add's `lead`), or the main agent: subagents may be placed under it. */
  leads: boolean
  /** The team's goal as it was told it (the lead's: the last one it gave). */
  goal: string
  /** The model it runs on (its ref). */
  model: string
  agent: string
  state: AgentState
  /** Messages that reached it while it was not working: its next turn's text. */
  inbox: string[]
  /** Its brief, until its first turn starts. */
  brief?: string
  /** When it began waiting for a slot (the queue's order). */
  waitSince?: number
  /** When its last turn ended. */
  ended?: number
  /** Added in this order (tree order among siblings). */
  seq: number
  /** How it ended, and when (an ended subagent stays in the tree's `ended`). */
  endState?: EndState
  endedAt?: number
  /** The sub-manager it was under before that one ended (team_replace puts it back). */
  movedFrom?: string
}

export interface RoomMessage {
  n: number
  from: string
  /** As addressed: names, or ["all"]. */
  to: string[]
  recipients: string[]
  text: string
  time: number
  report: boolean
  /** Spec 3.4.0: what it is — a message, a report, an assignment, a request, a decision. */
  kind: RoomKind
}

export type RoomKind = "message" | "report" | "assignment" | "request" | "decision"

/** A row of the tree (subagents.md §12). */
export interface TreeAgent {
  id: string
  name: string
  position: string
  parent: string | null
  state: AgentState
  model: string
  mode: Mode
  request: string[]
  manager: boolean
  task?: string
  context?: { used: number; window: number }
  progress: Progress | null
  findings: number
  messages: number
  ended?: number
}

export interface TreeInfo {
  min: number
  max: number
  size: number
  open_slots: number
  agents: TreeAgent[]
  ended: TreeAgent[]
}

export interface TeamEffects {
  /** The agent was given a slot: its turn starts now with `text` (a member's brief, or the messages
   *  that woke it; for the lead, what woke it — "" when the person's own message did). */
  start(name: string, text: string): void
  /** A message to an agent whose turn runs: at its next step boundary. */
  deliver(name: string, text: string): void
  /** It left the team: its turn stops where it is, its background commands with it. */
  stop(name: string): void
  /** Spec 3.4.0: it ended by its own team_finish — its turn stops after that call. */
  end?(name: string): void
  /** Spec 3.4.0: its context is full — its turn stops after this step, and its one final turn
   *  starts with `text`. */
  final?(name: string, text: string): void
}

export interface TeamOptions {
  min?: number
  max?: number
  cap?: number
  /** Subagents are on for the session (config `subagents`). */
  subagents?: boolean
  /** The lead's model (the chat's), and every model's capacity. */
  model: string
  capacity: (model: string) => Capacity
  /** Spec 3.3.0 (subagents.md §4): every model the person may use, by ref — a model off the lead's
   *  one-model server can serve as a subagent where the lead's model cannot. None: only the lead's. */
  models?: () => readonly string[]
  effects?: TeamEffects
  /** A bash command a manager may still run: one the default rules alone allow in manual mode. */
  readingBash?: (command: string) => boolean
  now?: () => number
  /** The lead's state as the team begins: working (its first prompt runs) or idle. */
  leadState?: "working" | "idle"
  /** The main agent's mode (the session's). Default: auto. */
  mode?: Mode
  /** Steps a turn may take: the main agent's and a subagent's (for team_whoami). */
  steps?: { main: number; sub: number }
}

/** The default rules' answer for a command in manual mode, with no rules of the person's. */
export function readingBashByDefault(command: string, root = "/project"): boolean {
  const req = { permission: "bash", class: "execute" as const, patterns: [command], command, paths: [root] }
  return evaluate(req, { mode: "manual", rules: toRules(DEFAULT_RULES, "default"), hardline: BUILTIN_HARDLINE, root, planDir: `${root}/.agent/plans`, projectDir: `${root}/.agent` }).action === "allow"
}

const fill = (text: string, vars: Record<string, string | number>) => fillPrompt(text, Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, String(v)])))

export class Team {
  min: number
  max: number
  readonly cap: number
  subagents: boolean
  /** The model the chat runs on (the lead's). */
  model: string
  private agents = new Map<string, TeamAgent>()
  room: RoomMessage[] = []
  /** `task` subagents running in the team: who started each, and on which model. */
  private tasks: { id: number; by: string; model: string }[] = []
  private seq = 0
  private taskSeq = 0
  /** Whether the team is offered, fixed as the prompt is made (§2). */
  offered = false
  /** The setting as the lead was last told it. */
  private told: { min: number; max: number } | undefined
  /** Members the person stopped, not yet said to the lead. */
  private stoppedByPerson: string[] = []
  private waits = 0
  /** Subagents that ended (stopped, done, out of context), in the order they ended. */
  ended: TeamAgent[] = []
  private idSeq = 0
  private reqSeq = 0
  requests: Request[] = []

  constructor(private o: TeamOptions) {
    this.cap = o.cap ?? TEAM.agents.cap
    this.subagents = o.subagents !== false
    this.model = o.model
    this.min = TEAM.agents.min
    this.max = TEAM.agents.max
    this.setSetting(o.min ?? TEAM.agents.min, o.max ?? TEAM.agents.max)
    this.agents.set(LEAD, { id: LEAD, name: LEAD, role: TEAM.read.lead_role, task: "", mode: o.mode ?? "auto", request: [], grants: [], findings: [], manager: null, leads: true, goal: "", model: o.model, agent: "", state: o.leadState ?? "working", inbox: [], seq: this.seq++ })
    this.fix()
  }

  set effects(e: TeamEffects | undefined) {
    this.o.effects = e
  }

  private now() {
    return (this.o.now ?? Date.now)()
  }

  // ── the setting ──────────────────────────────────────────────────────────────

  /** A stored setting under the cap is read as max = min(max, cap), min = min(min, max). */
  setSetting(min: number, max: number) {
    this.max = Math.max(1, Math.min(Math.floor(max), this.cap))
    this.min = Math.max(1, Math.min(Math.floor(min), this.max))
  }

  /** Where it is set: a value outside 1 ≤ min ≤ max ≤ cap is refused with the bounds. */
  static check(min: number, max: number, cap: number): string | undefined {
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || min > max || max > cap) return `Subagents: 1 ≤ Min ≤ Max ≤ ${cap} (the cap), whole numbers, this agent included; Min ${min}, Max ${max} is outside`
    return undefined
  }

  capacityOf(model: string): Capacity {
    return this.o.capacity(model)
  }

  /** How many requests the lead's model serves at once now. */
  parallelNow(): number {
    return parallelFrom(this.o.capacity(this.model))
  }

  /** Spec 3.3.0 (subagents.md §4): whether a model could serve as a subagent now — the lead's own,
   *  with two slots or more, or another model off its one-model server — and whether it is the own. */
  couldServe(): { any: boolean; own: boolean } {
    const own = this.parallelNow() >= 2
    const group = this.o.capacity(this.model).group
    const other = (this.o.models?.() ?? []).some((r) => r !== this.model && (group === undefined || this.o.capacity(r).group !== group))
    return { any: own || other, own }
  }

  /** §2: offered when subagents are on and a model could serve as a subagent — fixed as the prompt
   *  is made (and made again on a model switch); `offered` is a kept prompt's decision. */
  fix(model = this.model, offered?: boolean): boolean {
    this.model = model
    const lead = this.agents.get(LEAD)
    if (lead) lead.model = model
    this.offered = offered ?? (this.subagents && this.couldServe().any)
    return this.offered
  }

  // ── the tree ─────────────────────────────────────────────────────────────────

  get(name: string): TeamAgent | undefined {
    return this.agents.get(name)
  }

  /** Every agent, in tree order: an agent, then its members in the order added, depth first. */
  tree(): TeamAgent[] {
    const out: TeamAgent[] = []
    const walk = (a: TeamAgent) => {
      out.push(a)
      for (const m of this.membersOf(a.name)) walk(m)
    }
    walk(this.agents.get(LEAD)!)
    return out
  }

  membersOf(name: string): TeamAgent[] {
    return [...this.agents.values()].filter((a) => a.manager === name).sort((a, b) => a.seq - b.seq)
  }

  /** The agent and everything under it, in tree order. */
  subtree(name: string): TeamAgent[] {
    const a = this.agents.get(name)
    if (!a) return []
    return [a, ...this.membersOf(name).flatMap((m) => this.subtree(m.name))]
  }

  hasMembers(): boolean {
    return this.agents.size > 1
  }

  /** §3: the lead, every member, and every running `task` subagent. */
  size(): number {
    return this.agents.size + this.tasks.length
  }

  /** §6: an agent with a member, or the lead from the start when min ≥ 2 and the team is offered. */
  isManager(name: string): boolean {
    if (this.membersOf(name).length) return true
    return name === LEAD && this.offered && this.min >= 2
  }

  // ── what a call answers ──────────────────────────────────────────────────────

  /** §2: the team tools' requirement `team`; the text a call answers while it is not met. */
  unavailable(): string | undefined {
    const could = this.couldServe().any
    if ((this.max >= 2 && could) || this.hasMembers()) return undefined
    return !could ? TEAM.unavailable.one_request : TEAM.unavailable.one_agent
  }

  /** §3: what `task` answers in a team, or undefined when it may run (and then counts). */
  taskRefusal(): string | undefined {
    if (!this.offered) return undefined
    if (this.max === 1 && !this.hasMembers()) return TEAM.unavailable.one_agent
    if (this.size() + 1 > this.max) return fill(TEXTS.full, { max: this.max })
    return undefined
  }

  /** §6: whether a call is work a manager gives away. `risk`: the tool's class where the spec does
   *  not have the tool (an MCP tool: read when it says readOnlyHint, else execute). */
  isWork(tool: string, args: unknown, risk?: string): boolean {
    if ((TEAM.work.kept as string[]).includes(tool)) return false
    const r = TOOL_SPECS[tool]?.risk ?? risk ?? "execute"
    if (r !== "write" && r !== "execute") return false
    if (tool === "bash") {
      const command = (args as { command?: unknown } | undefined)?.command
      return !(typeof command === "string" && (this.o.readingBash ?? readingBashByDefault)(command))
    }
    return true
  }

  /** What a call by `by` answers before it runs — the team tools' requirement, task's size, a
   *  manager's work — or undefined when it goes on to its own checks (permission first). */
  refusal(by: string, tool: string, args: unknown, risk?: string): string | undefined {
    if ((TEAM_TOOLS as readonly string[]).includes(tool)) {
      const no = this.offered ? this.unavailable() : TEAM.unavailable.one_agent
      if (no) return no
      // Spec 3.4.0 (subagents.md §6): only the main agent adds, assigns, replaces, stops, decides.
      if (by !== LEAD && MAIN_ONLY.includes(tool)) return TEXTS.only_main
      return undefined
    }
    if (tool === "task") return by !== LEAD ? TEXTS.only_main : this.taskRefusal()
    if (this.isManager(by) && this.isWork(tool, args, risk)) return TEXTS.manager
    return undefined
  }

  // ── slots ───────────────────────────────────────────────────────────────────

  private busyOn(model: string): number {
    return [...this.agents.values()].filter((a) => a.state === "working" && a.model === model).length + this.tasks.filter((h) => h.model === model).length
  }

  private free(model: string): boolean {
    const group = this.o.capacity(model).group
    if (group !== undefined) {
      for (const a of this.agents.values()) if (a.state === "working" && a.model !== model && this.o.capacity(a.model).group === group) return false
      for (const h of this.tasks) if (h.model !== model && this.o.capacity(h.model).group === group) return false
    }
    return this.busyOn(model) < parallelFrom(this.o.capacity(model))
  }

  private want(a: TeamAgent) {
    if (a.state === "working" || a.state === "waiting") return
    a.state = "waiting"
    a.waitSince = this.waits++
  }

  /** §8: waiting agents start in order — the lead first, then as they began waiting. */
  private fillSlots() {
    const queue = [...this.agents.values()].filter((a) => a.state === "waiting").sort((a, b) => Number(b.name === LEAD) - Number(a.name === LEAD) || a.waitSince! - b.waitSince!)
    for (const a of queue) {
      if (!this.free(a.model)) continue
      a.state = "working"
      a.waitSince = undefined
      const text = a.brief ?? a.inbox.join("\n\n")
      a.brief = undefined
      a.inbox = []
      this.o.effects?.start(a.name, text)
    }
  }

  /** The person's message to the lead: it works, or waits for a slot (§8). True when it works. */
  leadWants(): boolean {
    const lead = this.agents.get(LEAD)!
    this.want(lead)
    this.fillSlots()
    return lead.state === "working"
  }

  /** A `task` subagent started by `by` (it counts and holds a slot until taskDone). */
  taskStart(by: string, model = this.model): number {
    const id = ++this.taskSeq
    this.tasks.push({ id, by, model })
    return id
  }

  taskDone(id: number) {
    this.tasks = this.tasks.filter((h) => h.id !== id)
    this.fillSlots()
  }

  /** The first task subagent `by` started, done (the conformance area's `task_done`). */
  taskDoneBy(by: string) {
    const h = this.tasks.find((x) => x.by === by)
    if (h) this.taskDone(h.id)
  }

  // ── delivery ────────────────────────────────────────────────────────────────

  /** §7: to a working agent at its next step; otherwise it wakes (and may wait for a slot). */
  private deliver(name: string, text: string) {
    const a = this.agents.get(name)
    if (!a) return
    // Spec 3.4.0 §9: a paused subagent is given nothing new; the message stays in the room.
    if (a.state === "paused") return
    this.delivered.push({ name, text })
    if (a.state === "working") return this.o.effects?.deliver(name, text)
    a.inbox.push(text)
    this.want(a)
  }

  /** What was delivered, to whom, since this was last read (for a front end and the conformance). */
  delivered: { name: string; text: string }[] = []

  private post(from: string, to: string[], recipients: string[], text: string, report: boolean, kind: RoomKind = report ? "report" : "message", id = ""): RoomMessage {
    const m: RoomMessage = { n: this.room.length + 1, from, to, recipients, text, time: this.now(), report, kind }
    this.room.push(m)
    const marks = TEAM.marks as Record<string, string>
    const mark = fill(marks[kind]!, { from, to: to.join(", "), id })
    for (const r of recipients) this.deliver(r, `${mark}\n${text}`)
    return m
  }

  // ── the tools ───────────────────────────────────────────────────────────────

  /** team_add's refusals, in the spec's order (§4), or undefined when it would add. */
  wouldRefuse(by: string, a: { name: string; goal?: string; parent?: string; mode?: Mode; request?: string[] }): string | undefined {
    const no = this.offered ? this.unavailable() : TEAM.unavailable.one_agent
    if (no) return no
    if (by !== LEAD) return TEXTS.only_main
    if (a.name === "all") return TEXTS.all_name
    if (!NAME.test(a.name)) return fill(TEXTS.bad_name, { name: a.name })
    if (this.agents.has(a.name) || a.name === TEAM.names.parent) return fill(TEXTS.taken, { name: a.name })
    if (!this.agents.get(LEAD)!.goal && !a.goal?.trim()) return TEXTS.no_goal
    if (this.size() + 1 > this.max) return fill(TEXTS.full, { max: this.max })
    return this.placeRefusal(a.parent, a.mode, a.request)
  }

  /** Spec 3.4.0 (§6, §7): `parent` must be the lead or a sub-manager; the mode no looser than its. */
  private placeRefusal(parent: string | undefined, mode: Mode | undefined, request: string[] | undefined): string | undefined {
    const p = this.agents.get(parent ?? LEAD)
    if (!p) return fill(TEXTS.unknown, { name: parent!, names: this.names() })
    if (!p.leads) return fill(TEXTS.not_manager, { name: p.name })
    const m = checkMode(p.mode, mode, request)
    return "error" in m ? m.error : undefined
  }

  /** team_add (§4). `brief` is what the member's first turn is given. */
  add(by: string, a: { name: string; role: string; task: string; goal?: string; lead?: boolean; agent?: string; model?: string; parent?: string; mode?: Mode; request?: string[] }): { text: string; added?: TeamAgent } {
    const no = this.wouldRefuse(by, a)
    if (no) return { text: no }
    const lead = this.agents.get(LEAD)!
    const goal = a.goal?.trim()
    const parent = this.agents.get(a.parent ?? LEAD)!
    if (goal) lead.goal = goal
    const placed = checkMode(parent.mode, a.mode, a.request) as { mode: Mode; request: ToolClass[] }
    const member: TeamAgent = {
      id: `${TEAM.names.id_prefix}${++this.idSeq}`,
      name: a.name,
      role: a.role.trim().split("\n")[0]!,
      task: a.task,
      mode: placed.mode,
      request: placed.request,
      grants: [],
      findings: [],
      manager: parent.name,
      leads: a.lead === true,
      goal: goal || parent.goal || lead.goal,
      model: a.model ?? lead.model,
      agent: a.agent ?? "general",
      state: "finished",
      inbox: [],
      brief: a.task,
      seq: this.seq++,
    }
    this.agents.set(member.name, member)
    this.want(member)
    this.fillSlots()
    const vars = { name: member.name, role: member.role, size: this.size(), max: this.max, parallel: parallelFrom(this.o.capacity(member.model)) }
    return { text: fill(member.state === "working" ? TEXTS.added : TEXTS.added_waiting, vars), added: member }
  }

  /** team_send (§5). */
  send(by: string, a: { to: string[] | string; message: string }): string {
    const no = this.offered ? this.unavailable() : TEAM.unavailable.one_agent
    if (no) return no
    let list = [...new Set(typeof a.to === "string" ? [a.to] : a.to)]
    // Spec 3.4.0: `parent` is the sender's parent.
    if (list.includes(TEAM.names.parent)) {
      const mgr = this.agents.get(by)?.manager
      if (!mgr) return TEXTS.no_parent
      list = [...new Set(list.map((n) => (n === TEAM.names.parent ? mgr : n)))]
    }
    const all = list.includes("all")
    const others = [...this.agents.keys()].filter((n) => n !== by)
    if (all) {
      if (!others.length) return TEXTS.nobody
      const recipients = this.tree().map((x) => x.name).filter((n) => n !== by)
      this.post(by, ["all"], recipients, a.message, false)
      this.fillSlots()
      return fill(TEXTS.sent, { to: "all" })
    }
    const unknown = list.find((n) => !this.agents.has(n))
    if (unknown !== undefined) return fill(TEXTS.unknown, { name: unknown, names: this.names() })
    if (list.includes(by)) return TEXTS.self
    this.post(by, list, list, a.message, false)
    this.fillSlots()
    return fill(TEXTS.sent, { to: list.join(", ") })
  }

  /** A member's `report`: a message to its manager before its final reply (§4). */
  message(by: string, text: string): string | undefined {
    const a = this.agents.get(by)
    if (!a?.manager) return undefined
    this.post(by, [a.manager], [a.manager], text, false)
    this.fillSlots()
    return fill(TEXTS.sent, { to: a.manager })
  }

  /** Who may see a room message (§5): the lead every one; another agent those whose sender or a
   *  recipient is in its subtree. */
  visible(by: string, m: RoomMessage): boolean {
    if (by === LEAD) return true
    const mine = new Set(this.subtree(by).map((a) => a.name))
    return mine.has(m.from) || m.recipients.some((r) => mine.has(r))
  }

  /** team_read (§5): the messages above `since` the caller may see, at most read_max. */
  readRoom(by: string, since = 0): { messages: RoomMessage[]; more: boolean } {
    const all = this.room.filter((m) => m.n > since && this.visible(by, m))
    return { messages: all.slice(0, TEAM.read_max), more: all.length > TEAM.read_max }
  }

  /** team_read's answer as text (loop.json team.read). */
  read(by: string, since = 0): string {
    const no = this.offered ? this.unavailable() : TEAM.unavailable.one_agent
    if (no) return no
    const R = TEAM.read
    const lines = [fill(R.tree, { size: this.size(), max: this.max })]
    const depth = (a: TeamAgent): number => (a.manager ? 1 + depth(this.agents.get(a.manager)!) : 0)
    for (const a of this.tree())
      lines.push(
        fill(R.agent, {
          indent: "  ".repeat(depth(a)),
          name: a.name,
          id: a.id,
          role: a.role,
          state: R.states[a.state],
          model: a.model,
          mode: a.request.length ? `${a.mode} ${fill(R.request, { kinds: a.request.join(", ") })}` : a.mode,
          context: a.context && a.context.window > 0 ? fill(R.context, { percent: Math.floor((a.context.used * 100) / a.context.window) }) : "—",
          last: a.state === "working" ? R.active : a.ended !== undefined ? `${duration(this.now() - a.ended)} ago` : "—",
        }),
      )
    const open = this.openSlots()
    if (open) lines.push(fill(R.slots, { n: open }))
    if (this.ended.length) {
      lines.push(R.ended)
      for (const a of this.ended) lines.push(fill(R.ended_agent, { name: a.name, id: a.id, role: a.role, state: R.states[a.state], findings: a.findings.length }))
    }
    const { messages, more } = this.readRoom(by, since)
    lines.push("")
    if (!messages.length) lines.push(fill(R.none, { since }))
    else {
      lines.push(fill(R.room, { since }))
      for (const m of messages) {
        const [first, ...rest] = m.text.split("\n")
        const text = [first ?? "", ...rest.map((l) => `  ${l}`)].join("\n")
        lines.push(fill(m.report ? R.report : R.message, { n: m.n, from: m.from, to: m.to.join(", "), text }))
      }
      if (more) lines.push(fill(R.more, { last: messages[messages.length - 1]!.n }))
    }
    return lines.join("\n")
  }

  /** team_stop (§9). */
  stopCmd(by: string, name: string): string {
    const no = this.offered ? this.unavailable() : TEAM.unavailable.one_agent
    if (no) return no
    if (by !== LEAD) return TEXTS.only_main
    if (name === "all") {
      const under = this.membersOf(by)
      if (!under.length) return TEXTS.nobody_to_stop
      const gone = under.flatMap((m) => this.subtree(m.name))
      this.remove(gone)
      return fill(TEXTS.stopped, { names: gone.map((a) => a.name).join(", "), size: this.size(), max: this.max })
    }
    if (!this.agents.has(name)) return fill(TEXTS.unknown, { name, names: this.names() })
    if (name === by || !this.subtree(by).some((a) => a.name === name)) return fill(TEXTS.not_yours, { name })
    const gone = this.subtree(name)
    this.remove(gone)
    return fill(TEXTS.stopped, { names: gone.map((a) => a.name).join(", "), size: this.size(), max: this.max })
  }

  /** The person stopped a member in the UI: it and its subtree leave; the lead is told in a note. */
  personStop(name: string): string[] {
    if (name === LEAD || !this.agents.has(name)) return []
    const gone = this.subtree(name)
    this.remove(gone)
    this.stoppedByPerson.push(...gone.map((a) => a.name))
    return gone.map((a) => a.name)
  }

  private remove(gone: TeamAgent[], end: EndState = "stopped") {
    for (const a of gone) {
      this.agents.delete(a.name)
      a.state = end
      a.endState = end
      a.endedAt = this.now()
      a.inbox = []
      a.brief = undefined
      this.ended.push(a)
      for (const r of this.requests) if (r.from === a.name) r.open = false
      if (end === "done") this.o.effects?.end?.(a.name)
      else if (end === "stopped") this.o.effects?.stop(a.name)
      // Spec 3.4.0: the subagents under one that ended by itself move under its parent until the
      // main agent replaces it (team_replace moves them back under the replacement).
      if (end !== "stopped")
        for (const c of this.agents.values())
          if (c.manager === a.name) {
            c.manager = a.manager ?? LEAD
            c.movedFrom = a.name
          }
    }
    this.fillSlots()
  }

  /** An agent's turn ended (§5): a member's final reply is its report to its manager. `reason`:
   *  stop, steps, budget, or `error — <text>`. */
  finish(name: string, reply = "", reason = "stop") {
    const a = this.agents.get(name)
    if (!a) return
    // Spec 3.4.0 §9: the final turn after its context filled has ended — it is out of context.
    if (a.state === "paused") {
      const gone = fill(TEXTS.gone, { name: a.name, id: a.id })
      const text = reply.trim() ? `${gone}\n\n${reply.trim()}` : gone
      if (a.manager) this.post(name, [a.manager], [a.manager], text, true)
      this.remove([a], "out_of_context")
      return
    }
    if (a.state !== "working") return
    a.state = name === LEAD ? "idle" : "finished"
    a.ended = this.now()
    if (a.manager) {
      let text = reply.trim() || TEXTS.no_report
      if (reason !== "stop") text += `\n\n${fill(TEXTS.ended, { reason })}`
      this.post(name, [a.manager], [a.manager], text, true)
    }
    // Messages it was sent at its last step, too late for it: they wake it again.
    if (a.inbox.length) this.want(a)
    this.fillSlots()
  }

  /** Messages delivered to a working agent that its turn ended before taking in: back to its
   *  inbox, so they wake it. */
  undelivered(name: string, texts: string[]) {
    const a = this.agents.get(name)
    if (!a || !texts.length) return
    a.inbox.push(...texts)
    this.want(a)
    this.fillSlots()
  }

  /** The lead stopped waiting (the person pressed Esc): idle, out of the queue. */
  leadIdle() {
    const lead = this.agents.get(LEAD)!
    if (lead.state === "waiting") lead.state = "idle"
    lead.waitSince = undefined
  }

  /** Nothing of the stopped members is said: the session they were in is gone. */
  forgetStopped() {
    this.stoppedByPerson = []
  }


  // ── spec 3.4.0: the main agent's tree (subagents.md §5–§13) ─────────────────────

  /** A subagent by name (live first, else the latest that ended) or by id. */
  find(nameOrId: string): TeamAgent | undefined {
    return this.agents.get(nameOrId) ?? [...this.agents.values()].find((a) => a.id === nameOrId) ?? [...this.ended].reverse().find((a) => a.name === nameOrId || a.id === nameOrId)
  }

  /** Open slots (§6): min − 1 places for subagents not added yet, while min ≥ 2 and offered. */
  openSlots(): number {
    if (!this.offered || this.min < 2) return 0
    return Math.max(0, this.min - 1 - (this.agents.size - 1))
  }

  /** The main agent's mode changed: stricter reaches down the tree, looser changes nobody (§7). */
  setMainMode(mode: Mode) {
    this.agents.get(LEAD)!.mode = mode
    for (const a of this.tree()) if (a.manager) a.mode = strictest(a.mode, this.agents.get(a.manager)?.mode ?? mode)
  }

  /** Its engine's context use, and its progress, as last said. */
  setContext(name: string, used: number, window: number) {
    const a = this.agents.get(name)
    if (a) a.context = { used, window }
  }

  setProgress(name: string, p: Progress | null) {
    const a = this.agents.get(name)
    if (a) a.progress = p
  }

  /** team_whoami (§8). */
  whoami(by: string): string {
    const a = this.agents.get(by)
    if (!a) return fill(TEXTS.unknown, { name: by, names: this.names() })
    const W = TEAM.whoami.lines
    const steps = by === LEAD ? (this.o.steps?.main ?? LOOP.steps.default) : (this.o.steps?.sub ?? LOOP.jobs.subagent_steps.default)
    const lines = [fill(W.who, { name: a.name, id: a.id, role: a.role })]
    if (a.manager) lines.push(fill(W.parent, { parent: a.manager }))
    if (a.manager) lines.push(fill(W.task, { task: a.task.split("\n")[0]! }))
    lines.push(fill(W.mode, { mode: a.mode }))
    if (a.request.length) lines.push(fill(W.request, { kinds: a.request.join(", ") }))
    lines.push(fill(W.model, { model: a.model }))
    lines.push(fill(W.limits, { size: this.size(), max: this.max, steps, spawn: by === LEAD ? W.spawn_yes : W.spawn_no }))
    if (a.context && a.context.window > 0) lines.push(fill(W.context, { used: a.context.used, window: a.context.window, percent: Math.floor((a.context.used * 100) / a.context.window) }))
    return lines.join("\n")
  }

  /** team_findings write (§8). */
  noteFinding(by: string, text: string): string {
    const a = this.agents.get(by)
    if (!a) return fill(TEXTS.unknown, { name: by, names: this.names() })
    const n = a.findings.length + 1
    a.findings.push({ n, text: text.trim(), time: this.now() })
    return fill(TEXTS.noted, { n })
  }

  /** Whether `by` may read `target`'s findings: its own, one in its subtree, or the lead anyone's. */
  private mayRead(by: string, target: TeamAgent): boolean {
    if (by === LEAD || target.name === by) return true
    let up: string | null | undefined = target.endState ? (target.movedFrom ?? target.manager) : target.manager
    for (let guard = 0; up && guard < 1000; guard++) {
      if (up === by) return true
      up = this.agents.get(up)?.manager ?? this.find(up)?.manager
    }
    return false
  }

  /** team_findings read (§8). */
  readFindings(by: string, of?: string): string {
    const target = of ? this.find(of) : this.agents.get(by)
    if (!target) return fill(TEXTS.unknown, { name: of ?? by, names: this.names() })
    if (!this.mayRead(by, target)) return TEXTS.not_yours_findings
    const lines = [fill(TEAM.findings.header, { name: target.name, id: target.id })]
    if (!target.findings.length) lines.push(TEXTS.no_findings)
    for (const f of target.findings) lines.push(fill(TEAM.findings.item, { n: f.n, text: f.text }))
    return lines.join("\n")
  }

  /** team_finish (§8): the report to its parent, and it ends (done). */
  finishTask(by: string, report: string): string {
    const a = this.agents.get(by)
    if (!a || !a.manager) return TEXTS.no_parent
    this.post(by, [a.manager], [a.manager], report.trim() || TEXTS.no_report, true)
    const to = a.manager
    this.remove([a], "done")
    return fill(TEXTS.finished, { to })
  }

  /** Its context is full (§9): paused, and given one final turn. The text of that turn. */
  pause(name: string): string | undefined {
    const a = this.agents.get(name)
    if (!a || a.name === LEAD || a.state === "paused") return undefined
    a.state = "paused"
    a.inbox = []
    const text = `${fill(TEAM.marks.context_full, { to: name })}\n${fill(TEXTS.context_full, { steps: TEAM.context.final_steps })}`
    this.delivered.push({ name, text })
    this.o.effects?.final?.(name, text)
    return text
  }

  /** team_assign (§8). */
  assign(by: string, a: { name: string; task: string; role?: string; parent?: string; mode?: Mode }): string {
    const no = this.offered ? this.unavailable() : TEAM.unavailable.one_agent
    if (no) return no
    if (by !== LEAD) return TEXTS.only_main
    const t = this.agents.get(a.name)
    if (!t || t.name === LEAD) return this.find(a.name)?.endState ? fill(TEXTS.has_ended, { name: a.name }) : fill(TEXTS.unknown, { name: a.name, names: this.names() })
    const parentName = a.parent ?? t.manager!
    const p = this.agents.get(parentName)
    if (!p) return fill(TEXTS.unknown, { name: parentName, names: this.names() })
    if (!p.leads) return fill(TEXTS.not_manager, { name: p.name })
    if (this.subtree(t.name).some((x) => x.name === p.name)) return fill(TEXTS.cycle, { name: t.name, parent: p.name })
    let mode = strictest(t.mode, p.mode)
    let request = t.request
    if (a.mode) {
      const m = checkMode(p.mode, a.mode, t.request.length && a.mode !== p.mode ? t.request : undefined)
      if ("error" in m) return m.error
      mode = m.mode
      request = m.mode === p.mode ? [] : t.request
    }
    t.task = a.task
    if (a.role?.trim()) t.role = a.role.trim().split("\n")[0]!
    t.manager = p.name
    t.movedFrom = undefined
    t.mode = mode
    t.request = request
    for (const c of this.subtree(t.name).slice(1)) c.mode = strictest(c.mode, this.agents.get(c.manager!)!.mode)
    this.post(LEAD, [t.name], [t.name], a.task, false, "assignment")
    this.fillSlots()
    return fill(TEXTS.assigned, { name: t.name })
  }

  /** team_replace (§8): the same name, position, parent, mode and model; a new id; briefed with
   *  the task and the old one's findings. */
  replace(by: string, a: { name: string; task?: string }): { text: string; added?: TeamAgent } {
    const no = this.offered ? this.unavailable() : TEAM.unavailable.one_agent
    if (no) return { text: no }
    if (by !== LEAD) return { text: TEXTS.only_main }
    const old = this.agents.get(a.name) ?? [...this.ended].reverse().find((x) => x.name === a.name)
    if (!old || old.name === LEAD) return { text: fill(TEXTS.unknown, { name: a.name, names: this.names() }) }
    const live = this.agents.get(a.name) === old
    if (!live && this.size() + 1 > this.max) return { text: fill(TEXTS.full, { max: this.max }) }
    if (live) {
      // It alone ends: the subagents under it move to the replacement.
      for (const c of this.membersOf(old.name)) c.movedFrom = old.name
      for (const c of this.membersOf(old.name)) c.manager = old.manager ?? LEAD
      this.remove([old], "stopped")
    }
    const manager = old.movedFrom ?? old.manager
    const parent = manager && this.agents.get(manager) ? manager : LEAD
    const findings = old.findings.length ? old.findings.map((f) => fill(TEAM.findings.item, { n: f.n, text: f.text })).join("\n") : TEXTS.no_findings
    const brief = fill(TEXTS.replace_brief, { task: a.task?.trim() || old.task, name: old.name, id: old.id, findings })
    const p = this.agents.get(parent)!
    const fresh: TeamAgent = {
      ...old,
      id: `${TEAM.names.id_prefix}${++this.idSeq}`,
      task: a.task?.trim() || old.task,
      mode: strictest(old.mode, p.mode),
      grants: [],
      findings: [],
      context: undefined,
      progress: undefined,
      manager: parent,
      state: "finished",
      inbox: [],
      brief,
      seq: this.seq++,
      endState: undefined,
      endedAt: undefined,
      movedFrom: undefined,
      ended: undefined,
      waitSince: undefined,
    }
    this.agents.set(fresh.name, fresh)
    for (const c of this.agents.values())
      if (c.movedFrom === old.name) {
        c.manager = fresh.name
        c.movedFrom = undefined
      }
    this.want(fresh)
    this.fillSlots()
    return { text: fill(TEXTS.replaced, { name: fresh.name, id: fresh.id, size: this.size(), max: this.max }), added: fresh }
  }

  /** team_request (§7): `cls` is the tool's risk class. */
  request(by: string, a: { tool: string; pattern: string; why: string }, cls: ToolClass | undefined): string {
    const t = this.agents.get(by)
    if (!t || !t.manager) return TEXTS.no_parent
    if (!cls || !t.request.includes(cls)) return fill(TEXTS.not_requestable, { tool: a.tool, kinds: t.request.join(", ") || "none" })
    const id = `${TEAM.request.id_prefix}${++this.reqSeq}`
    this.requests.push({ id, from: by, tool: a.tool, pattern: a.pattern, why: a.why, open: true })
    this.post(by, [LEAD], [LEAD], fill(TEXTS.request_body, { tool: a.tool, pattern: a.pattern, why: a.why }), false, "request", id)
    this.fillSlots()
    return fill(TEXTS.requested, { id })
  }

  /** team_decide (§7): a grant for the subagent when allowed; it is told either way. `permission`:
   *  the tool's permission key. */
  decide(by: string, a: { id: string; allow: boolean; note?: string }, permission?: (tool: string) => string | undefined): string {
    if (by !== LEAD) return TEXTS.only_main
    const r = this.requests.find((x) => x.id === a.id && x.open)
    const t = r && this.agents.get(r.from)
    if (!r || !t) return fill(TEXTS.no_request, { id: a.id })
    r.open = false
    if (a.allow) t.grants.push({ tool: r.tool, permission: permission?.(r.tool) ?? r.tool, pattern: r.pattern })
    const head = fill(a.allow ? TEXTS.decision_allowed : TEXTS.decision_refused, { tool: r.tool, pattern: r.pattern })
    this.post(LEAD, [t.name], [t.name], a.note?.trim() ? `${head}\n\n${a.note.trim()}` : head, false, "decision", r.id)
    this.fillSlots()
    return fill(TEXTS.decided, { decision: a.allow ? TEXTS.allowed : TEXTS.refused, id: r.id, name: t.name })
  }

  /** The tree as clients show it (§12). */
  info(): TreeInfo {
    const row = (a: TeamAgent): TreeAgent => ({
      id: a.id,
      name: a.name,
      position: a.role,
      parent: a.manager,
      state: a.state,
      model: a.model,
      mode: a.mode,
      request: [...a.request],
      manager: a.name === LEAD ? true : a.leads,
      ...(a.manager ? { task: a.task } : {}),
      ...(a.context ? { context: { ...a.context } } : {}),
      progress: a.progress ?? null,
      findings: a.findings.length,
      messages: this.room.filter((m) => m.from === a.name || m.recipients.includes(a.name)).length,
      ...(a.endedAt !== undefined ? { ended: a.endedAt } : {}),
    })
    return { min: this.min, max: this.max, size: this.size(), open_slots: this.openSlots(), agents: this.tree().map(row), ended: this.ended.map(row) }
  }

  // ── what the lead is told ───────────────────────────────────────────────────

  /** §10: the note's entries for the lead's next user message — the size when it was not said yet
   *  or changed (one block), and the members the person stopped (a block of its own). */
  noteLines(): string[] {
    if (!this.offered) return []
    const N = LOOP.context.note
    const out: string[] = []
    if (!this.told || this.told.min !== this.min || this.told.max !== this.max) {
      this.told = { min: this.min, max: this.max }
      if (this.max === 1) out.push(N.team_one)
      else out.push([fill(N.team, { min: this.min, max: this.max }), ...(this.min >= 2 ? [fill(N.team_lead, { members: this.min - 1 })] : []), ...(this.couldServe().own ? [] : [N.team_own])].join("\n"))
    }
    if (this.stoppedByPerson.length) out.push(fill(N.team_stopped, { names: this.stoppedByPerson.splice(0).join(", ") }))
    return out
  }

  /** A note said once already is said again after a rewind or a new prompt (compaction). */
  forgetTold() {
    this.told = undefined
  }

  /** The team, in tree order: name, manager, state. */
  state(): { name: string; manager: string | null; state: AgentState }[] {
    return this.tree().map((a) => ({ name: a.name, manager: a.manager, state: a.state }))
  }

  private names(): string {
    return this.tree()
      .map((a) => a.name)
      .join(", ")
  }

  /** Members working or waiting now (for a status line). */
  active(): number {
    return [...this.agents.values()].filter((a) => a.name !== LEAD && (a.state === "working" || a.state === "waiting")).length
  }
}
