import { z } from "zod"
import { defineTool, ToolError } from "./tool.ts"
import { described } from "../harness.ts"
import { stoppedLine } from "../jobs/registry.ts"
import { subagentTail } from "../jobs/note.ts"

export interface SubagentResult {
  text: string
  steps: number
  tools: number
  reason: string
  /** The last error its engine reported, when `reason` is error. */
  error?: string
  /** How many of its own background commands were stopped with it. */
  stopped?: number
}

export const taskTool = defineTool({
  ...described("task"),
  access: "task",
  schema: z.object({
    description: z.string(),
    prompt: z.string().min(1),
    agent: z.string().optional(),
    worktree: z.boolean().optional(),
    background: z.boolean().optional(),
    model: z.string().optional(),
  }),
  permission: (a) => ({ permission: "task", class: "interact", patterns: [a.model ? `${a.agent ?? "explore"} on ${a.model}` : (a.agent ?? "explore")] }),
  async run(a, ctx) {
    if (!ctx.spawn) throw new ToolError("Subagents cannot start subagents.")
    const agent = a.agent ?? "explore"
    let handle: Awaited<ReturnType<NonNullable<typeof ctx.spawn>>>
    try {
      // A background subagent is not tied to this turn: Esc stops the reply, not the job.
      handle = await ctx.spawn(agent, a.prompt, { signal: a.background ? undefined : ctx.signal, callId: ctx.callId, worktree: a.worktree, description: a.description, model: a.model, background: a.background })
    } catch (e) {
      if (e instanceof ToolError) throw e
      throw new ToolError((e as Error).message)
    }
    const who = `${agent}${a.model ? ` on ${a.model}` : ""}`
    if (a.background) {
      return {
        output: `Started subagent ${agent} as ${handle.id} (${a.description}). Its report comes to you as a message when it ends; meanwhile job_output shows its progress, job_send gives it a message, job_stop stops it.`,
        title: `${who}: ${a.description} · background ${handle.id}`,
        meta: { job: handle.id },
      }
    }
    const r = await handle.done
    const tail = `\n\n${subagentTail(agent, r.steps, r.tools, r.reason, r.error)}${r.stopped ? `\n${stoppedLine(r.stopped)}` : ""}`
    return { output: (r.text.trim() || "(the subagent returned no report)") + tail, title: `${who}: ${a.description} · ${r.steps} steps`, isError: r.reason === "error" }
  },
})
