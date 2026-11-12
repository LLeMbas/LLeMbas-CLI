// The harness spec (harness/, shared with LLeMbas): its version and its tools, embedded at build
// time. The spec is the source of every tool's name, description and parameters as the model sees
// them; the code validates with its own zod schema, and tests/harness.test.ts keeps the two equal.
import VERSION from "../harness/VERSION" with { type: "text" }
import PURPOSE from "../harness/purpose.json"
import LOOP_JSON from "../harness/loop.json"
import t_apply_patch from "../harness/tools/apply_patch.json"
import t_ask_user from "../harness/tools/ask_user.json"
import t_bash from "../harness/tools/bash.json"
import t_branch from "../harness/tools/branch.json"
import t_commit from "../harness/tools/commit.json"
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
import t_merge from "../harness/tools/merge.json"
import t_mkdir from "../harness/tools/mkdir.json"
import t_multiedit from "../harness/tools/multiedit.json"
import t_mv from "../harness/tools/mv.json"
import t_note_manage from "../harness/tools/note_manage.json"
import t_note_view from "../harness/tools/note_view.json"
import t_notes_search from "../harness/tools/notes_search.json"
import t_phone_action from "../harness/tools/phone_action.json"
import t_plan_submit from "../harness/tools/plan_submit.json"
import t_plan_update from "../harness/tools/plan_update.json"
import t_plan_write from "../harness/tools/plan_write.json"
import t_pr from "../harness/tools/pr.json"
import t_python from "../harness/tools/python.json"
import t_read from "../harness/tools/read.json"
import t_recall from "../harness/tools/recall.json"
import t_release from "../harness/tools/release.json"
import t_report from "../harness/tools/report.json"
import t_rm from "../harness/tools/rm.json"
import t_search from "../harness/tools/search.json"
import t_session_search from "../harness/tools/session_search.json"
import t_settings from "../harness/tools/settings.json"
import t_show from "../harness/tools/show.json"
import t_skill_manage from "../harness/tools/skill_manage.json"
import t_skill_view from "../harness/tools/skill_view.json"
import t_skills_list from "../harness/tools/skills_list.json"
import t_tag from "../harness/tools/tag.json"
import t_task from "../harness/tools/task.json"
import t_tasks from "../harness/tools/tasks.json"
import t_team_add from "../harness/tools/team_add.json"
import t_team_read from "../harness/tools/team_read.json"
import t_team_send from "../harness/tools/team_send.json"
import t_team_stop from "../harness/tools/team_stop.json"
import t_team_assign from "../harness/tools/team_assign.json"
import t_team_decide from "../harness/tools/team_decide.json"
import t_team_findings from "../harness/tools/team_findings.json"
import t_team_finish from "../harness/tools/team_finish.json"
import t_team_replace from "../harness/tools/team_replace.json"
import t_team_request from "../harness/tools/team_request.json"
import t_team_whoami from "../harness/tools/team_whoami.json"
import t_view_image from "../harness/tools/view_image.json"
import t_web_fetch from "../harness/tools/web_fetch.json"
import t_web_search from "../harness/tools/web_search.json"
import t_write from "../harness/tools/write.json"
import { fillPrompt } from "./prompt/fill.ts"

export interface ToolSpecDef {
  name: string
  /** shared: both projects implement it; cli / llembas: only that one does. */
  scope: "shared" | "cli" | "llembas"
  /** Spec 3.0.0: where it is offered — a chat on the server (its file system), an agent session
   *  on a device (this CLI, on its own disk), or both. */
  sessions: "chat" | "agent" | "both"
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
  /** `subagent`: offered only to a subagent (report, team_finish, team_request), never to a
   *  session's own model; `main` (spec 3.4.0): only to the main agent, never to a subagent. */
  offered?: "subagent" | "main"
  argument_aliases?: Record<string, string>
  /** Spec 3.0.0: what must hold for it to be offered — `display` (the session is shown where a file
   *  can be opened: over the link, to a client that offers `show`), `page`, `forge` (the chat's);
   *  `plan` (3.1.0): plan mode. From 3.1.0 one that can come and go during a session does not
   *  leave the tool out: it is offered and answers `unavailable` while unmet (context.md §10).
   *  `team` (3.2.0): the team setting allows more than one agent (harness/team.md §2). `phone`
   *  (3.6.0): a message came from the LLeMbas app on the person's phone (harness/phone.md) — the
   *  server's alone. */
  requires?: ("display" | "page" | "forge" | "plan" | "team" | "phone")[]
  /** What a call answers, word for word, when a requirement went away after the offer. */
  unavailable?: string
  /** Spec 3.7.0: a tool's other fixed answers, by key (python: no_answer, timeout). */
  texts?: Record<string, string>
  /** `always`: put to the person in every mode, auto included; never remembered. */
  confirm?: "always"
  /** `{{name}}` in the description: a fact the projects differ in, filled in by each (fillDescription). */
  variables?: Record<string, string>
  /** What a project offers of the parameters, where it offers less than all (narrowParameters). */
  narrow?: Partial<Record<"cli" | "llembas", Narrow>>
  description: string
  parameters: Record<string, unknown>
}

/** `X.Y.Z`, or a SemVer pre-release while the spec is written ahead of both implementations
 *  (`3.0.0-draft`). */
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
  /** Subagents (spec 3.3.0, harness/subagents.md): the model refusals, what names a model, and how
   *  the size setting is shown. */
  subagents: {
    texts: { not_named: string; same_group: string; one_request: string }
    named: { before: string; after: string }
    setting: { label: string; min: string; max: string; hint: string; short: string; own: string }
  }
  /** Teams (spec 3.2.0, harness/team.md): the size setting, names, marks, texts. */
  team: {
    agents: { min: number; max: number; cap: number }
    names: { pattern: string; lead: string; reserved: string[]; parent: string; id_prefix: string }
    marks: { message: string; report: string; assignment: string; request: string; decision: string; context_full: string }
    unavailable: { one_agent: string; one_request: string }
    work: { write: string[]; execute: string[]; kept: string[] }
    read_max: number
    texts: Record<
      | "added" | "added_waiting" | "added_under" | "added_waiting_under" | "sent" | "stopped" | "manager" | "full" | "bad_name" | "all_name" | "taken" | "no_goal" | "unknown" | "self" | "nobody" | "not_yours" | "nobody_to_stop" | "no_report" | "ended"
      // Spec 3.4.0 (subagents.md §5–§13).
      | "only_main" | "not_manager" | "wider" | "request_not_narrower" | "request_kind" | "requestable" | "not_delegated" | "not_requestable" | "requested" | "no_request" | "decided" | "allowed" | "refused" | "decision_allowed" | "decision_refused" | "no_parent" | "finished" | "has_ended" | "cycle" | "assigned" | "replaced" | "replace_brief" | "no_findings" | "noted" | "not_yours_findings" | "context_full" | "gone" | "request_body",
      string
    >
    read: {
      tree: string
      agent: string
      lead_role: string
      states: Record<"working" | "waiting" | "finished" | "idle" | "paused" | "done" | "out_of_context" | "stopped", string>
      active: string
      room: string
      message: string
      report: string
      none: string
      more: string
      slots: string
      ended: string
      ended_agent: string
      context: string
      request: string
    }
    /** Spec 3.4.0. */
    main_only: { tools: string[] }
    context: { pause_at: number; final_steps: number }
    request: { kinds: string[]; id_prefix: string }
    whoami: { lines: Record<"who" | "parent" | "task" | "mode" | "request" | "model" | "limits" | "spawn_yes" | "spawn_no" | "context", string> }
    findings: { header: string; item: string }
  }
  /** Scheduled work on a linked computer (spec 3.5.0, acp.md): the setting, the modes, the
   *  approval wait, the sentinel, the watch command's limits, the refusals. */
  scheduled: {
    setting: { key: string; label: string; hint: string }
    modes: string[]
    default_mode: string
    approval_wait_seconds: { default: number; min: number; max: number }
    sentinel: string
    statuses: string[]
    monitor: { timeout_seconds: { default: number; min: number; max: number }; excerpt_chars: number; output_max_bytes: number }
    texts: Record<"off" | "plan" | "denied" | "monitor_asks" | "monitor_denied" | "no_reply", string>
  }
  /** Display (spec 3.7.0, harness/display.md): a tool call's title, states and facts, the blocks,
   *  the phases that end a reply, what each card offers. */
  display: {
    title: { questions_join: string; patch_files: string[]; patch_join: string; keys: string[] }
    states: string[]
    no_duration: string[]
    duration: { tenths_under_seconds: number }
    change: string
    exit: string
    hits: string
    hit: string
    blocks: string[]
    not_drawn: string[]
    end: string[]
    actions: {
      approval: Record<"once" | "always" | "deny" | "deny_reason", string>
      question: Record<"something_else", string>
      plan: Record<"approve_edit" | "approve_manual" | "revise", string>
    }
    plain: { group: string; decimal: string }
  }
  /** Progress (spec 3.4.0, harness/progress.md): the phases, their texts, the line. */
  progress: {
    phases: string[]
    texts: Record<string, string>
    reason: Record<string, string>
    what: Record<string, string>
    stopped_reason: Record<string, string>
    line: string
    no_elapsed: string[]
    what_max: number
    pace_per_second: number
  }
  /** Context hygiene (spec 3.0.0, harness/context.md): the result ids, the texts of a read's
   *  header, a stub, the elided line, recall; the output cap; what is deduplicated; the table
   *  compaction adds. */
  context: {
    ids: { digits: number }
    read_header: string
    read_header_empty: string
    edit_header: string
    header: string
    unchanged: string
    same_result: string
    elided: string
    created: string
    no_result: string
    recall_header: string
    sha_digits: number
    cap: { max_lines: number; max_chars: number; head_lines: number; head_chars: number; tail_lines: number; tail_chars: number }
    dedupe: { by_hash: string[]; by_result: string[] }
    compaction: { heading: string; line: string; rows: number }
    reasoning: string
    /** The environment block's lines about where an agent session works (spec 3.2.0, §11). */
    env: { project: string; started: string }
    /** A note on the next user message (spec 3.1.0, context.md §10): its tags and its lines, in
     *  the order they are said. */
    note: { open: string; close: string; date: string; mode: string; plan: string; memory: string; instructions: string; personality: string; mcp: string; empty: string
      /** What a note names the person's own instructions by (the instructions block's `{{path}}`). */
      personal: string
      /** For a chat, whose modes have no text of their own; the CLI says modes/<mode>.md. */
      plan_ended: string
      /** For a chat, which does not resend earlier tool results; the CLI's model has them. */
      plan_own: string
      /** Spec 3.2.0 (team.md §10): the size setting, said to the lead. */
      team: string
      team_lead: string
      team_one: string
      team_stopped: string
      /** Spec 3.3.0 (subagents.md §4): the session's model cannot serve subagents itself. */
      team_own: string
    }
    /** How long a session waits for its configured MCP servers before its first request. */
    mcp_wait_ms: number
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
  ([t_apply_patch, t_ask_user, t_bash, t_branch, t_commit, t_decisions, t_edit, t_glob, t_grep, t_job_list, t_job_output, t_job_send, t_job_stop, t_knowledge_get, t_knowledge_search, t_list, t_memory, t_merge, t_mkdir, t_multiedit, t_mv, t_note_manage, t_note_view, t_notes_search, t_phone_action, t_plan_submit, t_plan_update, t_plan_write, t_pr, t_python, t_read, t_recall, t_release, t_report, t_rm, t_search, t_session_search, t_settings, t_show, t_skill_manage, t_skill_view, t_skills_list, t_tag, t_task, t_tasks, t_team_add, t_team_assign, t_team_decide, t_team_findings, t_team_finish, t_team_read, t_team_replace, t_team_request, t_team_send, t_team_stop, t_team_whoami, t_view_image, t_web_fetch, t_web_search, t_write] as ToolSpecDef[]).map((t) => [t.name, t]),
)

/** Whether the spec gives a tool to this CLI: not the server's alone (`scope: llembas`), and
 *  offered in an agent session (`sessions` agent or both) — a chat's tools over the server's tree
 *  (mkdir, mv, rm, search, python, the forge verbs) are not the CLI's. */
export function forCli(t: ToolSpecDef): boolean {
  return t.scope !== "llembas" && t.sessions !== "chat"
}

/** A tool's name, description and `exclusive` flag as the spec has them, for its definition:
 *  `...described("read")`. With `vars`, the description filled and the values kept for its
 *  parameters (toSpec). */
export function described(name: string, vars?: Record<string, string>): { name: string; description: string; exclusive: boolean; vars?: Record<string, string> } {
  const t = TOOL_SPECS[name]
  if (!t) throw new Error(`harness: no tool ${name} in the spec`)
  return vars ? { name: t.name, description: fillDescription(t.description, vars), exclusive: t.exclusive, vars } : { name: t.name, description: t.description, exclusive: t.exclusive }
}
