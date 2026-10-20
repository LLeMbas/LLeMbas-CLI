// The harness spec (harness/, shared with LLeMbas): its version and its tools, embedded at build
// time. The spec is the source of every tool's name, description and parameters as the model sees
// them; the code validates with its own zod schema, and tests/harness.test.ts keeps the two equal.
import VERSION from "../harness/VERSION" with { type: "text" }
import PURPOSE from "../harness/purpose.json"
import LOOP_JSON from "../harness/loop.json"
import t_apply_patch from "../harness/tools/apply_patch.json"
import t_ask_user from "../harness/tools/ask_user.json"
import t_bash from "../harness/tools/bash.json"
import t_decisions from "../harness/tools/decisions.json"
import t_edit from "../harness/tools/edit.json"
import t_glob from "../harness/tools/glob.json"
import t_grep from "../harness/tools/grep.json"
import t_job_list from "../harness/tools/job_list.json"
import t_job_output from "../harness/tools/job_output.json"
import t_job_send from "../harness/tools/job_send.json"
import t_job_stop from "../harness/tools/job_stop.json"
import t_knowledge_get from "../harness/tools/knowledge_get.json"
import t_knowledge_search from "../harness/tools/knowledge_search.json"
import t_list from "../harness/tools/list.json"
import t_memory from "../harness/tools/memory.json"
import t_multiedit from "../harness/tools/multiedit.json"
import t_note_manage from "../harness/tools/note_manage.json"
import t_note_view from "../harness/tools/note_view.json"
import t_notes_search from "../harness/tools/notes_search.json"
import t_plan_submit from "../harness/tools/plan_submit.json"
import t_plan_update from "../harness/tools/plan_update.json"
import t_plan_write from "../harness/tools/plan_write.json"
import t_read from "../harness/tools/read.json"
import t_report from "../harness/tools/report.json"
import t_session_search from "../harness/tools/session_search.json"
import t_settings from "../harness/tools/settings.json"
import t_skill_manage from "../harness/tools/skill_manage.json"
import t_skill_view from "../harness/tools/skill_view.json"
import t_skills_list from "../harness/tools/skills_list.json"
import t_task from "../harness/tools/task.json"
import t_tasks from "../harness/tools/tasks.json"
import t_view_image from "../harness/tools/view_image.json"
import t_web_fetch from "../harness/tools/web_fetch.json"
import t_web_search from "../harness/tools/web_search.json"
import t_write from "../harness/tools/write.json"
import { fillPrompt } from "./prompt/fill.ts"

export interface ToolSpecDef {
  name: string
  /** shared: both projects implement it; cli / llembas: only that one does. The execution tools
   *  (bash, edit, read…) are the CLI's: the web UI runs no agent of its own. */
  scope: "shared" | "cli" | "llembas"
  risk: "read" | "write" | "execute" | "interact"
  exclusive: boolean
  /** How a call is shown in a transcript: a shell command, an edit with its diff, a
   *  file read, a search with its hits, a web lookup, a delegated task, a plan change (not drawn:
   *  the plan card refreshes), hidden, or a plain tool line. Both projects draw the same kind the
   *  same way. */
  block: "shell" | "edit" | "read" | "search" | "web" | "task" | "plan" | "hidden" | "tool"
  /** Where a call says what it is for: the injected `purpose`, a field of its own, or none. */
  purpose: string | false
  /** Names each project used before spec v1; a call under one is read as this tool. */
  aliases: { cli: string[]; llembas: string[] }
  /** `subagent`: offered only to a subagent (report), never to a session's own model. */
  offered?: "subagent"
  argument_aliases?: Record<string, string>
  /** `{{name}}` in the description: a fact the projects differ in, filled in by each (fillDescription). */
  variables?: Record<string, string>
  /** What a project offers of the parameters, where it offers less than all (narrowParameters). */
  narrow?: Partial<Record<"cli" | "llembas", Narrow>>
  description: string
  parameters: Record<string, unknown>
}

export const HARNESS_VERSION = VERSION.trim()

/** How one prompt runs (harness/loop.json): the step backstop, the budgets' defaults, the wrap-up
 *  message, how often a reply that says nothing is asked again, how many calls run together. */
export const LOOP: {
  steps: { default: number }
  budgets: { wall_seconds: { cli: number | null; llembas: number | null }; output_bytes: { cli: number | null; llembas: number | null }; completion_tokens: { cli: number | null; llembas: number | null } }
  /** `message` holds `{{limit}}`: which limit was reached, as a phrase. */
  wrap_up: { message: string }
  nudges: { max: number }
  parallel: { max: number }
  /** Background work (spec 2.0.0): the marks every note begins with, and the caps. */
  jobs: {
    marks: { command: string; subagent: string; message: string; to_subagent: string }
    note_tail_chars: { default: number }
    finished_kept: { default: number }
    running_max: { default: number }
    subagent_steps: { default: number }
  }
} = LOOP_JSON

/** The `purpose` argument (harness/purpose.json). */
export const PURPOSE_DEF: { name: string; schema: Record<string, unknown> } = PURPOSE

/** A description with its `{{variables}}` filled in, by the prompt texts' rules (fillPrompt): a
 *  line that is only a bullet and a variable goes when the value is empty, and a variable left
 *  unfilled is an error — it would reach the model as a literal `{{name}}` (conformance: fill). */
export function fillDescription(description: string, vars: Record<string, string>): string {
  try {
    return fillPrompt(description, vars)
  } catch (e) {
    throw new Error(`harness: ${(e as Error).message.replace(/^prompt: /, "")} in a tool description`)
  }
}

/** A tool's parameters with every `description` in them filled the same way. */
export function fillParameters(parameters: Record<string, unknown>, vars: Record<string, string>): Record<string, unknown> {
  const walk = (o: unknown): unknown => {
    if (Array.isArray(o)) return o.map(walk)
    if (!o || typeof o !== "object") return o
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(o)) out[k] = k === "description" && typeof v === "string" ? fillDescription(v, vars) : walk(v)
    return out
  }
  return walk(parameters) as Record<string, unknown>
}

/** What one project offers of a shared tool's parameters: optional properties left out (`drop`),
 *  a property's values narrowed (`enum`). `a.b` is b inside a, `a[].b` b inside a's items. */
export interface Narrow {
  drop?: string[]
  enum?: Record<string, string[]>
}

export class NarrowError extends Error {
  constructor(readonly code: "required" | "unknown" | "not_subset", path: string) {
    super(`harness: cannot narrow ${path}: ${code}`)
  }
}

/** The parameters as a project offers them: a subset, never more and never retyped
 *  (conformance: narrow). The spec's own object is not changed. */
export function narrowParameters(parameters: Record<string, unknown>, narrow: Narrow = {}): Record<string, unknown> {
  const out = structuredClone(parameters)
  type Obj = { properties?: Record<string, Record<string, unknown>>; required?: string[]; items?: Obj }
  const locate = (path: string): { parent: Obj; key: string } => {
    let node = out as Obj
    const steps = path.split(".")
    for (const [i, raw] of steps.entries()) {
      const items = raw.endsWith("[]")
      const key = items ? raw.slice(0, -2) : raw
      const props = node.properties
      if (!props || !Object.hasOwn(props, key)) throw new NarrowError("unknown", path)
      if (i === steps.length - 1 && !items) return { parent: node, key }
      const next = props[key] as Obj
      node = items ? (next.items as Obj) : next
      if (!node) throw new NarrowError("unknown", path)
    }
    throw new NarrowError("unknown", path)
  }
  for (const path of narrow.drop ?? []) {
    const { parent, key } = locate(path)
    if (parent.required?.includes(key)) throw new NarrowError("required", path)
    delete parent.properties![key]
  }
  for (const [path, values] of Object.entries(narrow.enum ?? {})) {
    const { parent, key } = locate(path)
    const own = parent.properties![key]!.enum as unknown[] | undefined
    if (!own || !values.every((v) => own.includes(v))) throw new NarrowError("not_subset", path)
    parent.properties![key]!.enum = own.filter((v) => values.includes(v as string))
  }
  return out
}

export const TOOL_SPECS: Record<string, ToolSpecDef> = Object.fromEntries(
  ([t_apply_patch, t_ask_user, t_bash, t_decisions, t_edit, t_glob, t_grep, t_job_list, t_job_output, t_job_send, t_job_stop, t_knowledge_get, t_knowledge_search, t_list, t_memory, t_multiedit, t_note_manage, t_note_view, t_notes_search, t_plan_submit, t_plan_update, t_plan_write, t_read, t_report, t_session_search, t_settings, t_skill_manage, t_skill_view, t_skills_list, t_task, t_tasks, t_view_image, t_web_fetch, t_web_search, t_write] as ToolSpecDef[]).map((t) => [t.name, t]),
)

/** A tool's name, description and `exclusive` flag as the spec has them, for its definition:
 *  `...described("read")`. With `vars`, the description filled and the values kept for its
 *  parameters (toSpec). */
export function described(name: string, vars?: Record<string, string>): { name: string; description: string; exclusive: boolean; vars?: Record<string, string> } {
  const t = TOOL_SPECS[name]
  if (!t) throw new Error(`harness: no tool ${name} in the spec`)
  return vars ? { name: t.name, description: fillDescription(t.description, vars), exclusive: t.exclusive, vars } : { name: t.name, description: t.description, exclusive: t.exclusive }
}
