// The plan as a structure (harness spec 1.1.0, shared with LLeMbas: services/plans.py), kept per
// session by the engine, written whole by plan_write, changed by plan_update, shown as a card in
// every UI and put into the prompt on every step while it exists.
//
// Three rules hold it up. `steps` is always written, flattened from every phase's tasks in order.
// `normalise` is the only reader: a loose shape a small model sends — a bare string for a task, a
// `{title, steps}` list, one phase sent without the array — becomes the one shape everything
// downstream knows. Ids are generated here and never chosen by the model: letting it name them
// would mean validating names it made up, and a collision would silently re-tick a different task.
// harness/conformance/plan.json is the contract for all three operations.

export const VERSION = 2

// Bounds. A plan is read by a person and injected into every request while the work is going on,
// so "as many as you like" costs the window forever and buries the four items that mattered.
export const MAX_PHASES = 8
export const MAX_TASKS = 12
export const MAX_OBJECTIVES = 8
export const MAX_FINDINGS = 20
export const MAX_TEXT = 300
export const MAX_TITLE = 120

export const TASK_STATUSES = ["todo", "doing", "done", "dropped"] as const
export const OBJECTIVE_STATUSES = ["open", "done", "dropped"] as const
export const PHASE_STATUSES = ["pending", "active", "done"] as const

export type TaskStatus = (typeof TASK_STATUSES)[number]
export type ObjectiveStatus = (typeof OBJECTIVE_STATUSES)[number]
export type PhaseStatus = (typeof PHASE_STATUSES)[number]

export interface Finding {
  id: string
  text: string
}
export interface Objective {
  id: string
  text: string
  status: ObjectiveStatus
}
export interface Task {
  id: string
  text: string
  status: TaskStatus
  /** Why it was dropped, or what came of it. */
  note: string
}
export interface Phase {
  id: string
  title: string
  status: PhaseStatus
  tasks: Task[]
}
export interface Plan {
  version: number
  title: string
  summary: string
  findings: Finding[]
  objectives: Objective[]
  phases: Phase[]
  /** Every task's text in order — what a reader that knows nothing of phases gets. */
  steps: string[]
}

/** The former todo tool's statuses, as the plan's (the spec's one argument conversion). */
export const TODO_STATUSES: Record<string, TaskStatus> = { pending: "todo", in_progress: "doing", completed: "done", cancelled: "dropped" }

type Loose = Record<string, unknown>

/** Whitespace collapsed, cut at `limit`; nothing for nothing (Python's `str(value or "")`). */
function text(value: unknown, limit = MAX_TEXT): string {
  return (value ? String(value) : "").split(/\s+/).filter(Boolean).join(" ").slice(0, limit)
}

function status<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const wanted = (value ? String(value) : "").trim().toLowerCase()
  return (allowed as readonly string[]).includes(wanted) ? (wanted as T) : fallback
}

/** A list, from a list or from the one thing a model sent instead: a small model sends something
 *  close to the schema rather than the schema, and refusing costs a round trip to say so. */
function listed(value: unknown): unknown[] {
  if (value === null || value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

const isObject = (v: unknown): v is Loose => !!v && typeof v === "object" && !Array.isArray(v)

// --- Reading -----------------------------------------------------------------------------------

/** What plan_write stores for what a model sent. `{}` for nothing. A `{title, steps}` list becomes
 *  one phase called "Plan" whose tasks are the steps. */
export function normalise(raw: unknown): Plan | Record<string, never> {
  if (!isObject(raw) || Object.keys(raw).length === 0) return {}

  const title = text(raw.title, MAX_TITLE) || "A plan"
  const findings: Finding[] = listed(raw.findings)
    .slice(0, MAX_FINDINGS)
    .map((item, i) => ({ id: `f${i + 1}`, text: text(isObject(item) ? item.text : item) }))
    .filter((f) => f.text)

  const objectives: Objective[] = []
  listed(raw.objectives)
    .slice(0, MAX_OBJECTIVES)
    .forEach((item, i) => {
      const source: Loose = isObject(item) ? item : { text: item }
      const t = text(source.text)
      if (t) objectives.push({ id: `o${i + 1}`, text: t, status: status(source.status, OBJECTIVE_STATUSES, "open") })
    })

  let phases = readPhases(raw)
  if (!phases.length) {
    // Version 1, or a model that sent only steps: one phase, so nothing else sees the older shape.
    const tasks = listed(raw.steps)
      .map((s) => text(s))
      .filter(Boolean)
      .slice(0, MAX_TASKS)
    phases = [{ id: "p1", title: "Plan", status: "pending", tasks: tasks.map((t, i) => ({ id: `t${i + 1}`, text: t, status: "todo", note: "" })) }]
  }

  const plan: Plan = { version: VERSION, title, summary: text(raw.summary), findings, objectives, phases, steps: [] }
  plan.steps = flatten(plan)
  return plan
}

function readPhases(raw: Loose): Phase[] {
  const out: Phase[] = []
  let counter = 0
  listed(raw.phases)
    .slice(0, MAX_PHASES)
    .forEach((item, i) => {
      const source: Loose = isObject(item) ? item : { title: item }
      const tasks: Task[] = []
      for (const entry of listed(source.tasks).slice(0, MAX_TASKS)) {
        const got: Loose = isObject(entry) ? entry : { text: entry }
        const t = text(got.text)
        if (!t) continue
        counter++
        tasks.push({ id: `t${counter}`, text: t, status: status(got.status, TASK_STATUSES, "todo"), note: text(got.note) })
      }
      const title = text(source.title, MAX_TITLE)
      if (!title && !tasks.length) return
      out.push({ id: `p${i + 1}`, title: title || `Phase ${i + 1}`, status: status(source.status, PHASE_STATUSES, "pending"), tasks })
    })
  return out
}

/** Whether normalise gave a plan (it gives `{}` for nothing). */
export const isPlan = (p: Plan | Record<string, never>): p is Plan => "version" in p

/** Every task, in order, as plain sentences. */
export function flatten(plan: { phases?: Phase[] }): string[] {
  return (plan.phases ?? []).flatMap((p) => p.tasks.map((t) => t.text))
}

/** The former todo tool's list as a plan: one phase called "Work", active while anything is
 *  being done; a bare string is a pending item. `{}` for an empty list. */
export function fromTodos(items: unknown): Plan | Record<string, never> {
  const tasks: Task[] = []
  listed(items)
    .slice(0, MAX_TASKS)
    .forEach((item, i) => {
      const source: Loose = isObject(item) ? item : { content: item }
      const t = text("content" in source ? source.content : source.text)
      if (!t) return
      const s = (source.status ? String(source.status) : "pending").trim().toLowerCase()
      tasks.push({ id: `t${i + 1}`, text: t, status: TODO_STATUSES[s] ?? "todo", note: "" })
    })
  if (!tasks.length) return {}
  const plan: Plan = {
    version: VERSION,
    title: "Work",
    summary: "",
    findings: [],
    objectives: [],
    phases: [{ id: "p1", title: "Work", status: tasks.some((t) => t.status === "doing") ? "active" : "pending", tasks }],
    steps: [],
  }
  plan.steps = flatten(plan)
  return plan
}

// --- Changing ----------------------------------------------------------------------------------

export interface PlanChanges {
  tasks?: { id: string; status?: string; note?: string }[]
  objectives?: { id: string; status?: string }[]
  phases?: { id: string; status?: string }[]
  add_tasks?: { phase: string; text: string; after?: string }[]
  add_findings?: string[]
}

const ids = (list: { id: string }[]) => list.map((x) => x.id)
const unknown = (what: string, id: string, known: string[]) => `Unknown ${what} id "${id}". Known: ${known.join(", ") || "none"}.`
const badStatus = (value: unknown, what: string, allowed: readonly string[]) => `Unknown status "${value}" for ${what}. One of: ${allowed.join(", ")}.`
const number = (id: string) => Number(id.replace(/^\D+/, "")) || 0

/** plan_update's changes applied to a stored plan. Every id and status is checked first; on an
 *  error nothing changes, and the error names the known ids (the model quotes them from the plan
 *  it was shown). The plan given is not touched: the result is a new one. An addition past a
 *  bound (MAX_TASKS in a phase, MAX_FINDINGS) is left out, as LLeMbas leaves it out. */
export function apply(stored: Plan, changes: unknown): { plan: Plan } | { error: string } {
  const plan: Plan = structuredClone(stored)
  const c: PlanChanges = isObject(changes) ? (changes as PlanChanges) : {}
  const tasks = plan.phases.flatMap((p) => p.tasks)
  const phaseOf = new Map(plan.phases.flatMap((p) => p.tasks.map((t) => [t.id, p] as const)))
  const taskIds = ids(tasks)
  const phaseIds = ids(plan.phases)
  const objectiveIds = ids(plan.objectives)
  const id = (v: unknown) => (v ? String(v) : "").trim()
  const lower = (v: unknown) => String(v).trim().toLowerCase()
  const has = (allowed: readonly string[], v: unknown) => allowed.includes(lower(v))

  const taskChanges = listed(c.tasks).filter(isObject) as NonNullable<PlanChanges["tasks"]>
  const phaseChanges = listed(c.phases).filter(isObject) as NonNullable<PlanChanges["phases"]>
  const objectiveChanges = listed(c.objectives).filter(isObject) as NonNullable<PlanChanges["objectives"]>
  const added = listed(c.add_tasks).filter(isObject) as NonNullable<PlanChanges["add_tasks"]>
  const findings = listed(c.add_findings).map((f) => text(isObject(f) ? f.text : f))

  // Everything is checked before anything is touched.
  for (const t of taskChanges) {
    if (!taskIds.includes(id(t.id))) return { error: unknown("task", id(t.id), taskIds) }
    if (t.status !== undefined && t.status !== null && !has(TASK_STATUSES, t.status)) return { error: badStatus(t.status, "a task", TASK_STATUSES) }
  }
  for (const p of phaseChanges) {
    if (!phaseIds.includes(id(p.id))) return { error: unknown("phase", id(p.id), phaseIds) }
    if (p.status !== undefined && p.status !== null && !has(PHASE_STATUSES, p.status)) return { error: badStatus(p.status, "a phase", PHASE_STATUSES) }
  }
  for (const o of objectiveChanges) {
    if (!objectiveIds.includes(id(o.id))) return { error: unknown("objective", id(o.id), objectiveIds) }
    if (o.status !== undefined && o.status !== null && !has(OBJECTIVE_STATUSES, o.status)) return { error: badStatus(o.status, "an objective", OBJECTIVE_STATUSES) }
  }
  for (const a of added) {
    if (!phaseIds.includes(id(a.phase))) return { error: unknown("phase", id(a.phase), phaseIds) }
    if (id(a.after) && !taskIds.includes(id(a.after))) return { error: unknown("task", id(a.after), taskIds) }
    if (!text(a.text)) return { error: "A new task needs its text." }
  }

  for (const t of taskChanges) {
    const task = tasks.find((x) => x.id === id(t.id))!
    if (t.status !== undefined && t.status !== null) task.status = lower(t.status) as TaskStatus
    if (t.note !== undefined && t.note !== null) task.note = text(t.note)
  }
  for (const o of objectiveChanges) if (o.status !== undefined && o.status !== null) plan.objectives.find((x) => x.id === id(o.id))!.status = lower(o.status) as ObjectiveStatus
  for (const p of phaseChanges) if (p.status !== undefined && p.status !== null) plan.phases.find((x) => x.id === id(p.id))!.status = lower(p.status) as PhaseStatus

  // New ids continue after the highest existing one, in the order given; a task goes after the
  // one named when that is in the phase, else at the phase's end.
  let next = Math.max(0, ...taskIds.map(number))
  for (const a of added) {
    const phase = plan.phases.find((x) => x.id === id(a.phase))!
    if (phase.tasks.length >= MAX_TASKS) continue
    const task: Task = { id: `t${++next}`, text: text(a.text), status: "todo", note: "" }
    const after = id(a.after)
    const at = after && phaseOf.get(after)?.id === phase.id ? phase.tasks.findIndex((x) => x.id === after) : -1
    if (at >= 0) phase.tasks.splice(at + 1, 0, task)
    else phase.tasks.push(task)
  }
  let nextFinding = Math.max(0, ...plan.findings.map((f) => number(f.id)))
  for (const f of findings) {
    if (!f || plan.findings.length >= MAX_FINDINGS) continue
    plan.findings.push({ id: `f${++nextFinding}`, text: f })
  }

  plan.steps = flatten(plan)
  return { plan }
}

// --- Showing -----------------------------------------------------------------------------------

export const TASK_MARK: Record<TaskStatus, string> = { todo: "[ ]", doing: "[>]", done: "[x]", dropped: "[~]" }

/** The plan as text with its ids shown — what the model reads back from plan_write, what goes
 *  into the prompt, and what the plan card draws. */
export function render(plan: Plan): string {
  const lines = [`# ${plan.title}`]
  if (plan.summary) lines.push(plan.summary)
  if (plan.findings.length) lines.push(`Findings: ${plan.findings.map((f) => `[${f.id}] ${f.text}`).join("; ")}`)
  if (plan.objectives.length) lines.push(`Objectives: ${plan.objectives.map((o) => `[${o.id}] ${o.text} (${o.status})`).join("; ")}`)
  for (const p of plan.phases) {
    lines.push(`## ${p.id} ${p.title} (${p.status})`)
    for (const t of p.tasks) lines.push(`[${t.id}] ${TASK_MARK[t.status]} ${t.text}${t.note ? ` — ${t.note}` : ""}`)
  }
  return lines.join("\n")
}

/** Done against what is still to do: dropped tasks count for neither. */
export function progress(plan: Plan): { done: number; total: number } {
  const tasks = plan.phases.flatMap((p) => p.tasks)
  return { done: tasks.filter((t) => t.status === "done").length, total: tasks.filter((t) => t.status !== "dropped").length }
}

/** Whether anything on the plan is still to be done — the panel shows while this holds. */
export function open(plan: Plan): boolean {
  return plan.phases.some((p) => p.tasks.some((t) => t.status === "todo" || t.status === "doing"))
}

export interface SummaryLine {
  status: TaskStatus
  text: string
}

/** The digest for the panel above the prompt, at most six lines: the active phase and the count
 *  on the first, then the task being done, what is next, and the last two done. */
export function summary(plan: Plan): { head: string; lines: SummaryLine[] } {
  const { done, total } = progress(plan)
  const phase = plan.phases.find((p) => p.status === "active") ?? plan.phases.find((p) => p.tasks.some((t) => t.status === "doing" || t.status === "todo"))
  const head = `plan ${done}/${total}${phase && plan.phases.length > 1 ? ` · ${phase.title}` : ` · ${plan.title}`}`
  const tasks = plan.phases.flatMap((p) => p.tasks)
  const order = [...tasks.filter((t) => t.status === "doing"), ...tasks.filter((t) => t.status === "todo"), ...tasks.filter((t) => t.status === "done").slice(-2)]
  return { head, lines: order.slice(0, 5).map((t) => ({ status: t.status, text: t.text })) }
}
