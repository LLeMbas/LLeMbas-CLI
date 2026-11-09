// The team tools (harness spec 3.2.0, team.md; tools/team_*.json): add a member, send through the
// room, read the team and the room, stop a member. The rules are team/team.ts; these are its calls
// for the agent the context names (`ctx.team.as`).
import { z } from "zod"
import { defineTool, ToolError, type ToolContext } from "./tool.ts"
import { described, TOOL_SPECS } from "../harness.ts"
import { TEAM } from "../team/team.ts"
import { fillPrompt } from "../prompt/fill.ts"

function teamOf(ctx: ToolContext) {
  if (!ctx.team) throw new ToolError(TOOL_SPECS.team_add!.unavailable ?? TEAM.unavailable.one_agent)
  return ctx.team
}

/** The spec's own answer when a name does not parse (team.md §4's order: the requirement, `all`,
 *  then the pattern), before the generic one for invalid arguments. */
function badName(raw: unknown, ctx: ToolContext): string | undefined {
  const name = (raw as { name?: unknown } | undefined)?.name
  if (typeof name !== "string") return undefined
  const no = ctx.team ? (ctx.team.runtime.team.offered ? ctx.team.runtime.team.unavailable() : TEAM.unavailable.one_agent) : TEAM.unavailable.one_agent
  if (no) return no
  if (name === "all") return TEAM.texts.all_name
  if (!new RegExp(TEAM.names.pattern).test(name)) return fillPrompt(TEAM.texts.bad_name, { name })
  return undefined
}

export const teamAddTool = defineTool({
  ...described("team_add"),
  purpose: false,
  access: "team_add",
  requires: "team",
  schema: z.object({
    name: z.string().regex(new RegExp(TEAM.names.pattern)),
    role: z.string().min(1),
    task: z.string().min(1),
    goal: z.string().optional(),
    lead: z.boolean().optional(),
    agent: z.string().optional(),
    model: z.string().optional(),
  }),
  invalid: badName,
  permission: (a) => ({ permission: "team_add", class: "interact", patterns: [a.agent ?? "general"] }),
  async run(a, ctx) {
    const t = teamOf(ctx)
    const r = t.runtime.add(t.as, a)
    return { output: r.text, title: r.added ? `${a.name}: ${a.role}` : "not added", isError: !r.added }
  },
})

export const teamSendTool = defineTool({
  ...described("team_send"),
  purpose: false,
  access: "team_send",
  requires: "team",
  schema: z.object({ to: z.array(z.string()).min(1), message: z.string().min(1) }),
  permission: () => ({ permission: "team_send", class: "interact", patterns: ["*"] }),
  async run(a, ctx) {
    const t = teamOf(ctx)
    const before = t.runtime.team.room.length
    const output = t.runtime.team.send(t.as, a)
    t.runtime.notify()
    const sent = t.runtime.team.room.length > before
    return { output, title: sent ? `to ${a.to.includes("all") ? "all" : [...new Set(a.to)].join(", ")}` : "not sent", isError: !sent }
  },
})

export const teamReadTool = defineTool({
  ...described("team_read"),
  purpose: false,
  access: "team_read",
  requires: "team",
  schema: z.object({ since: z.number().int().min(0).optional() }),
  permission: () => ({ permission: "team_read", class: "read", patterns: ["*"] }),
  async run(a, ctx) {
    const t = teamOf(ctx)
    return { output: t.runtime.team.read(t.as, a.since ?? 0), title: `team${a.since ? ` since #${a.since}` : ""}` }
  },
})

export const teamStopTool = defineTool({
  ...described("team_stop"),
  purpose: false,
  access: "team_stop",
  requires: "team",
  schema: z.object({ name: z.string().min(1) }),
  permission: (a) => ({ permission: "team_stop", class: "interact", patterns: [a.name] }),
  async run(a, ctx) {
    const t = teamOf(ctx)
    const size = t.runtime.team.size()
    const output = t.runtime.team.stopCmd(t.as, a.name)
    t.runtime.notify()
    return { output, title: t.runtime.team.size() < size ? `stopped ${a.name}` : "not stopped", isError: t.runtime.team.size() >= size }
  },
})
