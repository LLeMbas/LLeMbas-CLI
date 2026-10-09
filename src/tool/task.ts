import { z } from "zod"
import { defineTool, ToolError } from "./tool.ts"
import { described } from "../harness.ts"

export interface SubagentResult {
  text: string
  steps: number
  tools: number
  reason: string
}

export const taskTool = defineTool({
  ...described("task"),
  access: "task",
  schema: z.object({
    description: z.string(),
    prompt: z.string().min(1),
    agent: z.string().optional(),
    worktree: z.boolean().optional(),
    model: z.string().optional(),
  }),
  permission: (a) => ({ permission: "task", class: "interact", patterns: [a.model ? `${a.agent ?? "explore"} on ${a.model}` : (a.agent ?? "explore")] }),
  async run(a, ctx) {
    if (!ctx.spawn) throw new ToolError("Subagents cannot start subagents.")
    const agent = a.agent ?? "explore"
    let r: Awaited<ReturnType<NonNullable<typeof ctx.spawn>>>
    try {
      r = await ctx.spawn(agent, a.prompt, ctx.signal, ctx.callId, { worktree: a.worktree, description: a.description, model: a.model })
    } catch (e) {
      if (e instanceof ToolError) throw e
      throw new ToolError((e as Error).message)
    }
    const tail = `\n\n[${agent} subagent · ${r.steps} step${r.steps === 1 ? "" : "s"} · ${r.tools} tool call${r.tools === 1 ? "" : "s"}${r.reason !== "stop" ? ` · ended: ${r.reason}` : ""}]`
    return { output: (r.text.trim() || "(the subagent returned no report)") + tail, title: `${agent}${a.model ? ` on ${a.model}` : ""}: ${a.description} · ${r.steps} steps`, isError: r.reason === "error" }
  },
})
