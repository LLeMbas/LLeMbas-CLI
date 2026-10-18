// plan_submit: the plan written with plan_write, presented for approval — plan mode only, where
// it is the approval. The plan itself is the session's (src/plan/plan.ts); a copy goes under the
// project's plans directory for the record, since that is the one place plan mode may write.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import type { Mode } from "../config/schema.ts"
import { described } from "../harness.ts"
import { render, type Plan } from "../plan/plan.ts"
import { defineTool, showPath, ToolError } from "./tool.ts"

export type PlanReply = { kind: "approve"; mode: Extract<Mode, "edit" | "manual"> } | { kind: "revise"; feedback: string } | { kind: "back"; text: string } | { kind: "dismissed" }

/** What is put to the user: the plan, its text as the card draws it, and the file it was saved to
 *  for the record (relative to the project), or "" where there is no plans directory. */
export interface PlanRequest {
  path: string
  text: string
  plan: Plan
}

/** What the model is told when nobody can approve (also where the client turns out to have no plan
 *  card). */
export const nobodyToApprove = (path: string) => `Nobody is present to approve the plan.${path ? ` It is saved at ${path}.` : ""} Stop here: say the plan is ready${path ? " and where it is" : ""}. Make no changes.`

const slug = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "plan"

export const planSubmitTool = defineTool({
  ...described("plan_submit"),
  purpose: false,
  access: "plan_submit",
  requires: "plan",
  exclusive: true,
  schema: z.object({ path: z.string().optional() }),
  permission: () => ({ permission: "plan_submit", class: "interact", patterns: ["*"] }),
  async run(_a, ctx) {
    const plan = ctx.plan?.get()
    if (!plan) throw new ToolError("There is no plan yet. Write it with plan_write, then call plan_submit.")
    const text = render(plan)
    // For the record: the plans directory is the one place plan mode writes (made on the way, as
    // the write tool made it before), and a plan that was approved is worth finding again. Nothing
    // waits on it: a directory that cannot be written is not a reason to lose the approval.
    let path = ""
    if (ctx.planDir) {
      const abs = join(ctx.planDir, `${new Date().toISOString().slice(0, 10)}-${slug(plan.title)}.md`)
      try {
        mkdirSync(ctx.planDir, { recursive: true })
        writeFileSync(abs, text + "\n")
        path = showPath(abs, ctx)
      } catch {}
    }
    const saved = path ? ` It is saved at ${path}.` : ""
    if (!ctx.plan?.ask) return { output: nobodyToApprove(path), title: `${plan.title} · saved, not approved` }
    const r = await ctx.plan.ask({ path, text, plan }, ctx.callId)
    switch (r.kind) {
      case "approve":
        ctx.setMode?.(r.mode)
        return {
          output: `The user approved the plan.${saved} The permission mode is now ${r.mode}. Implement it now, phase by phase as written, keeping the plan current with plan_update: a task doing when you start it, done once you have checked it. If you find the plan wrong somewhere, say so and adjust rather than follow it into a mistake.`,
          title: `${plan.title} · approved → ${r.mode}`,
        }
      case "revise":
        return { output: `The user wants the plan revised: ${r.feedback}\nChange it with plan_write or plan_update, then call plan_submit again.`, title: `${plan.title} · revise` }
      case "back":
        return { output: `Before deciding, the user asks: "${r.text}"\nAnswer it in your reply, revise the plan if the answer changes it, then call plan_submit again.`, title: `${plan.title} · asked back` }
      case "dismissed":
        return { output: `The user closed the plan without deciding. Stay in plan mode; say the plan is ready${saved} and wait.`, title: `${plan.title} · not decided` }
    }
  },
})
