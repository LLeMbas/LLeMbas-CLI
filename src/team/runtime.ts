// A lead session's team at work (harness spec 3.2.0, team.md; 3.4.0, subagents.md §5–§13): the
// rules of team.ts driven by real turns. The lead is the session's own engine; each member is a subagent engine of its own (the job
// machinery, app.ts spawn), started when the team gives it a slot. What the rules decide happens
// through three effects: a turn starts (a member's brief, a woken agent's messages), a message reaches
// a working agent at its next step, an agent is stopped.
import type { Bus } from "../bus/index.ts"
import { TOOL_SPECS } from "../harness.ts"
import type { Engine } from "../session/engine.ts"
import type { Tool } from "../tool/tool.ts"
import { parallelFrom, Team, TEAM, type TeamAgent } from "./team.ts"
import type { Mode } from "../config/schema.ts"
import type { ToolClass } from "../permission/evaluate.ts"

/** A member's engine, as the app made it. */
export interface MemberHandle {
  engine: Engine
  /** Its one final turn after its context filled (spec 3.4.0 §9), with this text, few steps. */
  final?(text: string): void
  /** Its next turn, with this text as the prompt (its context intact). */
  run(text: string): void
  /** Stop it where it is; nothing more comes from it. */
  cancel(): void
}

export interface RuntimeOptions {
  team: Team
  /** The lead's bus: where the team's news is said (`team` events). */
  bus: Bus
  /** Make a member's engine (attached here with `attach`) and start its first turn with `text`. */
  spawnMember(member: TeamAgent, text: string): void
  /** The lead: a message at its next step (`note`), or — idle — a turn of its own (`wake`). */
  lead: { note(text: string): void; wake(text: string): void }
  /** An unknown agent or model, answered as task answers it; undefined when both are known. The
   *  model's ref as the session knows it. */
  resolve?(agent: string, model: string | undefined): { error: string } | { model: string }
  /** A tool's risk class and permission key, by its name (team_request, team_decide). */
  tools?: () => readonly Tool[]
}

export class TeamRuntime {
  team: Team
  private members = new Map<string, MemberHandle>()
  /** The lead's turn waiting for a slot: resolved when it is given one. */
  private leadWaiter: (() => void) | undefined
  /** Spec 3.4.0: subagents that ended by their own team_finish (their turn stops after the call),
   *  and the final turn waiting for one whose context filled. */
  private ended = new Set<string>()
  private finals = new Map<string, string>()
  private pace: ReturnType<typeof setTimeout> | undefined

  constructor(private o: RuntimeOptions) {
    this.team = o.team
    this.wire()
  }

  private wire() {
    this.team.effects = {
      start: (name, text) => this.start(name, text),
      deliver: (name, text) => this.deliver(name, text),
      stop: (name) => this.stopped(name),
      end: (name) => void this.ended.add(name),
      final: (name, text) => void this.finals.set(name, text),
    }
  }

  /** Another session: its members are stopped, and the team starts again, empty. */
  reset(team: Team) {
    this.stopAll()
    this.leadWaiter = undefined
    this.team = team
    this.wire()
    this.changed()
  }

  /** Said on the lead's bus as `team`, at most four times a second (acp.md `team` event). */
  private changed() {
    if (this.pace) return
    this.o.bus.emit({ type: "team" })
    this.pace = setTimeout(() => {
      this.pace = undefined
    }, 1000 / 4)
  }

  /** Something changed that a reader must see now (the tools' answers, tests): said at once. */
  private changedNow() {
    if (this.pace) clearTimeout(this.pace)
    this.pace = undefined
    this.o.bus.emit({ type: "team" })
  }

  /** A tool's risk class, for team_request. */
  classOf(tool: string): ToolClass | undefined {
    const spec = TOOL_SPECS[tool]?.risk
    if (spec) return spec as ToolClass
    const t = this.o.tools?.().find((x) => x.name === tool)
    try {
      return t ? (t.permission({} as never, {} as never).class as ToolClass) : undefined
    } catch {
      return "execute"
    }
  }

  /** A tool's permission key (edit and write share `edit`), for a grant. */
  permissionKeyOf(tool: string): string | undefined {
    return this.o.tools?.().find((x) => x.name === tool)?.access ?? tool
  }

  /** Every subagent's engine in its team's mode (spec 3.4.0 §7: the main agent made stricter, an
   *  assignment). */
  syncModes() {
    for (const [name, h] of this.members) {
      const m = this.team.get(name)?.mode
      if (m && h.engine.mode !== m) h.engine.mode = m
    }
  }

  /** The main agent's mode changed (the person, plan approved): stricter reaches down the tree. */
  mainMode(mode: Mode) {
    this.team.setMainMode(mode)
    this.syncModes()
    this.changed()
  }

  /** Spec 3.4.0: whether this subagent ended by its own call (its engine stops after the step). */
  hasEnded(name: string): boolean {
    return this.ended.has(name)
  }

  /** Spec 3.4.0 §9: its context reached pause_at. "stop" the first time (it is paused, its final
   *  turn follows), "go" in that final turn (no compaction, it carries on). */
  contextFull(name: string): "stop" | "go" {
    const a = this.team.get(name)
    if (!a || a.state === "paused") return "go"
    this.team.pause(name)
    this.changedNow()
    return "stop"
  }

  /** What a member's run should do when its turn ended: its final turn (context full), or report. */
  takeFinal(name: string): string | undefined {
    const t = this.finals.get(name)
    this.finals.delete(name)
    return t
  }

  /** Something the tools did changed the team: said, for whoever shows it. */
  notify() {
    this.changed()
  }

  /** team_add for `as`: an unknown agent or model is answered as task answers it, after the
   *  team's own refusals (the name, the goal, the size), which come first. */
  add(as: string, a: { name: string; role: string; task: string; goal?: string; lead?: boolean; agent?: string; model?: string; parent?: string; mode?: Mode; request?: string[] }): { text: string; added?: TeamAgent } {
    const agent = a.agent ?? "general"
    const r = this.o.resolve?.(agent, a.model) ?? { model: a.model ?? this.team.get(as)?.model ?? this.team.model }
    // The team's refusals first; an added member needs a known agent and model.
    const dry = this.team.wouldRefuse(as, a)
    if (dry) return { text: dry }
    if ("error" in r) return { text: r.error }
    const out = this.team.add(as, { ...a, agent, model: r.model })
    this.changed()
    return out
  }

  private start(name: string, text: string) {
    if (name === TEAM.names.lead) {
      const waiter = this.leadWaiter
      this.leadWaiter = undefined
      if (waiter) {
        // The person's turn was waiting: it goes now, and what woke it meanwhile goes in at its first step.
        if (text) this.o.lead.note(text)
        waiter()
      } else if (text) this.o.lead.wake(text)
      this.changed()
      return
    }
    const known = this.members.get(name)
    if (known) known.run(text)
    else {
      const m = this.team.get(name)
      if (m) this.o.spawnMember(m, text)
    }
    this.changed()
  }

  private deliver(name: string, text: string) {
    if (name === TEAM.names.lead) this.o.lead.note(text)
    else this.members.get(name)?.engine.note(text)
  }

  private stopped(name: string) {
    const h = this.members.get(name)
    this.members.delete(name)
    this.finals.delete(name)
    h?.cancel()
    this.changed()
  }

  /** The lead's turn is about to run: it holds a slot, or waits for one (the lead first). False
   *  when it was stopped while it waited. */
  async beforeLeadTurn(signal: AbortSignal): Promise<boolean> {
    const lead = this.team.get(TEAM.names.lead)!
    if (lead.state === "working") return true
    if (this.team.leadWants()) {
      this.changed()
      return true
    }
    this.o.bus.emit({ type: "notice", message: `waiting for a free slot: the model serves ${parallelFrom(this.team.capacityOf(this.team.model))} requests at once and the team's members hold them` })
    this.changed()
    return await new Promise<boolean>((resolve) => {
      const onAbort = () => {
        this.leadWaiter = undefined
        this.team.leadIdle()
        this.changed()
        resolve(false)
      }
      signal.addEventListener("abort", onAbort, { once: true })
      this.leadWaiter = () => {
        signal.removeEventListener("abort", onAbort)
        resolve(true)
      }
    })
  }

  /** The lead's turn ended. */
  leadDone() {
    this.team.finish(TEAM.names.lead)
    this.changed()
  }

  /** A member's turn ended: its reply is its report; messages it was given too late wake it again.
   *  Spec 3.4.0: one that ended by its own team_finish is let go; one whose context filled gets its
   *  final turn first. */
  memberDone(name: string, reply: string, reason: string, leftover: string[]) {
    if (this.ended.delete(name)) {
      this.members.delete(name)
      this.changed()
      return
    }
    const final = this.takeFinal(name)
    if (final !== undefined && this.team.get(name)?.state === "paused") {
      this.members.get(name)?.final?.(final)
      this.changed()
      return
    }
    if (!this.team.get(name)) return
    this.team.finish(name, reply, reason)
    if (leftover.length) this.team.undelivered(name, leftover)
    this.changed()
  }

  /** What a call answers before its permission check, for the agent `as`. */
  refuse(as: string, tool: Tool, args: unknown): string | undefined {
    // A tool the spec does not have (an MCP server's) by the class its call carries: read when it
    // says readOnlyHint, interact for the server's memory, else execute.
    let risk: string | undefined
    if (!TOOL_SPECS[tool.name]) {
      try {
        risk = tool.permission(args as never, {} as never).class
      } catch {
        risk = "execute"
      }
    }
    return this.team.refusal(as, tool.name, args, risk)
  }

  /** The person stopped a member in the UI (/team stop). */
  personStop(name: string): string[] {
    const gone = this.team.personStop(name)
    this.changed()
    return gone
  }

  /** Stop every member: the lead's session ends or is left. */
  stopAll() {
    for (const m of this.team.membersOf(TEAM.names.lead)) this.team.personStop(m.name)
    this.team.forgetStopped()
    for (const h of this.members.values()) h.cancel()
    this.members.clear()
  }

  /** A member's engine, made. */
  attach(name: string, h: MemberHandle) {
    this.members.set(name, h)
  }

  handle(name: string): MemberHandle | undefined {
    return this.members.get(name)
  }
}
