import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import { homedir, platform, release } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { LOOP } from "../harness.ts"
import type { Mode } from "../config/schema.ts"
import { expandHome, paths } from "../config/paths.ts"
import { render, type Plan } from "../plan/plan.ts"
import { fillPrompt } from "./fill.ts"
import defaultSystem from "../../harness/prompts/system/default.md" with { type: "text" }
import identity from "../../harness/prompts/system/identity.md" with { type: "text" }
import blockMemory from "../../harness/prompts/blocks/memory.md" with { type: "text" }
import blockSkills from "../../harness/prompts/blocks/skills.md" with { type: "text" }
import blockSkillsEmpty from "../../harness/prompts/blocks/skills-empty.md" with { type: "text" }
import blockAgentsMissing from "../../harness/prompts/blocks/agents-missing.md" with { type: "text" }
import blockAgentsGit from "../../harness/prompts/blocks/agents-git.md" with { type: "text" }
import blockAgentsKeep from "../../harness/prompts/blocks/agents-keep.md" with { type: "text" }
import blockLibrary from "../../harness/prompts/blocks/library.md" with { type: "text" }
import blockPrototypes from "../../harness/prompts/blocks/prototypes.md" with { type: "text" }
import blockSubagent from "../../harness/prompts/blocks/subagent.md" with { type: "text" }
import blockContext from "../../harness/prompts/blocks/context.md" with { type: "text" }
import blockTeamLead from "../../harness/prompts/blocks/team_lead.md" with { type: "text" }
import blockTeamMember from "../../harness/prompts/blocks/team_member.md" with { type: "text" }
import agentExplore from "../../harness/prompts/agents/explore.md" with { type: "text" }
import agentGeneral from "../../harness/prompts/agents/general.md" with { type: "text" }
import modeManual from "../../harness/prompts/modes/manual.md" with { type: "text" }
import modeEdit from "../../harness/prompts/modes/edit.md" with { type: "text" }
import modeAuto from "../../harness/prompts/modes/auto.md" with { type: "text" }
import modePlan from "../../harness/prompts/modes/plan.md" with { type: "text" }
import modeUnattended from "../../harness/prompts/modes/unattended.md" with { type: "text" }
import taskCompact from "../../harness/prompts/tasks/compact.md" with { type: "text" }
import taskReview from "../../harness/prompts/tasks/review.md" with { type: "text" }
import taskChangelog from "../../harness/prompts/tasks/changelog.md" with { type: "text" }
import taskContinue from "../../harness/prompts/tasks/continue.md" with { type: "text" }
import taskInit from "../../harness/prompts/tasks/init.md" with { type: "text" }
import familyAnthropic from "../../harness/prompts/family/anthropic.md" with { type: "text" }
import familyGpt from "../../harness/prompts/family/gpt.md" with { type: "text" }
import familyGemini from "../../harness/prompts/family/gemini.md" with { type: "text" }
import familyLocal from "../../harness/prompts/family/local.md" with { type: "text" }
import personalityConcise from "../../harness/prompts/personality/concise.md" with { type: "text" }
import personalityPragmatic from "../../harness/prompts/personality/pragmatic.md" with { type: "text" }
import personalityOptimistic from "../../harness/prompts/personality/optimistic.md" with { type: "text" }
import personalityFunny from "../../harness/prompts/personality/funny.md" with { type: "text" }
import personalityFormal from "../../harness/prompts/personality/formal.md" with { type: "text" }
import personalitySocratic from "../../harness/prompts/personality/socratic.md" with { type: "text" }

// Built-in prompt text, by path relative to harness/prompts (the harness spec shared with LLeMbas):
// every text whose scope is shared or cli. The server's own (blocks/workspace.md, a chat's view of
// its file system) is not here. Any of these can be replaced by a file at the same path under ~/.config/lembas/prompts/.
const BUILTIN: Record<string, string> = {
  "system/default.md": defaultSystem,
  "system/identity.md": identity,
  "blocks/memory.md": blockMemory,
  "blocks/skills.md": blockSkills,
  "blocks/skills-empty.md": blockSkillsEmpty,
  "blocks/agents-missing.md": blockAgentsMissing,
  "blocks/agents-git.md": blockAgentsGit,
  "blocks/agents-keep.md": blockAgentsKeep,
  "blocks/library.md": blockLibrary,
  "blocks/prototypes.md": blockPrototypes,
  "blocks/subagent.md": blockSubagent,
  "blocks/context.md": blockContext,
  "blocks/team_lead.md": blockTeamLead,
  "blocks/team_member.md": blockTeamMember,
  "agents/explore.md": agentExplore,
  "agents/general.md": agentGeneral,
  "modes/manual.md": modeManual,
  "modes/edit.md": modeEdit,
  "modes/auto.md": modeAuto,
  "modes/plan.md": modePlan,
  "modes/unattended.md": modeUnattended,
  "tasks/compact.md": taskCompact,
  "tasks/review.md": taskReview,
  "tasks/continue.md": taskContinue,
  "tasks/changelog.md": taskChangelog,
  "tasks/init.md": taskInit,
  "family/anthropic.md": familyAnthropic,
  "family/gpt.md": familyGpt,
  "family/gemini.md": familyGemini,
  "family/local.md": familyLocal,
  "personality/concise.md": personalityConcise,
  "personality/pragmatic.md": personalityPragmatic,
  "personality/optimistic.md": personalityOptimistic,
  "personality/funny.md": personalityFunny,
  "personality/formal.md": personalityFormal,
  "personality/socratic.md": personalitySocratic,
}

// Paths the harness spec renamed (v1): an override written under the old name still counts.
const RENAMED: Record<string, string> = { "modes/auto.md": "modes/unrestricted.md" }

export function promptText(rel: string): string {
  const override = [rel, RENAMED[rel]].filter((r): r is string => r !== undefined).map((r) => join(paths.config, "prompts", r)).find((f) => existsSync(f))
  const raw = override ? readFileSync(override, "utf8") : BUILTIN[rel]
  if (raw === undefined) throw new Error(`no prompt ${rel}`)
  return raw.replace(/<!--[\s\S]*?-->\n?/g, "").trim()
}

/** A plain replace, for the CLI's own task texts (compact, review) whose variables are whole
 *  sections. A spec text with variables goes through fillPrompt (fill.ts), which also drops a
 *  bullet whose variable is empty and refuses one left unfilled. */
export function fill(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (Object.hasOwn(vars, k) ? vars[k]! : m))
}

// What the CLI fills into system/default.md (harness/prompts/index.json says what each means):
// the facts the two projects differ in, not the design.
const INTRO = "Use the instructions below and the tools you have to help with software engineering and with running the project."
const SURFACE = "Your output is shown in a terminal and rendered as GitHub-flavoured markdown in a monospace font."
const FILE_TOOLS = "Use the dedicated tools for files: read (not cat), edit and write (not sed or heredocs), grep and glob (not find or grep in bash)."
const BACKGROUND = "A long-running command (a server, a watcher) runs with bash `background: true`; a foreground command still running at its timeout goes on in the background too. Read a job's output with job_output, list jobs with job_list, stop one with job_stop. A finished job or subagent announces itself to you: you are told when one ends, so do not poll."
// The two bullets a subagent does not get: it has no plan tools and nobody to ask (the spec's
// `plan_tools` and `ask_tool` variables of system/default.md).
const PLAN_TOOLS =
  "For work with three or more steps, write a plan with plan_write from the start and keep it current with plan_update as you go rather than at the end: mark a task doing when you start it and done once you have checked it works, drop one that turns out to be unnecessary, and add work the plan did not anticipate when you find it. The plan is what somebody reads to see where you are, so a plan updated only at the end is a report rather than a plan. If what you find makes the plan wrong rather than merely incomplete, say so and ask with ask_user rather than quietly planning something else."
const ASK_TOOL =
  "When a decision is genuinely the user's — a trade-off only they can weigh, a requirement the request leaves open — ask with ask_user: everything you need in one call, with the options you consider plausible and the one you would choose marked recommended. Do not ask what you can find out yourself."
/** `{{report}}` of blocks/subagent.md, when the subagent has the report tool. */
const SUBAGENT_REPORT = " Before that, the report tool sends the main agent a message — a finding it should act on at once, or a question you cannot settle yourself — and a message from it may reach you meanwhile."
/** `{{read_only}}` of blocks/subagent.md, in plan mode. */
const SUBAGENT_READ_ONLY = " You can read and search; you cannot change anything."
const GIT_SECTION = [
  "# Git",
  "- How git is used in this project — whether you commit on your own, and on which branch — is in the \"## Git\" section of its AGENTS.md. Follow it. Where nothing says, only commit, amend, push, tag or create branches when the user asks.",
  "- Before a commit, look at `git status`, `git diff` and recent `git log`, stage files by name, and write a message in the repository's style.",
  "- Never change git config, skip hooks, force-push or rewrite history unless the user explicitly asks.",
].join("\n")
/** Where a prototype is seen from a terminal (blocks/prototypes.md's {{prototype_surface}}). */
export const PROTOTYPE_SURFACE = "It is saved as a file you can open, and the LLeMbas web UI renders it live."

/** `{{plan_context}}`: the plan with its ids under a heading, and the sentence to work to it. */
export function planContext(plan: Plan | undefined): string {
  if (!plan) return ""
  return `### The current plan\n\n${render(plan)}\n\nThis is the plan as it stands now. Work to it, and quote the ids above rather than restating the plan in your answer.`
}

/** `{{knowledge_scope}}` (blocks/library.md): the sentence naming the bases a session may search,
 *  or "" where it may search them all. */
export function knowledgeScope(names: string[] | undefined): string {
  if (!names || !names.length) return ""
  return `Knowledge searches here cover only: ${names.join(", ")}. Finding nothing there means nothing is there, not that the library is empty.`
}

/** An `instructions` entry from config.yaml. A project's may only name files inside the project:
 *  a cloned repository must not be able to put ~/.ssh/… into what is sent to the model. */
export interface ExtraInstruction {
  path: string
  global: boolean
}

/** The names a directory's instruction file may have, in order of preference: one per directory. */
export const INSTRUCTION_NAMES = ["AGENTS.md", "CLAUDE.md"] as const

/** The stacked instruction chain (harness spec 3.0.0, filesystem.md *Instruction files, stacked*;
 *  conformance `instructions`): from the boundary down to the start directory, outermost first, each
 *  directory gives the first of AGENTS.md, CLAUDE.md that `readable` accepts — never both; one that is
 *  not readable is passed over and the walk goes on below it. A start outside the boundary is read as
 *  the boundary. Paths only, nothing read: the CLI answers `readable` from the disk, the conformance
 *  runner from a case's files and grants. */
export function instructionChain(boundary: string, start: string, readable: (path: string) => boolean): string[] {
  const top = resolve(boundary)
  let at = resolve(start)
  if (at !== top && !at.startsWith(top === sep ? top : top + sep)) at = top
  const dirs: string[] = []
  for (let d = at; ; d = dirname(d)) {
    dirs.unshift(d)
    if (d === top || dirname(d) === d) break
  }
  const out: string[] = []
  for (const d of dirs) {
    const hit = INSTRUCTION_NAMES.map((f) => join(d, f)).find(readable)
    if (hit) out.push(hit)
  }
  return out
}

/** Instruction files: the global AGENTS.md, then the project's chain from its root down to the
 *  working directory (instructionChain: every directory's AGENTS.md or CLAUDE.md, outermost first —
 *  before 3.0.0 only the nearest one counted), then the configured `instructions`. `chain` marks the
 *  chain's files: they are the project's own (agentsBlock), named to the model relative to the root. */
export function instructionFiles(cwd: string, root: string, extra: ExtraInstruction[] = []): { path: string; text: string; chain?: true }[] {
  const out: { path: string; text: string; chain?: true }[] = []
  const global = join(paths.config, "AGENTS.md")
  if (existsSync(global)) out.push({ path: global, text: readFileSync(global, "utf8") })
  let realRoot = root
  try {
    realRoot = realpathSync(root)
  } catch {}
  // Read only when it really is a file in the project: a repository could commit AGENTS.md as a
  // link to anything readable, and it would go to the model in every trust state.
  const texts = new Map<string, string>()
  const readable = (path: string) => {
    try {
      const real = realpathSync(path)
      if ((real !== realRoot && !real.startsWith(realRoot + sep)) || !statSync(real).isFile()) return false
      texts.set(path, readFileSync(real, "utf8"))
      return true
    } catch {
      return false
    }
  }
  for (const path of instructionChain(root, cwd, readable)) out.push({ path, text: texts.get(path)!, chain: true })
  for (const e of extra) {
    const path = resolve(root, expandHome(e.path))
    if (out.some((f) => f.path === path)) continue
    try {
      // By where it really is: a link inside the project may point anywhere.
      const real = realpathSync(path)
      const realRoot = realpathSync(root)
      if (!e.global && real !== realRoot && !real.startsWith(realRoot + sep)) continue
      out.push({ path, text: readFileSync(real, "utf8") })
    } catch {}
  }
  return out
}

export interface PromptContext {
  agentName?: string
  modelRef: string
  family: string
  cwd: string
  root: string
  /** `instructions` from config.yaml. */
  instructions?: ExtraInstruction[]
  isGit: boolean
  mode: Mode
  planDir: string
  toolNames: string[]
  /** Set when nobody can answer an approval: what will be refused, in words. */
  unattended?: string
  /** describeRepo(): branch, changes, recent commits. */
  git?: string
  /** The instruction files (AGENTS.md…) as read at the session's start; read now when absent. */
  files?: { path: string; text: string; chain?: true }[]
  /** Open items on the project's task board. */
  tasks?: string
  /** Set for a subagent: who it is and what it is for; replaces the mode's own instructions.
   *  `report`: it has the report tool. */
  subagent?: { name: string; instructions: string; report?: boolean }
  /** Spec 3.2.0 (team.md §4): a team member — blocks/team_member.md in place of blocks/subagent.md,
   *  with the whole of blocks/team_lead.md for one that may lead. */
  member?: { name: string; manager: string; role: string; goal: string; lead: boolean }
  /** Spec 3.2.0 (team.md §10): the team tools are offered to this session's agent (the lead):
   *  blocks/team_lead.md is in its prompt. */
  teamLead?: boolean
  /** The memory as it was when the prompt was made ("" when both files are empty); undefined
   *  when memory is off. A later change by the person goes as a note. */
  memory?: string
  /** The skills list (skillLines), taken when the session started. */
  skills?: string
  /** Whether skill_manage is offered (the skills block then says to fix and save skills). */
  manageSkills?: boolean
  /** The personality (a preset's text, or the person's own), last of all. */
  personality?: string
  /** The person's custom instructions (config `instructions`), just before the personality. */
  userInstructions?: string
  /** Connected MCP servers' own instructions (McpManager.instructions()). */
  mcp?: string
  /** The other configured models, one line each (with their notes). */
  roster?: string
  /** The session's plan (plan_write / plan_update) as it stood when the prompt was made; a change
   *  after that is the model's own tool result, or a note when the person made it. */
  plan?: Plan
  /** An instance's own instructions for this session (the chat's authored prompt, over the link),
   *  appended after the shared text under `## Instructions from <name>`. */
  instance?: { name: string; instructions: string }
  /** The library block (blocks/library.md): set when knowledge tools are offered or the instance
   *  library is in use; `scope` the sentence naming the bases in scope, or "" for all of them. */
  library?: { scope: string }
  /** recall is offered: the tool results carry ids and may be stubs (blocks/context.md, spec 3.0.0). */
  context?: boolean
  /** Prototypes are offered (blocks/prototypes.md); `sources` the sentence saying what a page
   *  may load, or "" where nothing says. */
  prototypes?: { sources: string }
}

const MAX_INSTRUCTION_CHARS = 40_000

/** The environment block's lines about where the session works (loop.json `context.env`, spec
 *  3.2.0): the project by its root's last path component, and — started below the root — that
 *  directory relative to it. No absolute path. */
export function envLines(root: string, started: string): string[] {
  const r = resolve(root)
  const name = basename(r) || r
  const lines = [fillPrompt(LOOP.context.env.project, { name })]
  const rel = relative(r, resolve(started))
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) lines.push(fillPrompt(LOOP.context.env.started, { path: rel }))
  return lines
}

/** A path as a prompt names it (context.md §11): relative to the project root inside it, `~/…`
 *  under the person's home, absolute only outside both. */
export function promptPath(root: string, path: string): string {
  const rel = relative(resolve(root), path)
  if (rel === "") return "."
  if (!rel.startsWith("..") && !isAbsolute(rel)) return rel
  const home = homedir()
  if (home && home !== "/" && (path === home || path.startsWith(home + sep))) return `~${path.slice(home.length)}`
  return path
}

/** The system prompt (harness spec; its stability is context.md §10, from 3.1.0). It is made once
 *  per session — at the start, after a compaction, on a model switch — and the engine resends
 *  those bytes on every request, so nothing in it may be a clock or anything else that moves on
 *  its own: no date (a note on the first user message says it, session/prefix.ts), the permission
 *  mode's text as it was at the start, the plan as it stood then, memory, instruction files,
 *  personality and MCP instructions as they were read for it. What changes later reaches the model
 *  as a `<session-note>` on the next user message, never by making this again. */
export function assembleSystem(ctx: PromptContext): string {
  const vars = {
    agent_name: ctx.agentName ?? "LLeMbas",
    plan_dir: ctx.planDir,
    intro: INTRO,
    surface: SURFACE,
    tool_list: "",
    file_tools: FILE_TOOLS,
    background: BACKGROUND,
    git: GIT_SECTION,
    plan_context: planContext(ctx.plan),
    // A subagent has neither: the bullets go with the empty values (fill.ts).
    plan_tools: ctx.subagent ? "" : PLAN_TOOLS,
    ask_tool: ctx.subagent ? "" : ASK_TOOL,
  }
  const sections: string[] = []
  // Who: the built-in line.
  sections.push(fillPrompt(promptText("system/identity.md"), vars))
  // One shared base, then what this model family needs on top (see the wiki: Prompts-provenance).
  // A user may still replace the whole base for a family with prompts/system/<family>.md.
  const own = `system/${ctx.family}.md`
  sections.push(fillPrompt(promptText(existsSync(join(paths.config, "prompts", own)) ? own : "system/default.md"), vars).trim())
  const overlay = `family/${ctx.family}.md`
  if (BUILTIN[overlay] || existsSync(join(paths.config, "prompts", overlay))) sections.push(fillPrompt(promptText(overlay), vars))
  // What the instance holds for this session (over the link): the chat's authored prompt.
  if (ctx.instance?.instructions.trim()) sections.push(`## Instructions from ${ctx.instance.name}\n\n${ctx.instance.instructions.trim()}`)

  sections.push(
    [
      "<env>",
      // No absolute path (context.md §11): the project by its name, relative paths against its root.
      ...envLines(ctx.root, ctx.cwd),
      `Git repository: ${ctx.isGit ? "yes" : "no"}`,
      `Platform: ${platform()} ${release()}`,
      // No date: it would change at midnight and the whole session be read again (§10 rule 2).
      `Model: ${ctx.modelRef}`,
      "</env>",
    ].join("\n"),
  )
  if (ctx.roster && !ctx.subagent)
    sections.push(`Other models configured here — the task tool can run a subagent on one (its model argument); the user can switch to one, and so can you through the settings tool when they ask:\n<models>\n${ctx.roster}\n</models>`)
  if (ctx.git) sections.push(`The git repository as it was when this session started — a snapshot, not kept up to date; run git status for how it is now:\n<git>\n${ctx.git}\n</git>`)
  if (ctx.tasks && !ctx.subagent) sections.push(`Open items on the project's task board (the tasks tool changes it):\n<project_tasks>\n${ctx.tasks}\n</project_tasks>`)

  const files = ctx.files ?? instructionFiles(ctx.cwd, ctx.root, ctx.instructions)
  for (const f of files) {
    let text = f.text.trim()
    // A file in the project by its path from the root, one under home as ~/… (context.md §11).
    const named = promptPath(ctx.root, f.path)
    if (text.length > MAX_INSTRUCTION_CHARS)
      text = text.slice(0, MAX_INSTRUCTION_CHARS) + `\n[…truncated: kept ${MAX_INSTRUCTION_CHARS} of ${f.text.length} characters; read ${named} for the rest]`
    sections.push(`Instructions from ${named}:\n<instructions>\n${text}\n</instructions>`)
  }

  if (ctx.mcp) sections.push(ctx.mcp)
  if (!ctx.subagent) sections.push(agentsBlock(ctx, files))

  // Memory and skills: as they were when the prompt was made, so the prompt does not change under
  // a session (Hermes' frozen snapshot); the person's later edit to memory goes as a note.
  if (ctx.memory !== undefined && !ctx.subagent) {
    sections.push(promptText("blocks/memory.md"))
    if (ctx.memory) sections.push(ctx.memory)
  }
  if (ctx.skills)
    sections.push(
      fillPrompt(promptText("blocks/skills.md"), {
        skills: ctx.skills,
        manage:
          ctx.manageSkills && !ctx.subagent
            ? "Skills are made and changed only with skill_manage, never by writing files. If a skill turns out wrong or incomplete, fix it with skill_manage (patch) before you finish. After a difficult or many-step task, offer to save what you worked out as a skill."
            : "",
      }).replace(/\n{3,}/g, "\n\n"),
    )
  else if (ctx.manageSkills && !ctx.subagent) sections.push(promptText("blocks/skills-empty.md"))
  // The library and prototypes (shared blocks): the library whenever its tools are offered, named
  // to the bases in scope; prototypes only where they are offered, with where the page is seen.
  // How tool results are kept short (ids, stubs, recall): wherever recall is offered.
  if (ctx.context) sections.push(promptText("blocks/context.md"))
  if (ctx.library && !ctx.subagent) sections.push(fillPrompt(promptText("blocks/library.md"), { knowledge_scope: ctx.library.scope }))
  if (ctx.prototypes && !ctx.subagent) sections.push(fillPrompt(promptText("blocks/prototypes.md"), { prototype_sources: ctx.prototypes.sources, prototype_surface: PROTOTYPE_SURFACE }))

  if (ctx.teamLead && !ctx.subagent) sections.push(promptText("blocks/team_lead.md"))
  if (ctx.subagent && ctx.member)
    sections.push(
      fillPrompt(promptText("blocks/team_member.md"), {
        name: ctx.member.name,
        manager: ctx.member.manager,
        role: ctx.member.role,
        goal: ctx.member.goal,
        instructions: ctx.subagent.instructions,
        read_only: ctx.mode === "plan" ? SUBAGENT_READ_ONLY : "",
        lead: ctx.member.lead ? promptText("blocks/team_lead.md") : "",
      })
        .replace(/\n{3,}/g, "\n\n")
        .trim(),
    )
  else if (ctx.subagent)
    sections.push(
      fillPrompt(promptText("blocks/subagent.md"), {
        name: ctx.subagent.name,
        instructions: ctx.subagent.instructions,
        report: ctx.subagent.report ? SUBAGENT_REPORT : "",
        read_only: ctx.mode === "plan" ? SUBAGENT_READ_ONLY : "",
      }),
    )
  else sections.push(modeText(ctx.mode, ctx.planDir, ctx.unattended))
  // What the person said about themselves goes last, under the web UI's headings and in its order.
  // Not for a subagent: it answers the main agent, not the person.
  if (ctx.userInstructions && !ctx.subagent) sections.push(`## How the person you are talking to wants to be helped\n\n${ctx.userInstructions}`)
  if (ctx.personality && !ctx.subagent) sections.push(`## Personality\n\n${ctx.personality}`)
  return sections.join("\n\n")
}

/** A permission mode's text (modes/<mode>.md), with the unattended block when nobody can approve
 *  (`refused`: what will be refused, in words): the prompt's own as it was made, and the body of a
 *  note when the mode changes later (session/prefix.ts). */
export function modeText(mode: Mode, planDir: string, refused?: string): string {
  const own = fillPrompt(promptText(`modes/${mode}.md`), { plan_dir: planDir })
  return refused ? `${own}\n\n${fillPrompt(promptText("modes/unattended.md"), { plan_dir: planDir, refused })}` : own
}

const GIT_QUESTION =
  "do you commit on your own once a change is finished and checked, only when they ask, or never; and which branch the work goes on (the current one, or a new branch for each task)."
const GIT_QUESTION_NO_REPO = "this folder is not a git repository yet — should it be one, and if so, do you commit on your own once a change is finished and checked, or only when they ask."

/** The project's own AGENTS.md (or CLAUDE.md): make it when missing, settle git when it does not,
 *  and keep it current. The project's are the chain's files (instructionFiles `chain`), stacked from
 *  its root down: none of them is missing, and git is settled when any of them settles it. The
 *  global ~/.config/lembas/AGENTS.md and the configured `instructions` are not the project's. */
function agentsBlock(ctx: PromptContext, files: { path: string; text: string; chain?: true }[]): string {
  // Files handed in without the mark (an older caller): anything but the global file, as before.
  const marked = files.some((f) => f.chain)
  const own = files.filter((f) => (marked ? f.chain : f.path !== join(paths.config, "AGENTS.md")))
  const vars = { git_question: ctx.isGit ? GIT_QUESTION : GIT_QUESTION_NO_REPO }
  if (!own.length) return fillPrompt(promptText("blocks/agents-missing.md"), vars)
  const keep = promptText("blocks/agents-keep.md")
  return own.some((f) => /^#{1,3}\s*git\b/im.test(f.text)) ? keep : `${fillPrompt(promptText("blocks/agents-git.md"), vars)}\n\n${keep}`
}
