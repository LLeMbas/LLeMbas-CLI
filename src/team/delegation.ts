// Delegation (harness spec 3.4.0, subagents.md §7): a subagent's mode is its parent's or stricter,
// request options go with a stricter mode, and who decides a subagent's call — itself, the main
// agent (through a request), or the person. Pure rules over permission/evaluate.ts.
import { LOOP } from "../harness.ts"
import { fillPrompt } from "../prompt/fill.ts"
import type { Mode } from "../config/schema.ts"
import { evaluate, type Context as PermContext, type Decision, type PermissionRequest, type Rule, type ToolClass } from "../permission/evaluate.ts"
import MODES_JSON from "../../harness/permission/modes.json"

const TEXTS = LOOP.team.texts
const fill = (t: string, v: Record<string, string>) => fillPrompt(t, v)

/** Loosest first (permission/modes.json `order`). */
export const MODE_ORDER = MODES_JSON.order as Mode[]
const rank = (m: Mode) => MODE_ORDER.indexOf(m)

/** a is looser than b. */
export const looser = (a: Mode, b: Mode) => rank(a) < rank(b)
/** a is stricter than b. */
export const stricter = (a: Mode, b: Mode) => rank(a) > rank(b)
/** The stricter of the two. */
export const strictest = (a: Mode, b: Mode): Mode => (stricter(a, b) ? a : b)

export const REQUEST_KINDS = LOOP.team.request.kinds as ToolClass[]

/** team_add's / team_assign's mode and request options for a parent in `parentMode` (§7): the
 *  refusal, or the mode and options the subagent gets. */
export function checkMode(parentMode: Mode, mode: Mode | undefined, request: string[] | undefined): { error: string } | { mode: Mode; request: ToolClass[] } {
  const m = mode ?? parentMode
  if (looser(m, parentMode)) return { error: fill(TEXTS.wider, { parent_mode: parentMode }) }
  const req = request ?? []
  if (req.length && !stricter(m, parentMode)) return { error: TEXTS.request_not_narrower }
  const bad = req.find((k) => !(REQUEST_KINDS as string[]).includes(k))
  if (bad !== undefined) return { error: fill(TEXTS.request_kind, { kind: bad }) }
  return { mode: m, request: [...new Set(req)] as ToolClass[] }
}

/** A grant the main agent gave (team_decide): a rule for this subagent alone. */
export interface Grant {
  tool: string
  /** The permission key of the tool (edit and write share `edit`). */
  permission?: string
  pattern: string
}

export type Verdict = { answer: "run"; decision: Decision } | { answer: "person"; decision: Decision } | { answer: "refused"; text: string; decision?: Decision }

/** Who decides a subagent's call (§7). `ctx` is the session's permission context (its rules and
 *  approvals); `mode` the subagent's, `main` the main agent's. A grant applies only where the main
 *  agent's own mode would allow the call. */
export function whoDecides(
  req: PermissionRequest,
  o: { ctx: Omit<PermContext, "mode">; mode: Mode; main: Mode; request: readonly string[]; grants: readonly Grant[]; unattended?: boolean },
): Verdict {
  const mainD = evaluate(req, { ...o.ctx, mode: o.main })
  const grantRules: Rule[] = mainD.action === "allow" ? o.grants.map((g) => ({ permission: g.permission ?? g.tool, pattern: g.pattern, action: "allow" as const })) : []
  const own = evaluate(req, { ...o.ctx, mode: o.mode, rules: [...o.ctx.rules, ...grantRules] })
  if (own.action === "allow") return { answer: "run", decision: own }
  if (own.action === "deny") return { answer: "refused", text: `Denied: ${own.reason}`, decision: own }
  if (mainD.action === "allow") return { answer: "refused", text: o.request.includes(req.class) ? TEXTS.requestable : TEXTS.not_delegated }
  if (mainD.action === "deny") return { answer: "refused", text: `Denied: ${mainD.reason}`, decision: mainD }
  if (o.unattended) return { answer: "refused", text: "Refused: nobody can approve this in an unattended session.", decision: own }
  return { answer: "person", decision: own }
}

/** team_request's own check: the tool's risk class must be one of the options. */
export function requestRefusal(tool: string, cls: ToolClass | undefined, request: readonly string[]): string | undefined {
  if (cls && request.includes(cls)) return undefined
  return fill(TEXTS.not_requestable, { tool, kinds: request.join(", ") || "none" })
}

/** The main agent made stricter: every subagent looser than its parent is made as strict as it,
 *  down the tree (§7). `agents` in tree order; returns each one's mode after. */
export function tighten(main: Mode, agents: { name: string; parent: string; mode: Mode }[], lead = LOOP.team.names.lead): Record<string, Mode> {
  const modes: Record<string, Mode> = { [lead]: main }
  const out: Record<string, Mode> = {}
  const pending = [...agents]
  // Parents first: an agent's parent is the lead or one listed before it, but tolerate any order.
  for (let guard = 0; pending.length && guard < 1000; guard++) {
    const i = pending.findIndex((a) => modes[a.parent] !== undefined)
    if (i < 0) break
    const a = pending.splice(i, 1)[0]!
    modes[a.name] = out[a.name] = strictest(a.mode, modes[a.parent]!)
  }
  return out
}
