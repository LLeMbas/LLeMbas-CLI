// plan_update: the plan changed as the work goes — a task marked doing or done, one dropped with
// why, work added, a finding recorded. Several changes in one call; an unknown id is an error
// naming the known ones, and then nothing changes (src/plan/plan.ts apply).
import { z } from "zod"
import { described } from "../harness.ts"
import { apply, OBJECTIVE_STATUSES, PHASE_STATUSES, render, TASK_STATUSES } from "../plan/plan.ts"
import { planTitle } from "./plan_write.ts"
import { defineTool } from "./tool.ts"

const asList = (v: unknown) => (v === undefined || v === null || Array.isArray(v) ? v : [v])

export const planUpdateSchema = z.object({
  tasks: z.preprocess(asList, z.array(z.object({ id: z.string().min(1), status: z.enum(TASK_STATUSES).optional(), note: z.string().max(300).optional() }))).optional(),
  objectives: z.preprocess(asList, z.array(z.object({ id: z.string().min(1), status: z.enum(OBJECTIVE_STATUSES) }))).optional(),
  phases: z.preprocess(asList, z.array(z.object({ id: z.string().min(1), status: z.enum(PHASE_STATUSES) }))).optional(),
  add_tasks: z.preprocess(asList, z.array(z.object({ phase: z.string().min(1), text: z.string().min(1).max(300), after: z.string().optional() }))).optional(),
  add_findings: z.preprocess(asList, z.array(z.string().min(1).max(300))).optional(),
})

export const planUpdateTool = defineTool({
  ...described("plan_update"),
  purpose: false,
  access: "plan",
  schema: planUpdateSchema,
  permission: () => ({ permission: "plan", class: "interact", patterns: ["*"] }),
  async run(a, ctx) {
    const current = ctx.plan?.get()
    if (!current) return { output: "There is no plan to update. Write one with plan_write first.", isError: true }
    const r = apply(current, a)
    if ("error" in r) return { output: r.error, isError: true }
    ctx.plan?.set(r.plan)
    return { output: render(r.plan), title: planTitle(r.plan) }
  },
})
