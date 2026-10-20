// The `jobs` capability of the `_lembas/*` extension (harness/acp.md): a session's background jobs
// shown and controlled from a client. The same answers whichever process holds the session — the
// agent (acp/agent.ts) for one it runs or opens from the store, the terminal through the hub
// (acp/share.ts `hub/job`) for one it has open — so both call here.
import type { App } from "../app.ts"
import { jobRegistry, type Job, type JobInfo } from "../jobs/registry.ts"
import type { Store } from "../session/store.ts"
import { historyTurns } from "./agent.ts"
import { INVALID_PARAMS, RpcError } from "./rpc.ts"

/** How long `job/stop` waits for the stop to take before answering with the state as it is. */
const STOP_WAIT_MS = 2500

/** `_lembas/jobs`: the session's jobs, running first (the registry's order). */
export function jobList(app: App): JobInfo[] {
  return app.jobs().map((j) => app.registry.info(j))
}

function find(app: App, id: unknown): Job {
  const job = typeof id === "string" ? app.registry.get(app.jobsSessionId(), id) : undefined
  if (!job) throw new RpcError(INVALID_PARAMS, `no job ${String(id ?? "")} in this session`)
  return job
}

/** `_lembas/job/output`: the output from `since` (a command's output, a subagent's transcript
 *  lines), how much there is now, and the state. The model's own read mark is not moved. */
export function jobOutput(app: App, id: unknown, since: unknown): { text: string; length: number; state: string } {
  const job = find(app, id)
  const from = typeof since === "number" && Number.isFinite(since) ? Math.max(0, Math.floor(since)) : 0
  return { text: job.output.slice(from), length: job.output.length, state: job.state }
}

/** `_lembas/job/stop`: stop it (TERM then KILL for a command, cancel for a subagent), and answer
 *  once the stop has taken — or, after a moment, with the state as it is. The end note wakes the
 *  owner as any end does. */
export async function jobStop(app: App, id: unknown): Promise<{ state: string }> {
  const job = find(app, id)
  if (job.state !== "running") return { state: job.state }
  app.registry.stop(job)
  const until = Date.now() + STOP_WAIT_MS
  while (Date.now() < until && job.state === "running") await Bun.sleep(25)
  return { state: job.state }
}

/** `_lembas/job/send`: a message to a subagent — its inbox while it runs, a new prompt under the
 *  same id once it has finished (a new `job` start event follows). */
export function jobSend(app: App, id: unknown, text: unknown): { state: string } {
  const job = find(app, id)
  if (job.kind !== "subagent") throw new RpcError(INVALID_PARAMS, `${job.id} is a command; only a subagent takes a message`)
  const t = typeof text === "string" ? text.trim() : ""
  if (!t) throw new RpcError(INVALID_PARAMS, "nothing to send")
  if (!job.subagent) throw new RpcError(INVALID_PARAMS, `${job.id} cannot be messaged any more — an earlier process ran it`)
  if (job.state === "running") job.subagent.send(t)
  else {
    app.registry.restartSubagent(job)
    void job.subagent.restart(t)
  }
  return { state: job.state }
}

/** `_lembas/job/transcript`: a subagent's own conversation as `session/history` turns. */
export function jobTranscript(app: App, id: unknown): { id: string; turns: ReturnType<typeof historyTurns> } {
  const job = find(app, id)
  if (job.kind !== "subagent") throw new RpcError(INVALID_PARAMS, `${job.id} is a command; its output is job/output`)
  const messages = job.subagent?.engine.messages ?? (job.childSessionId && app.store ? app.store.messages(job.childSessionId) : [])
  return { id: job.id, turns: historyTurns(messages, app.engine.o.toolCtx.cwd) }
}

/** The jobs of a session nobody has open, as the store keeps them (for `status` of a session
 *  `held: "none"`): one that was running when its process died reads `lost`. Running first. */
export function storedJobs(store: Store, sessionId: string): JobInfo[] {
  const list: JobInfo[] = []
  for (const row of store.jobs(sessionId)) {
    try {
      const job = JSON.parse(row.json) as Job
      if (job.state === "running") job.state = "lost"
      list.push(jobRegistry().info(job))
    } catch {}
  }
  return [...list.filter((j) => j.state === "running"), ...list.filter((j) => j.state !== "running")]
}
