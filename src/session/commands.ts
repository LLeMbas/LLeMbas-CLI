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
import { TEAM, Team } from "../team/team.ts"
import { SUBAGENTS } from "../team/subagents.ts"
import { progressLine } from "./progress.ts"
import { fillPrompt } from "../prompt/fill.ts"
import { mcpText } from "../mcp/text.ts"
import { permissionsText, statusText } from "./report.ts"

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
  "agents", "continue", "help", "model", "effort", "mode", "plan", "plans", "prototype", "review", "changelog", "init", "release", "tasks", "decisions", "decide",
  "jobs", "sessions", "resume", "remote", "delete", "new", "clear", "copy", "undo", "redo", "diff", "checkpoint", "checkpoints", "branch", "commit", "context",
  "compact", "memory", "skills", "skill", "personality", "voice", "speak", "mcp", "login", "logout", "settings", "usage", "kb", "theme", "skin", "terminal",
  "icons", "trust", "reload", "restart", "quit", "exit", "q", "team", "rename", "schedule", "schedules", "search", "permissions", "status", "command",
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
  { name: "mcp", description: "MCP servers: a menu of them — state, tools and what each may do, sign in, switch one on or off", hint: "server" },
  { name: "permissions", description: "the permission rules in force — this session's, the project's, yours, the built-in ones; change or add one" },
  { name: "status", description: "everything in one place: the server and login, the session, the project, the MCP servers, this terminal" },
  { name: "skill", description: "use a skill (for one whose name a command already has)", hint: "name [instruction]" },
  { name: "command", description: "run a custom command by its name (for one whose name a built-in command has)", hint: "name [words]" },
  { name: "agents", description: "subagents: list them, make one, or hand one a task", hint: "name" },
  { name: "team", description: "subagents: the tree and the room; how many; stop one; their findings", hint: "size <min> <max> | stop <name> | findings <name>" },
]

/** The status bar's word for a team with members: its size of the most it may have, and how many
 *  work now; "" without members. */
export function teamLabel(team: Team): string {
  if (!team.hasMembers()) return ""
  const n = team.active()
  return `agents ${team.size()}/${team.max}${n ? ` · ${n} subagent${n === 1 ? "" : "s"} working` : ""}`
}

/** Spec 3.4.0 (subagents.md §12): the tree as the person sees it — every agent with its position,
 *  state, model, mode, context use, progress line and messages; open slots; the ended ones. */
export function treeText(team: Team, now = Date.now()): string {
  const info = team.info()
  const R = TEAM.read
  const depth = (a: { parent: string | null }): number => (a.parent ? 1 + depth(info.agents.find((x) => x.name === a.parent) ?? { parent: null }) : 0)
  const lines = [`${SUBAGENTS.setting.label} (${info.size} of ${info.max} agents; ${SUBAGENTS.setting.min} ${info.min}, ${SUBAGENTS.setting.max} ${info.max}):`]
  for (const a of info.agents) {
    const bits = [
      `${"  ".repeat(depth(a))}- ${a.name}${a.id === a.name ? "" : ` (${a.id})`} — ${a.position}`,
      R.states[a.state],
      a.model,
      a.request.length ? `${a.mode} + ${a.request.join(", ")}` : a.mode,
      a.context && a.context.window ? `${Math.floor((a.context.used * 100) / a.context.window)}% context` : "",
      a.progress ? progressLine(a.progress, now) : "",
      a.messages ? `${a.messages} message${a.messages === 1 ? "" : "s"}` : "",
      a.findings ? `${a.findings} finding${a.findings === 1 ? "" : "s"}` : "",
    ].filter(Boolean)
    lines.push(bits.join(" · "))
  }
  if (info.open_slots) lines.push(fillPrompt(R.slots, { n: String(info.open_slots) }))
  if (info.ended.length) {
    lines.push(R.ended)
    for (const a of info.ended) lines.push(`- ${a.name} (${a.id}) — ${a.position} · ${R.states[a.state]}${a.findings ? ` · ${a.findings} finding${a.findings === 1 ? "" : "s"}` : ""}`)
  }
  return lines.join("\n")
}

/** `/team [size <min> <max> | stop <name>]`: the team's tree and room, as the lead sees them (the
 *  person sees everything, team.md §5); its size for this session; a member stopped by the person,
 *  which the lead is told in a note. */
export function teamText(app: App, arg: string): string {
  const rt = app.team
  const t = rt.team
  const S = SUBAGENTS.setting
  const [verb, ...rest] = arg.trim().split(/\s+/).filter(Boolean)
  if (verb === "size") {
    const [min, max] = rest.map(Number)
    if (min === undefined || max === undefined || Number.isNaN(min) || Number.isNaN(max)) return `/team size <min> <max> — now ${S.label}: ${S.min} ${t.min}, ${S.max} ${t.max} (Max at most ${t.cap}). ${S.hint}`
    // Checked whole before anything is set: a refused pair changes nothing (team.md §2).
    const no = Team.check(min, max, t.cap)
    if (no) return no
    try {
      app.settings.set("agents.min", Math.min(min, t.max))
      app.settings.set("agents.max", max)
      app.settings.set("agents.min", min)
    } catch (e) {
      return (e as Error).message
    }
    return `${S.label}: ${S.min} ${t.min}, ${S.max} ${t.max} — ${S.short}. Set for this session; the agent is told with your next message.`
  }
  if (verb === "findings") {
    const name = rest[0]
    if (!name) return "/team findings <name or id>"
    return t.readFindings("lead", name)
  }
  if (verb === "stop") {
    const name = rest[0]
    if (!name) return "/team stop <name> — a member and everything under it"
    const gone = rt.personStop(name)
    return gone.length ? `Stopped ${gone.join(", ")}; the lead is told with your next message.` : `No member called ${name} on the team.`
  }
  if (!t.offered)
    return t.subagents
      ? `No subagents in this session: ${app.engine.model.ref} serves one request at a time, and every other model is on its one-model server.`
      : "No subagents in this session: they are switched off (subagents: false)."
  const since = Math.max(0, t.room.length - TEAM.read_max)
  const own = t.couldServe().own ? "" : `\n${S.own}`
  // The tree as the person sees it (spec 3.4.0 §12), then the room as team_read shows it.
  const read = t.read("lead", since)
  const room = read.slice(read.indexOf("\n\n") + 2)
  return `${treeText(t)}\n\n${room}\n\n${S.label}: ${S.min} ${t.min}, ${S.max} ${t.max} — ${S.short} (/team size <min> <max>); /team stop <name> stops a subagent; /team open <name> shows its session, read-only; /team findings <name>; /context <name>.${own}`
}

/** `/agents [name]`: the subagents the task tool offers, or one of them — the text both the TUI and
 *  a client over ACP show. Making one (`new`) and handing one a task need a screen: the TUI's. */
export function agentsText(app: App, arg: string): string {
  const list = app.agents
  const describe = (a: (typeof list)[number]) =>
    [
      `${a.name} (${a.source}) — ${a.description}`,
      `  model the session's, or one you name${a.model ? ` (its own model: ${a.model} is not used)` : ""} · mode ${a.mode ?? "the session's"} · tools ${a.tools?.join(", ") ?? "all a subagent may have"}${a.isolation ? " · own worktree" : ""}`,
    ].join("\n")
  const name = arg.trim().split(/\s+/)[0]
  if (name) {
    const one = list.find((a) => a.name === name)
    return one ? describe(one) : `no agent "${name}" — ${list.map((a) => a.name).join(", ")}`
  }
  return [...list.map(describe), "", 'The model hands work to one through its task tool when that helps; you can ask it to ("use the explore subagent to…").'].join("\n")
}

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
  /** `error`: the text says the command could not do what was asked (an unknown name). */
  | { kind: "message"; name: string; text: string; error?: boolean }

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
    focus: arg.trim() ? `What the user wants it to focus on: ${arg.trim()}` : "",
  }).replace(/\n{3,}/g, "\n\n")
}

/** A prompt's text as a command of the shared set, or undefined when it is not one — then it goes
 *  to the model as it is, `/` and all (a path, a regex, a command this machine does not have). */
/** `plain`: the text is printed as it is (`lembas run`), not drawn as markdown (a reply in the
 *  web UI, which is what a prompt over the link becomes). */
export function expandSlash(app: App, text: string, o: { plain?: boolean } = {}): Expanded | undefined {
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
    case "agents":
      // List and describe anywhere; `new` and `<name> <task>` are the TUI's own.
      if (/^(new)\b/.test(arg) || arg.trim().split(/\s+/).length > 1) return { kind: "message", name, text: "/agents here lists and describes the subagents; making one or handing one a task is done at the terminal." }
      return ((text) => ({ kind: "message" as const, name, text, ...(text.startsWith("no agent ") ? { error: true } : {}) }))(agentsText(app, arg))
    case "team":
      return { kind: "message", name, text: teamText(app, arg) }
    // A command that takes no words is the command only when it stands alone: "/status of the
    // build?" is a question for the model.
    case "permissions":
      return arg ? undefined : { kind: "message", name, text: permissionsText(app) }
    case "status":
      return arg ? undefined : { kind: "message", name, text: statusText(app) }
    case "mcp":
      // No menu here: the servers as a list, or — when the one word after it is exactly a
      // server's name — that server's tools. Anything else is a prompt.
      if (arg && !app.mcp.servers.has(arg)) return undefined
      return { kind: "message", name, text: mcpText(app.mcp, arg, (tool) => app.engine.ruleFor(tool), { markdown: !o.plain }) }
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
  const src = sourcesOf(app)
  // The way to a skill or a custom command whose own name a built-in command has.
  let wanted = name
  let words = arg
  let only: "skill" | "custom" | undefined
  if (name === "skill" || name === "command") {
    const [first = "", ...rest] = arg.split(/\s+/)
    if (!first) return undefined
    wanted = name === "skill" ? slug(first) : first.toLowerCase()
    words = rest.join(" ")
    only = name === "skill" ? "skill" : "custom"
  } else if (reserved.has(name)) return undefined
  const cc = only === "skill" ? undefined : customCommands(src.projectDir).find((c) => c.name === wanted)
  if (only === "custom" && !cc) return { kind: "message", name, text: `no custom command "${wanted}"`, error: true }
  if (cc) {
    const arg = words
    // A project's command may make the mode stricter for its prompt, never looser; your own may.
    const own = cc.mode && (MODES as readonly string[]).includes(cc.mode) ? (cc.mode as Mode) : undefined
    const mode = own && cc.source === "project" ? stricter(own, app.engine.mode) : own
    return { kind: "prompt", name, prompt: expandCommand(cc, arg, app.project.root, app.engine.o.perm.hardline), shown: t, attachFrom: arg, model: cc.model, ...(mode ? { mode } : {}) }
  }
  const sk = src.skills().find((s) => slug(s.name) === wanted)
  if (sk) return { kind: "prompt", name, prompt: skillMessage(sk, words), shown: t, attachFrom: words }
  if (only === "skill") return { kind: "message", name, text: `no skill "${wanted}"`, error: true }
  return undefined
}

const RANK: Record<Mode, number> = { auto: 0, edit: 1, manual: 2, plan: 3 }
function stricter(a: Mode, b: Mode): Mode {
  return RANK[a] > RANK[b] ? a : b
}
