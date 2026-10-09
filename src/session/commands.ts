// The slash commands a prompt may start with anywhere, not only in the TUI: what the web UI
// offers in its composer (`available_commands_update`, `_lembas/commands`) and what a prompt sent
// over ACP that starts with `/name` turns into. The set is the shared one — custom commands
// (`.agent/commands`, global), skills (`/skill-name`), and the built-ins that need no screen of
// their own: compact, plan, undo, review, changelog, init, continue. What only the TUI can do (the
// sessions picker, settings, theme, login, quit…) is never listed and never expanded here.
//
// The TUI runs the same builders (review, changelog, init) and the same rules (a built-in name wins
// over a custom command's, a custom command's over a skill's; @files come from what was typed, never
// from a command's own text), so a command does the same thing whichever keyboard typed it.
import { existsSync } from "node:fs"
import type { App } from "../app.ts"
import { MODES, type Mode } from "../config/schema.ts"
import { git } from "../git/run.ts"
import { customCommands, expandCommand } from "../project/commands.ts"
import { fill, promptText } from "../prompt/assemble.ts"
import { skillMessage, slug, type Skill } from "../skill/index.ts"
import { CONTINUE_PROMPT } from "./engine.ts"

export type CommandKind = "custom" | "skill" | "builtin"

/** One command as ACP's `availableCommands` lists it. */
export interface CommandInfo {
  name: string
  description: string
  input?: { hint: string }
  _meta: { lembas: { kind: CommandKind } }
}

/** Every name the TUI's own commands take, aliases included (tui/commands.ts COMMANDS; a test keeps
 *  the two equal). A custom command or a skill of one of these names is not a command — in the TUI
 *  the built-in wins — so it is not one here either, even where the built-in is not offered. */
export const TUI_COMMAND_NAMES = [
  "agents", "continue", "help", "model", "effort", "mode", "plan", "plans", "review", "changelog", "init", "release", "tasks", "decisions", "decide",
  "sessions", "resume", "remote", "delete", "new", "clear", "copy", "undo", "redo", "diff", "checkpoint", "checkpoints", "branch", "commit", "context",
  "compact", "memory", "skills", "skill", "personality", "voice", "speak", "mcp", "login", "logout", "settings", "usage", "kb", "theme", "skin", "terminal",
  "icons", "trust", "reload", "restart", "quit", "exit", "q",
] as const

/** The built-ins that work without a screen of their own. Descriptions as the TUI's (a test). */
export const SHARED_BUILTINS: { name: string; description: string; hint?: string }[] = [
  { name: "compact", description: "summarise the conversation to free context" },
  { name: "plan", description: "plan mode — read, investigate, write a plan for approval; with a task, start on it", hint: "task" },
  { name: "undo", description: "take back the last prompt: its file changes and its conversation" },
  { name: "review", description: "a read-only review of this session's changes (or since the last commit, or against a branch)", hint: "head | <branch>" },
  { name: "changelog", description: "update CHANGELOG.md's Unreleased section from the commits since the last tag", hint: "since" },
  { name: "init", description: "make or update the project's AGENTS.md from what the repository says", hint: "what to focus on" },
  { name: "continue", description: "carry on — after esc stopped it, or when it should keep going (ctrl+g)" },
]

const reserved = new Set<string>(TUI_COMMAND_NAMES)

/** Where the commands come from: a trusted project's `.agent` (or none), and the skills. */
export interface CommandSources {
  projectDir?: string
  skills: () => Skill[]
}

export function sourcesOf(app: App): CommandSources {
  return { projectDir: app.trusted && existsSync(app.project.dir) ? app.project.dir : undefined, skills: () => app.skills() }
}

/** The shared set, built-ins first, then custom commands, then skills. */
export function commandSet(src: CommandSources): CommandInfo[] {
  const out: CommandInfo[] = SHARED_BUILTINS.map((b) => ({ name: b.name, description: b.description, ...(b.hint ? { input: { hint: b.hint } } : {}), _meta: { lembas: { kind: "builtin" as const } } }))
  const custom = customCommands(src.projectDir).filter((c) => !reserved.has(c.name))
  for (const c of custom) out.push({ name: c.name, description: c.description, ...(c.body.includes("$") ? { input: { hint: "arguments" } } : {}), _meta: { lembas: { kind: "custom" } } })
  const taken = new Set(custom.map((c) => c.name))
  for (const s of src.skills()) {
    const name = slug(s.name)
    if (reserved.has(name) || taken.has(name)) continue
    taken.add(name)
    out.push({ name, description: s.description.slice(0, 200), input: { hint: "instruction" }, _meta: { lembas: { kind: "skill" } } })
  }
  return out
}

/** What a prompt starting with a command turns into. */
export type Expanded =
  /** A prompt to send: `prompt` to the model, `shown` in the transcript, @files read from
   *  `attachFrom` only; a model and mode for this one prompt. */
  | { kind: "prompt"; name: string; prompt: string; shown: string; attachFrom: string; model?: string; mode?: Mode }
  /** A built-in that is not a prompt (compact, undo; plan without a task). */
  | { kind: "action"; name: "compact" | "undo" | "plan"; arg: string }
  /** Nothing to send, and why (a review with no changes). */
  | { kind: "message"; name: string; text: string }

/** `/review [head | <branch>]`: the change, as a prompt for a read-only review — or why there is none. */
export function reviewPrompt(app: App, arg: string): { prompt: string } | { message: string } {
  const root = app.project.gitRoot
  let diff: string | undefined
  let scope: string
  if (arg && arg !== "head") {
    if (!root) return { message: "not a git repository" }
    const r = git(root, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", `${arg}...HEAD`])
    if (r.code !== 0) return { message: `git diff ${arg}...HEAD: ${r.err}` }
    diff = r.out
    scope = `The change is this branch against ${arg}.`
  } else if (arg === "head") {
    if (!root) return { message: "not a git repository" }
    diff = git(root, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "HEAD"]).out
    scope = "The change is everything not yet committed."
  } else {
    diff = app.turns.diff()
    scope = "The change is what this session did."
  }
  if (!diff?.trim()) return { message: "nothing to review — no changes" + (arg ? "" : " in this session (/review head: since the last commit)") }
  const clipped = diff.length > 60_000 ? diff.slice(0, 60_000) + "\n[… diff cut at 60 000 characters]" : diff
  return { prompt: fill(promptText("tasks/review.md"), { scope, diff: clipped }) }
}

/** `/changelog [since]`: the commits since the last tag, as a prompt to update the Unreleased section. */
export function changelogPrompt(app: App, arg: string): { prompt: string } | { message: string } {
  const git0 = app.project.gitRoot
  if (!git0) return { message: "not a git repository" }
  // The project may be one directory of a larger repository: its commits, its files.
  const root = app.project.root
  const only = root === git0 ? [] : ["--", "."]
  const since = arg.trim() || git(root, ["describe", "--tags", "--abbrev=0"]).out
  const range = since ? `${since}..HEAD` : "HEAD"
  const log = git(root, ["log", "--no-merges", "--format=- %s%n%w(0,2,2)%b", range, ...only]).out.replace(/\n{2,}/g, "\n").trim()
  if (!log) return { message: since ? `no commits since ${since}` : "no commits yet" }
  const stat = git(root, ["diff", "--stat", since ? since : git(root, ["rev-list", "--max-parents=0", "HEAD"]).out.split("\n")[0]!, "HEAD", ...only]).out
  return {
    prompt: fill(promptText("tasks/changelog.md"), {
      scope: since ? `Unreleased since ${since}.` : "Nothing has been released yet.",
      log: log.slice(0, 20_000),
      stat: stat.slice(-6_000),
    }),
  }
}

/** `/init [focus]`: make or update AGENTS.md. */
export function initPrompt(app: App, arg: string): string {
  return fill(promptText("tasks/init.md"), {
    root: app.project.root,
    focus: arg.trim() ? `What the user wants it to focus on: ${arg.trim()}` : "",
  }).replace(/\n{3,}/g, "\n\n")
}

/** A prompt's text as a command of the shared set, or undefined when it is not one — then it goes
 *  to the model as it is, `/` and all (a path, a regex, a command this machine does not have). */
export function expandSlash(app: App, text: string): Expanded | undefined {
  const t = text.trim()
  const m = /^\/([a-z0-9_:-]+)(?:\s+([\s\S]*))?$/i.exec(t)
  if (!m) return undefined
  const name = m[1]!.toLowerCase()
  const arg = (m[2] ?? "").trim()
  switch (name) {
    case "compact":
    case "undo":
      return { kind: "action", name, arg }
    case "plan":
      return arg ? { kind: "prompt", name, prompt: arg, shown: arg, attachFrom: arg, mode: "plan" } : { kind: "action", name, arg }
    case "continue":
      return { kind: "prompt", name, prompt: CONTINUE_PROMPT, shown: "↻ continue", attachFrom: "" }
    case "init":
      // The prompt is ours; only what was typed after the name may attach files.
      return { kind: "prompt", name, prompt: initPrompt(app, arg), shown: t, attachFrom: arg }
    case "review": {
      const r = reviewPrompt(app, arg)
      // The diff is somebody else's text: an @path in it must not attach a file.
      return "message" in r ? { kind: "message", name, text: r.message } : { kind: "prompt", name, prompt: r.prompt, shown: t, attachFrom: "", mode: "plan" }
    }
    case "changelog": {
      const r = changelogPrompt(app, arg)
      return "message" in r ? { kind: "message", name, text: r.message } : { kind: "prompt", name, prompt: r.prompt, shown: t, attachFrom: "" }
    }
  }
  if (reserved.has(name)) return undefined
  const src = sourcesOf(app)
  const cc = customCommands(src.projectDir).find((c) => c.name === name)
  if (cc) {
    // A project's command may make the mode stricter for its prompt, never looser; your own may.
    const own = cc.mode && (MODES as readonly string[]).includes(cc.mode) ? (cc.mode as Mode) : undefined
    const mode = own && cc.source === "project" ? stricter(own, app.engine.mode) : own
    return { kind: "prompt", name, prompt: expandCommand(cc, arg, app.project.root, app.engine.o.perm.hardline), shown: t, attachFrom: arg, model: cc.model, ...(mode ? { mode } : {}) }
  }
  const sk = src.skills().find((s) => slug(s.name) === name)
  if (sk) return { kind: "prompt", name, prompt: skillMessage(sk, arg), shown: t, attachFrom: arg }
  return undefined
}

const RANK: Record<Mode, number> = { auto: 0, edit: 1, manual: 2, plan: 3 }
function stricter(a: Mode, b: Mode): Mode {
  return RANK[a] > RANK[b] ? a : b
}
