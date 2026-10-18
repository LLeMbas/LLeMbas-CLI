import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import { platform, release } from "node:os"
import { dirname, join, resolve, sep } from "node:path"
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

// Built-in prompt text, by path relative to harness/prompts (the harness spec shared with LLeMbas).
// Any of these can be replaced by a file at the same path under ~/.config/lembas/prompts/.
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
const BACKGROUND = "A long-running command (a server, a watcher) runs with bash `background: true`; check it with bash_output and stop it with bash_kill."
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

/** Instruction files: the global AGENTS.md, then the nearest project AGENTS.md or CLAUDE.md
 *  walking up to the project root (first match wins, as OpenCode does — ancestors do not stack). */
/** An `instructions` entry from config.yaml. A project's may only name files inside the project:
 *  a cloned repository must not be able to put ~/.ssh/… into what is sent to the model. */
export interface ExtraInstruction {
  path: string
  global: boolean
}

export function instructionFiles(cwd: string, root: string, extra: ExtraInstruction[] = []): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = []
  const global = join(paths.config, "AGENTS.md")
  if (existsSync(global)) out.push({ path: global, text: readFileSync(global, "utf8") })
  let dir = cwd
  let realRoot = root
  try {
    realRoot = realpathSync(root)
  } catch {}
  for (;;) {
    const hit = ["AGENTS.md", "CLAUDE.md"].map((f) => join(dir, f)).find((f) => existsSync(f))
    if (hit) {
      // Read only when it really is a file in the project: a repository could commit AGENTS.md as
      // a link to anything readable, and it would go to the model in every trust state.
      try {
        const real = realpathSync(hit)
        if ((real === realRoot || real.startsWith(realRoot + sep)) && statSync(real).isFile()) out.push({ path: hit, text: readFileSync(real, "utf8") })
      } catch {}
      break
    }
    if (dir === root || dirname(dir) === dir) break
    dir = dirname(dir)
  }
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
  files?: { path: string; text: string }[]
  /** Open items on the project's task board. */
  tasks?: string
  /** Set for a subagent: who it is and what it is for; replaces the mode's own instructions. */
  subagent?: { name: string; instructions: string }
  /** The memory snapshot taken when the session started ("" when both files are empty);
   *  undefined when memory is off. */
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
  /** The session's plan (plan_write / plan_update), put into the prompt while it exists. */
  plan?: Plan
  /** An instance's own instructions for this session (the chat's authored prompt, over the link),
   *  appended after the shared text under `## Instructions from <name>`. */
  instance?: { name: string; instructions: string }
  /** The library block (blocks/library.md): set when knowledge tools are offered or the instance
   *  library is in use; `scope` the sentence naming the bases in scope, or "" for all of them. */
  library?: { scope: string }
  /** Prototypes are offered (blocks/prototypes.md); `sources` the sentence saying what a page
   *  may load, or "" where nothing says. */
  prototypes?: { sources: string }
}

const MAX_INSTRUCTION_CHARS = 40_000

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
      `Working directory: ${ctx.cwd}`,
      `Project root: ${ctx.root}`,
      `Git repository: ${ctx.isGit ? "yes" : "no"}`,
      `Platform: ${platform()} ${release()}`,
      `Today: ${new Date().toISOString().slice(0, 10)}`,
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
    if (text.length > MAX_INSTRUCTION_CHARS)
      text = text.slice(0, MAX_INSTRUCTION_CHARS) + `\n[…truncated: kept ${MAX_INSTRUCTION_CHARS} of ${f.text.length} characters; read ${f.path} for the rest]`
    sections.push(`Instructions from ${f.path}:\n<instructions>\n${text}\n</instructions>`)
  }

  if (ctx.mcp) sections.push(ctx.mcp)
  if (!ctx.subagent) sections.push(agentsBlock(ctx, files))

  // Memory and skills: snapshots taken when the session started, so the prompt does not change
  // under a session (Hermes' frozen snapshot).
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
  if (ctx.library && !ctx.subagent) sections.push(fillPrompt(promptText("blocks/library.md"), { knowledge_scope: ctx.library.scope }))
  if (ctx.prototypes && !ctx.subagent) sections.push(fillPrompt(promptText("blocks/prototypes.md"), { prototype_sources: ctx.prototypes.sources, prototype_surface: PROTOTYPE_SURFACE }))

  if (ctx.subagent)
    sections.push(
      `You are the "${ctx.subagent.name}" subagent. You work for the main agent, not for the user directly, on one task it gave you; you cannot ask anyone anything. ${ctx.subagent.instructions}\n\nOnly your final reply reaches the main agent — make it complete on its own: the result, then the evidence (file:line), then anything you could not settle.${ctx.mode === "plan" ? " You can read and search; you cannot change anything." : ""}`,
    )
  else sections.push(fillPrompt(promptText(`modes/${ctx.mode}.md`), vars))
  if (ctx.unattended) sections.push(fillPrompt(promptText("modes/unattended.md"), { ...vars, refused: ctx.unattended }))
  // What the person said about themselves goes last, under the web UI's headings and in its order.
  // Not for a subagent: it answers the main agent, not the person.
  if (ctx.userInstructions && !ctx.subagent) sections.push(`## How the person you are talking to wants to be helped\n\n${ctx.userInstructions}`)
  if (ctx.personality && !ctx.subagent) sections.push(`## Personality\n\n${ctx.personality}`)
  return sections.join("\n\n")
}

const GIT_QUESTION =
  "do you commit on your own once a change is finished and checked, only when they ask, or never; and which branch the work goes on (the current one, or a new branch for each task)."
const GIT_QUESTION_NO_REPO = "this folder is not a git repository yet — should it be one, and if so, do you commit on your own once a change is finished and checked, or only when they ask."

/** The project's own AGENTS.md (or CLAUDE.md): make it when missing, settle git when it does not,
 *  and keep it current. The global ~/.config/lembas/AGENTS.md is not the project's. */
function agentsBlock(ctx: PromptContext, files: { path: string; text: string }[]): string {
  const own = files.find((f) => f.path !== join(paths.config, "AGENTS.md"))
  const vars = { root: ctx.root, git_question: ctx.isGit ? GIT_QUESTION : GIT_QUESTION_NO_REPO }
  if (!own) return fillPrompt(promptText("blocks/agents-missing.md"), vars)
  const keep = promptText("blocks/agents-keep.md")
  return /^#{1,3}\s*git\b/im.test(own.text) ? keep : `${fillPrompt(promptText("blocks/agents-git.md"), vars)}\n\n${keep}`
}
