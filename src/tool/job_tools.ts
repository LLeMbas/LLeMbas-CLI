// The model's side of background work (harness spec 2.0.0, jobs/registry.ts): list the session's
// jobs, read one's new output, stop one, message a subagent; and `report`, a subagent's message to
// the main agent before its final reply. Every lookup is the owner's: a subagent sees what it
// started, nothing of its parent's.
import { z } from "zod"
import { defineTool, ToolError, truncate, type ToolContext } from "./tool.ts"
import { described } from "../harness.ts"
import { duration } from "../duration.ts"
import { commandLine, exitWords } from "../jobs/note.ts"
import type { Job } from "../jobs/registry.ts"

function jobsOf(ctx: ToolContext) {
  if (!ctx.jobs) throw new ToolError("Background jobs are not available here.")
  return ctx.jobs
}

function find(ctx: ToolContext, id: string): Job {
  const { registry, owner } = jobsOf(ctx)
  const job = registry.get(owner().sessionId, id.trim())
  if (!job) throw new ToolError(`No background job ${id}. job_list shows this session's jobs.`)
  return job
}

/** A job's state in words: a command's exit, a subagent's end. */
export function stateWords(job: Job): string {
  if (job.state === "running") return "still running"
  if (job.state === "lost") return "lost (the process that ran it ended)"
  if (job.kind === "command") return exitWords(job.exit)
  return job.state === "done" ? "finished" : job.state === "stopped" ? "stopped" : "ended with an error"
}

/** What a job is, for a list: the command's first line, or the subagent and its description. */
export function whatWords(job: Job): string {
  return job.kind === "command" ? commandLine(job.command ?? "", 120) : `${job.agent}: ${job.description}`
}

export const jobListTool = defineTool({
  ...described("job_list"),
  purpose: false,
  access: "job_list",
  schema: z.object({}),
  permission: () => ({ permission: "job_list", class: "read", patterns: ["*"] }),
  async run(_a, ctx) {
    const { registry, owner } = jobsOf(ctx)
    const jobs = registry.list(owner().sessionId)
    if (!jobs.length) return { output: "No background jobs.", title: "0 jobs" }
    const now = Date.now()
    const lines = jobs.map((j) => {
      const unread = j.output.length > j.read ? ` · ${j.output.length - j.read} chars unread` : ""
      return `${j.id} · ${j.kind} · ${stateWords(j)} · ${duration((j.ended ?? now) - j.started, true)}${unread} · ${whatWords(j)}`
    })
    const running = jobs.filter((j) => j.state === "running").length
    return { output: lines.join("\n"), title: `${jobs.length} job${jobs.length === 1 ? "" : "s"}${running ? ` · ${running} running` : ""}` }
  },
})

export const jobOutputTool = defineTool({
  ...described("job_output"),
  purpose: false,
  access: "job_output",
  schema: z.object({ id: z.string(), wait: z.number().min(0).max(60).optional() }),
  permission: () => ({ permission: "job_output", class: "read", patterns: ["*"] }),
  async run(a, ctx) {
    const { registry } = jobsOf(ctx)
    const job = find(ctx, a.id)
    const until = Date.now() + (a.wait ?? 0) * 1000
    while (Date.now() < until && job.state === "running" && job.output.length === job.read && !ctx.signal.aborted) await Bun.sleep(200)
    const fresh = registry.takeUnread(job)
    const state = stateWords(job)
    return { output: `${truncate(fresh.trimEnd()) || "(no new output)"}\n\n[${job.id} ${state}]`, title: `${job.id} · ${state}` }
  },
})

export const jobStopTool = defineTool({
  ...described("job_stop"),
  purpose: false,
  access: "job_stop",
  schema: z.object({ id: z.string() }),
  permission: () => ({ permission: "job_stop", class: "execute", patterns: ["*"] }),
  async run(a, ctx) {
    const { registry } = jobsOf(ctx)
    const job = find(ctx, a.id)
    if (job.state !== "running") return { output: `${job.id} had already ${stateWords(job)}.`, title: `${job.id} · already ended` }
    registry.stop(job)
    if (job.kind === "subagent") return { output: `Stopping ${job.id} (${whatWords(job)}). What it had worked out comes to you as its report when it has stopped.`, title: `${job.id} · stopping` }
    return { output: `Stopped ${job.id} (${whatWords(job)}).`, title: `${job.id} · stopped` }
  },
})

export const jobSendTool = defineTool({
  ...described("job_send"),
  purpose: false,
  access: "job_send",
  schema: z.object({ id: z.string(), text: z.string().min(1) }),
  permission: (a) => ({ permission: "job_send", class: "interact", patterns: [a.id] }),
  async run(a, ctx) {
    const { registry } = jobsOf(ctx)
    const job = find(ctx, a.id)
    if (job.kind !== "subagent" || !job.subagent) throw new ToolError(`${job.id} is a command, not a subagent; a message can only go to a subagent.`)
    if (job.state === "running") {
      job.subagent.send(a.text)
      return { output: `Sent to ${job.id} (${whatWords(job)}); it is given to it at its next step.`, title: `${job.id} · message sent` }
    }
    registry.restartSubagent(job)
    void job.subagent.restart(a.text)
    return { output: `${job.id} (${whatWords(job)}) is running again with your message as its new prompt, its context intact. Its report comes to you when it ends.`, title: `${job.id} · started again` }
  },
})

export const reportTool = defineTool({
  ...described("report"),
  purpose: false,
  access: "report",
  schema: z.object({ text: z.string().min(1) }),
  permission: () => ({ permission: "report", class: "interact", patterns: ["*"] }),
  async run(a, ctx) {
    const { registry, owner } = jobsOf(ctx)
    const job = owner().job
    if (!job) throw new ToolError("report is for a subagent: you are the main agent, so write to the user directly.")
    registry.message(job, a.text)
    return { output: "Sent to the main agent. An answer, if one comes, arrives as a message to you; carry on meanwhile.", title: "message to the main agent" }
  },
})
