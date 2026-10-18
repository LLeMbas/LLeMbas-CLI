// Tool names the harness spec (harness/, shared with LLeMbas) renamed in v1, read from the spec's
// `aliases.cli` and `argument_aliases`. A call under a former name — a stored session, an
// agent file, a model trained on the old name — runs the tool it now is. Only the CLI's own
// former names: LLeMbas's differ in their arguments too, and are LLeMbas's to read.
import { TOOL_SPECS } from "../harness.ts"
import { fromTodos, isPlan } from "../plan/plan.ts"

const RENAMED: Record<string, string> = {}
const ARGUMENTS_RENAMED: Record<string, Record<string, string>> = {}
for (const t of Object.values(TOOL_SPECS)) {
  // notes became three tools; which one depends on the call's action (below). todo took a
  // different argument (todos[]), converted below.
  for (const old of t.aliases.cli) if (old !== "notes") RENAMED[old] = t.name
  if (t.argument_aliases) ARGUMENTS_RENAMED[t.name] = t.argument_aliases
}

export function resolveCall(name: string, raw: unknown): { name: string; raw: unknown } {
  let to = RENAMED[name] ?? name
  let args = raw
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined
  // notes was one tool with an action; it is three now, by what the action does.
  if (name === "notes" && obj) {
    const { action, ...rest } = obj
    if (action === "search") to = "notes_search"
    else if (action === "get") to = "note_view"
    else to = "note_manage"
    args = to === "note_manage" ? obj : rest
  }
  // todo's list is one phase of the plan now (the spec's one argument conversion, conformance
  // plan.json `todos`): the whole plan is sent, as plan_write takes it.
  if (name === "todo" && obj) {
    const plan = fromTodos(obj.todos)
    args = isPlan(plan) ? { title: plan.title, phases: plan.phases.map((p) => ({ title: p.title, status: p.status, tasks: p.tasks.map((t) => ({ text: t.text, status: t.status })) })) } : { title: "Work", phases: [] }
  }
  const renamed = ARGUMENTS_RENAMED[to]
  if (renamed && args && typeof args === "object" && !Array.isArray(args)) {
    const a = { ...(args as Record<string, unknown>) }
    for (const [old, now] of Object.entries(renamed)) if (old in a) (a[now] ??= a[old], delete a[old])
    args = a
  }
  return { name: to, raw: args }
}

/** A tool list as written by hand (an agent file's `tools:`), with former names read as the new. */
export function canonicalToolNames(names: string[]): string[] {
  return [...new Set(names.flatMap((n) => (n === "notes" ? ["notes_search", "note_view", "note_manage"] : [RENAMED[n] ?? n])))]
}
