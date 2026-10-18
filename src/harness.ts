// The harness spec (harness/, shared with LLeMbas): its version and its tools, embedded at build
// time. The spec is the source of every tool's name, description and parameters as the model sees
// them; the code validates with its own zod schema, and tests/harness.test.ts keeps the two equal.
import VERSION from "../harness/VERSION" with { type: "text" }
import PURPOSE from "../harness/purpose.json"
import LOOP_JSON from "../harness/loop.json"
import t_apply_patch from "../harness/tools/apply_patch.json"
import t_ask_user from "../harness/tools/ask_user.json"
import t_bash from "../harness/tools/bash.json"
import t_bash_kill from "../harness/tools/bash_kill.json"
import t_bash_list from "../harness/tools/bash_list.json"
import t_bash_output from "../harness/tools/bash_output.json"
import t_decisions from "../harness/tools/decisions.json"
import t_edit from "../harness/tools/edit.json"
import t_glob from "../harness/tools/glob.json"
import t_grep from "../harness/tools/grep.json"
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
  argument_aliases?: Record<string, string>
  /** `{{name}}` in the description: a fact the projects differ in, filled in by each (fillDescription). */
  variables?: Record<string, string>
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
} = LOOP_JSON

/** The `purpose` argument (harness/purpose.json). */
export const PURPOSE_DEF: { name: string; schema: Record<string, unknown> } = PURPOSE

/** A description with its `{{variables}}` filled in. A variable left unfilled is an error: it
 *  would reach the model as a literal `{{name}}`. */
export function fillDescription(description: string, vars: Record<string, string>): string {
  return description.replace(/\{\{(\w+)\}\}/g, (m, k: string) => {
    if (!Object.hasOwn(vars, k)) throw new Error(`harness: no value for {{${k}}} in a tool description`)
    return vars[k]!
  })
}

export const TOOL_SPECS: Record<string, ToolSpecDef> = Object.fromEntries(
  ([t_apply_patch, t_ask_user, t_bash, t_bash_kill, t_bash_list, t_bash_output, t_decisions, t_edit, t_glob, t_grep, t_knowledge_get, t_knowledge_search, t_list, t_memory, t_multiedit, t_note_manage, t_note_view, t_notes_search, t_plan_submit, t_plan_update, t_plan_write, t_read, t_session_search, t_settings, t_skill_manage, t_skill_view, t_skills_list, t_task, t_tasks, t_view_image, t_web_fetch, t_web_search, t_write] as ToolSpecDef[]).map((t) => [t.name, t]),
)

/** A tool's name and description as the spec has them, for its definition: `...described("read")`. */
export function described(name: string): { name: string; description: string } {
  const t = TOOL_SPECS[name]
  if (!t) throw new Error(`harness: no tool ${name} in the spec`)
  return { name: t.name, description: t.description }
}
