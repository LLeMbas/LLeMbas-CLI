import { existsSync, readFileSync, realpathSync } from "node:fs"
import { z } from "zod"
import type { Mode } from "../config/schema.ts"
import { absPath, defineTool, showPath, ToolError } from "./tool.ts"
import { described } from "../harness.ts"

export type PlanReply = { kind: "approve"; mode: Extract<Mode, "edit" | "manual"> } | { kind: "revise"; feedback: string } | { kind: "back"; text: string } | { kind: "dismissed" }

/** What the model is told when nobody can approve (also where the client turns out to have no plan
 *  card). */
export const nobodyToApprove = (path: string) => `Nobody is present to approve the plan. It is saved at ${path}. Stop here: say the plan is ready and where it is. Make no changes.`

export const planSubmitTool = defineTool({
  ...described("plan_submit"),
  purpose: false,
  access: "plan_submit",
  requires: "plan",
  exclusive: true,
  schema: z.object({ path: z.string() }),
  permission: () => ({ permission: "plan_submit", class: "interact", patterns: ["*"] }),
  async run(a, ctx) {
    const abs = absPath(a.path, ctx)
    const plans = ctx.planDir
    if (plans && !abs.startsWith(plans + "/")) throw new ToolError(`The plan must be a file under ${showPath(plans, ctx)}; ${showPath(abs, ctx)} is not.`)
    if (!existsSync(abs)) throw new ToolError(`${showPath(abs, ctx)} does not exist — write the plan first.`)
    // By where it really is: a link under the plans directory could point anywhere.
    if (plans && !realpathSync(abs).startsWith(realpathSync(plans) + "/")) throw new ToolError(`${showPath(abs, ctx)} leads out of the plans directory.`)
    const text = readFileSync(abs, "utf8")
    if (!ctx.plan)
      return {
        output: nobodyToApprove(showPath(abs, ctx)),
        title: `${showPath(abs, ctx)} · saved, not approved`,
      }
    const r = await ctx.plan({ path: showPath(abs, ctx), text }, ctx.callId)
    const shown = showPath(abs, ctx)
    switch (r.kind) {
      case "approve":
        ctx.setMode?.(r.mode)
        return {
          output: `The user approved the plan in ${shown}. The permission mode is now ${r.mode}. Implement it now, step by step as written, keeping a todo list that follows its steps. If you find the plan wrong somewhere, say so and adjust rather than follow it into a mistake.`,
          title: `${shown} · approved → ${r.mode}`,
        }
      case "revise":
        return { output: `The user wants the plan revised: ${r.feedback}\nUpdate ${shown}, then call plan_submit again.`, title: `${shown} · revise` }
      case "back":
        return { output: `Before deciding, the user asks: "${r.text}"\nAnswer it in your reply, revise ${shown} if the answer changes it, then call plan_submit again.`, title: `${shown} · asked back` }
      case "dismissed":
        return { output: `The user closed the plan without deciding. Stay in plan mode; say the plan is at ${shown} and wait.`, title: `${shown} · not decided` }
    }
  },
})
