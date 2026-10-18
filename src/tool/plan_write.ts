// plan_write: the plan for this work, written whole (it replaces the previous one). The structure,
// its ids and bounds are src/plan/plan.ts; the engine keeps the plan per session and puts it into
// the prompt on every step while it exists.
import { z } from "zod"
import { described } from "../harness.ts"
import { isPlan, normalise, OBJECTIVE_STATUSES, PHASE_STATUSES, progress, render, TASK_STATUSES, type Plan } from "../plan/plan.ts"
import { defineTool, ToolError } from "./tool.ts"

// Small models send a task as a bare string, a phase as its title, a finding as `{text}`: all of
// it is accepted here and read by normalise, as LLeMbas does.
const asText = (v: unknown) => (v && typeof v === "object" && "text" in v ? String((v as { text: unknown }).text ?? "") : v)
const asItem = (v: unknown) => (typeof v === "string" ? { text: v } : v)
const asPhase = (v: unknown) => (typeof v === "string" ? { title: v, tasks: [] } : v)
const asList = (v: unknown) => (v === undefined || v === null || Array.isArray(v) ? v : [v])

export const planWriteSchema = z.object({
  title: z.string().min(1).max(120),
  summary: z.string().max(300).optional(),
  findings: z.preprocess(asList, z.array(z.preprocess(asText, z.string().max(300))).max(20)).optional(),
  objectives: z
    .preprocess(asList, z.array(z.preprocess(asItem, z.object({ text: z.string().min(1).max(300), status: z.enum(OBJECTIVE_STATUSES).default("open") }))).max(8))
    .optional(),
  phases: z.preprocess(
    asList,
    z
      .array(
        z.preprocess(
          asPhase,
          z.object({
            title: z.string().max(120).optional(),
            status: z.enum(PHASE_STATUSES).default("pending"),
            tasks: z.preprocess(asList, z.array(z.preprocess(asItem, z.object({ text: z.string().min(1).max(300), status: z.enum(TASK_STATUSES).default("todo"), note: z.string().max(300).optional() }))).max(12)),
          }),
        ),
      )
      .max(8),
  ),
})

/** The tool's title line: how much of the plan is done. */
export const planTitle = (plan: Plan) => {
  const { done, total } = progress(plan)
  return `${done}/${total} done`
}

export const planWriteTool = defineTool({
  ...described("plan_write"),
  purpose: false,
  access: "plan",
  schema: planWriteSchema,
  permission: () => ({ permission: "plan", class: "interact", patterns: ["*"] }),
  async run(a, ctx) {
    const plan = normalise(a)
    if (!isPlan(plan)) throw new ToolError("The plan is empty: give it a title and at least one phase with tasks.")
    ctx.plan?.set(plan)
    return { output: render(plan), title: planTitle(plan) }
  },
})
