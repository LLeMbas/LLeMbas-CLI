// Teams (harness spec 3.2.0, harness/team.md): a lead session's agents, their room, who receives
// what, the size the person allows, a manager's refusals, and the slots of the model they run on.
// This file is the rules alone, without an engine: the conformance area `team` drives it step by
// step, and the app (team/runtime.ts) drives it from real turns — the effects say when an agent's
// turn starts (it was given a slot), when a message reaches an agent that is working, and when an
// agent is stopped.
import { LOOP, TOOL_SPECS } from "../harness.ts"
import { fillPrompt } from "../prompt/fill.ts"
import { DEFAULT_RULES, evaluate, toRules } from "../permission/evaluate.ts"
import { BUILTIN_HARDLINE } from "../permission/hardline.ts"
import { duration } from "../duration.ts"

export const TEAM = LOOP.team
const TEXTS = TEAM.texts
const LEAD = TEAM.names.lead
export const TEAM_TOOLS = ["team_add", "team_read", "team_send", "team_stop"] as const
const NAME = new RegExp(TEAM.names.pattern)

export type AgentState = "working" | "waiting" | "finished" | "idle"

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
  name: string
  role: string
  /** Who added it; null for the lead. */
  manager: string | null
  /** May add members of its own (team_add's `lead`); the lead may. */
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
}

export interface TeamEffects {
  /** The agent was given a slot: its turn starts now with `text` (a member's brief, or the messages
   *  that woke it; for the lead, what woke it — "" when the person's own message did). */
  start(name: string, text: string): void
  /** A message to an agent whose turn runs: at its next step boundary. */
  deliver(name: string, text: string): void
  /** It left the team: its turn stops where it is, its background commands with it. */
  stop(name: string): void
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
  effects?: TeamEffects
  /** A bash command a manager may still run: one the default rules alone allow in manual mode. */
  readingBash?: (command: string) => boolean
  now?: () => number
  /** The lead's state as the team begins: working (its first prompt runs) or idle. */
  leadState?: "working" | "idle"
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
  /** `task` helpers running in the team: who started each, and on which model. */
  private helpers: { id: number; by: string; model: string }[] = []
  private seq = 0
  private helperSeq = 0
  /** Whether the team is offered, fixed as the prompt is made (§2). */
  offered = false
  /** The setting as the lead was last told it. */
  private told: { min: number; max: number } | undefined
  /** Members the person stopped, not yet said to the lead. */
  private stoppedByPerson: string[] = []
  private waits = 0

  constructor(private o: TeamOptions) {
    this.cap = o.cap ?? TEAM.agents.cap
    this.subagents = o.subagents !== false
    this.model = o.model
    this.min = TEAM.agents.min
    this.max = TEAM.agents.max
    this.setSetting(o.min ?? TEAM.agents.min, o.max ?? TEAM.agents.max)
    this.agents.set(LEAD, { name: LEAD, role: TEAM.read.lead_role, manager: null, leads: true, goal: "", model: o.model, agent: "", state: o.leadState ?? "working", inbox: [], seq: this.seq++ })
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
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || min > max || max > cap) return `agents: 1 ≤ min ≤ max ≤ ${cap} (the cap) — whole numbers; min ${min}, max ${max} is outside`
    return undefined
  }

  /** How many requests the lead's model serves at once now. */
  parallelNow(): number {
    return parallelFrom(this.o.capacity(this.model))
  }

  /** §2: offered when subagents are on and the chat's model serves two at once — fixed as the
   *  prompt is made (and made again on a model switch). */
  fix(model = this.model): boolean {
    this.model = model
    const lead = this.agents.get(LEAD)
    if (lead) lead.model = model
    this.offered = this.subagents && this.parallelNow() >= 2
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

  /** §3: the lead, every member, and every running `task` helper. */
  size(): number {
    return this.agents.size + this.helpers.length
  }

  /** §6: an agent with a member, or the lead from the start when min ≥ 2 and the team is offered. */
  isManager(name: string): boolean {
    if (this.membersOf(name).length) return true
    return name === LEAD && this.offered && this.min >= 2
  }

  // ── what a call answers ──────────────────────────────────────────────────────

  /** §2: the team tools' requirement `team`; the text a call answers while it is not met. */
  unavailable(): string | undefined {
    if ((this.max >= 2 && this.parallelNow() >= 2) || this.hasMembers()) return undefined
    return this.parallelNow() < 2 ? TEAM.unavailable.one_request : TEAM.unavailable.one_agent
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
    if ((TEAM_TOOLS as readonly string[]).includes(tool)) return this.offered ? this.unavailable() : TEAM.unavailable.one_agent
    if (tool === "task") return this.taskRefusal()
    if (this.isManager(by) && this.isWork(tool, args, risk)) return TEXTS.manager
    return undefined
  }

  // ── slots ───────────────────────────────────────────────────────────────────

  private busyOn(model: string): number {
    return [...this.agents.values()].filter((a) => a.state === "working" && a.model === model).length + this.helpers.filter((h) => h.model === model).length
  }

  private free(model: string): boolean {
    const group = this.o.capacity(model).group
    if (group !== undefined) {
      for (const a of this.agents.values()) if (a.state === "working" && a.model !== model && this.o.capacity(a.model).group === group) return false
      for (const h of this.helpers) if (h.model !== model && this.o.capacity(h.model).group === group) return false
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

  /** A `task` helper started by `by` (it counts and holds a slot until helperDone). */
  helperStart(by: string, model = this.model): number {
    const id = ++this.helperSeq
    this.helpers.push({ id, by, model })
    return id
  }

  helperDone(id: number) {
    this.helpers = this.helpers.filter((h) => h.id !== id)
    this.fillSlots()
  }

  /** The first helper `by` started, done (the conformance area's `helper_done`). */
  helperDoneBy(by: string) {
    const h = this.helpers.find((x) => x.by === by)
    if (h) this.helperDone(h.id)
  }

  // ── delivery ────────────────────────────────────────────────────────────────

  /** §7: to a working agent at its next step; otherwise it wakes (and may wait for a slot). */
  private deliver(name: string, text: string) {
    const a = this.agents.get(name)
    if (!a) return
    this.delivered.push({ name, text })
    if (a.state === "working") return this.o.effects?.deliver(name, text)
    a.inbox.push(text)
    this.want(a)
  }

  /** What was delivered, to whom, since this was last read (for a front end and the conformance). */
  delivered: { name: string; text: string }[] = []

  private post(from: string, to: string[], recipients: string[], text: string, report: boolean): RoomMessage {
    const m: RoomMessage = { n: this.room.length + 1, from, to, recipients, text, time: this.now(), report }
    this.room.push(m)
    const mark = fill(report ? TEAM.marks.report : TEAM.marks.message, { from, to: to.join(", ") })
    for (const r of recipients) this.deliver(r, `${mark}\n${text}`)
    return m
  }

  // ── the tools ───────────────────────────────────────────────────────────────

  /** team_add (§4). `brief` is what the member's first turn is given. */
  add(by: string, a: { name: string; role: string; task: string; goal?: string; lead?: boolean; agent?: string; model?: string }): { text: string; added?: TeamAgent } {
    const no = this.offered ? this.unavailable() : TEAM.unavailable.one_agent
    if (no) return { text: no }
    if (a.name === "all") return { text: TEXTS.all_name }
    if (!NAME.test(a.name)) return { text: fill(TEXTS.bad_name, { name: a.name }) }
    if (this.agents.has(a.name)) return { text: fill(TEXTS.taken, { name: a.name }) }
    const lead = this.agents.get(LEAD)!
    const goal = a.goal?.trim()
    if (by === LEAD && !lead.goal && !goal) return { text: TEXTS.no_goal }
    if (this.size() + 1 > this.max) return { text: fill(TEXTS.full, { max: this.max }) }
    const caller = this.agents.get(by) ?? lead
    if (by === LEAD && goal) lead.goal = goal
    const member: TeamAgent = {
      name: a.name,
      role: a.role.trim().split("\n")[0]!,
      manager: by,
      leads: a.lead === true,
      goal: goal || caller.goal,
      model: a.model ?? caller.model,
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
    const list = [...new Set(typeof a.to === "string" ? [a.to] : a.to)]
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
          role: a.role,
          state: R.states[a.state],
          model: a.model,
          last: a.state === "working" ? R.active : a.ended !== undefined ? `${duration(this.now() - a.ended)} ago` : "—",
        }),
      )
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

  private remove(gone: TeamAgent[]) {
    for (const a of gone) {
      this.agents.delete(a.name)
      this.o.effects?.stop(a.name)
    }
    this.fillSlots()
  }

  /** An agent's turn ended (§5): a member's final reply is its report to its manager. `reason`:
   *  stop, steps, budget, or `error — <text>`. */
  finish(name: string, reply = "", reason = "stop") {
    const a = this.agents.get(name)
    if (!a || a.state !== "working") return
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

  /** The lead's turn is starting without having asked (the engine's own): it holds a slot. */
  leadWorking() {
    const lead = this.agents.get(LEAD)!
    lead.state = "working"
    lead.waitSince = undefined
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
      else out.push([fill(N.team, { min: this.min, max: this.max }), ...(this.min >= 2 ? [fill(N.team_lead, { members: this.min - 1 })] : [])].join("\n"))
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
