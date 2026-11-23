// What a session still has out when no turn of it runs (harness/acp.md, *A session that still has
// work out*; conformance/outstanding.json): subagents that work or wait, a report that waits for
// the main agent, background commands that run. One rule, asked by three things: a schedule's run
// (it is not over while its subagents work), the service (it does not start again, close the link
// or let a terminal take the session while any of it is out), and whoever says why.

export interface OutstandingInput {
  /** The team as its tree has it: the main agent (`lead`) and every live subagent, with its state. */
  agents: { name: string; state: string }[]
  /** The session's background jobs that are not a team's members (those count once, by their
   *  state in `agents`): `kind` and `state` as in JobInfo. */
  jobs: { id: string; kind: string; state: string }[]
}

export interface Outstanding {
  /** Who still works for the session and will report: the subagents working, waiting for a slot
   *  or in their last turn (`paused`), by name in tree order, then the background `task`
   *  subagents still running, by job id. */
  subagents: string[]
  /** The background commands still running, by job id. */
  commands: string[]
  /** A schedule's run does not end yet: a subagent is out, or a report waits for the main agent
   *  (it is `waiting` for a slot). Background commands do not hold a run: one may never end. */
  run_waits: boolean
  /** The session is not idle, though no turn runs: anything above. */
  has_work: boolean
}

const LEAD = "lead"
const OUT = new Set(["working", "waiting", "paused"])

export function outstanding(o: OutstandingInput): Outstanding {
  const members = o.agents.filter((a) => a.name !== LEAD && OUT.has(a.state)).map((a) => a.name)
  const running = o.jobs.filter((j) => j.state === "running")
  const subagents = [...members, ...running.filter((j) => j.kind === "subagent").map((j) => j.id)]
  const commands = running.filter((j) => j.kind === "command").map((j) => j.id)
  const run_waits = subagents.length > 0 || o.agents.some((a) => a.name === LEAD && a.state === "waiting")
  return { subagents, commands, run_waits, has_work: run_waits || commands.length > 0 }
}

/** Why a session with work out is not let go of, in words a person at a terminal reads. */
export function outstandingReason(out: Outstanding): string | undefined {
  if (!out.has_work) return undefined
  const parts: string[] = []
  if (out.subagents.length) parts.push(`its subagent${out.subagents.length === 1 ? "" : "s"} still work${out.subagents.length === 1 ? "s" : ""} (${out.subagents.join(", ")})`)
  else if (out.run_waits) parts.push("a subagent's report is about to start its next turn")
  if (out.commands.length) parts.push(`${out.commands.length === 1 ? "a background command still runs" : "background commands still run"} (${out.commands.join(", ")})`)
  return `this session is not idle in the service: ${parts.join(", and ")}. A terminal cannot take them over — wait for them to finish, or stop them in the web UI (the Team panel, the job strip), then try again`
}
