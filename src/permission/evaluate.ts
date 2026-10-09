// Permission evaluation: rules (OpenCode's shape — last match wins), modes (LLeMbas CLI's four),
// and the hardline floor (Hermes) underneath everything.
import { lstatSync, readlinkSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, relative, resolve } from "node:path"
import type { Action, Mode, PermissionConfig } from "../config/schema.ts"
import { prefix } from "./arity.ts"
import { splitCommand, words } from "./bash.ts"
import { hardlineCommand, plainCommands, protectedPath, type HardlineRule } from "./hardline.ts"
import { match } from "./wildcard.ts"
import DEFAULTS from "../../harness/permission/defaults.json"
import ARITY from "../../harness/permission/arity.json"

export interface Rule {
  permission: string
  pattern: string
  action: Action
  /** Added by an "always allow" answer: it never overrides a deny somebody wrote. */
  learned?: boolean
  /** Where it was written. A project's rule never loosens what the user's own global config says. */
  source?: "default" | "global" | "project"
}

/** Every tool belongs to one class; modes are defined over classes. */
export type ToolClass = "read" | "write" | "execute" | "interact"

export interface PermissionRequest {
  /** The permission key: read, edit, bash, glob, grep, list, ask_user, web_fetch… */
  permission: string
  class: ToolClass
  /** What the rules are matched against: project-relative paths, or the command line. */
  patterns: string[]
  /** Absolute paths the call touches (file tools). */
  paths?: string[]
  /** The raw command line (bash). */
  command?: string
  /** Asked every time, whatever the mode or the rules say — with this reason, and no "always"
   *  answer (the settings tool loosening the mode). A deny still denies. */
  alwaysAsk?: string
  /** The "always allow" patterns to offer, when they are not the patterns themselves. */
  always?: string[]
}

export interface Decision {
  action: Action
  reason: string
  /** Suggested "always allow" patterns for this request. */
  always: string[]
}

// The rules every session starts from: the harness spec's (harness/permission/defaults.json).
export const DEFAULT_RULES = DEFAULTS.rules as PermissionConfig

export function toRules(config: PermissionConfig, source?: Rule["source"]): Rule[] {
  const rules: Rule[] = []
  for (const [permission, v] of Object.entries(config)) {
    if (typeof v === "string") rules.push({ permission, pattern: "*", action: v, ...(source ? { source } : {}) })
    else for (const [pattern, action] of Object.entries(v)) rules.push({ permission, pattern, action, ...(source ? { source } : {}) })
  }
  return rules
}

function lookupRule(permission: string, pattern: string, rules: Rule[]): Rule | undefined {
  const hit = rules.findLast((r) => match(permission, r.permission) && match(pattern, r.pattern))
  // A project's rule (or an "always" answer) that is looser than what the user's global config says
  // for the same call gives way to it: the user's ask and deny are the floor a cloned repository
  // stands on, not something it can write over.
  if (hit && (hit.source === "project" || hit.learned)) {
    const own = rules.findLast((r) => r.source === "global" && !r.learned && match(permission, r.permission) && match(pattern, r.pattern))
    if (own && RANK[own.action] > RANK[hit.action]) return own
  }
  // "Always allow git push *" must not undo a configured "git push --force *": deny.
  if (hit?.learned) {
    const written = rules.findLast((r) => !r.learned && match(permission, r.permission) && match(pattern, r.pattern))
    if (written?.action === "deny") return written
  }
  return hit
}

/** Whether an allow would cover something a written rule denies (its pattern, read as text,
 *  matches the allow): `git push *` covers `git push --force *`. */
export function shadowsDeny(allow: Rule, rules: Rule[]): boolean {
  return rules.some((r) => !r.learned && r.action === "deny" && match(allow.permission, r.permission) && match(r.pattern, allow.pattern))
}

function lookup(permission: string, pattern: string, rules: Rule[]): Action {
  return lookupRule(permission, pattern, rules)?.action ?? "ask"
}

const RANK: Record<Action, number> = { allow: 0, ask: 1, deny: 2 }
const strictest = (a: Action, b: Action): Action => (RANK[a] >= RANK[b] ? a : b)

export interface Context {
  mode: Mode
  rules: Rule[]
  hardline: HardlineRule[]
  /** Absolute project root; paths outside it are "external". */
  root: string
  /** Absolute plan directory: the one place plan mode may write. */
  planDir?: string
  /** The project directory (.agent): its config, agents, commands and skills are not edits. */
  projectDir?: string
}

const inside = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith("/") ? dir : dir + "/")

/** A path as the filesystem will see it: symlinks in its longest existing part resolved. So a
 *  link inside the project that points out of it is outside, and one to ~/.ssh is ~/.ssh. */
export function realPath(p: string, depth = 0): string {
  const rest: string[] = []
  let head = p
  for (;;) {
    try {
      return join(realpathSync(head), ...rest)
    } catch {
      // A link whose target does not exist yet is still a link: writing through it creates the
      // target, wherever that is. Followed by hand, as the filesystem would.
      try {
        if (depth < 40 && lstatSync(head).isSymbolicLink()) return realPath(join(resolve(dirname(head), readlinkSync(head)), ...rest), depth + 1)
      } catch {}
      const up = dirname(head)
      if (up === head) return p
      rest.unshift(basename(head))
      head = up
    }
  }
}

/** Files edit mode does not change unasked: git's own (config and hooks run programs) and the
 *  project's config, agents, commands and skills (they change what LLeMbas CLI itself does). */
function guardedEdit(p: string, projectDir?: string): boolean {
  if (p.split("/").includes(".git")) return true
  if (!projectDir || !inside(p, projectDir)) return false
  const rel = relative(projectDir, p)
  return rel.endsWith("config.yaml") || /^(agents|commands|skills)(\/|$)/.test(rel)
}

const DEVICES = /^\/dev\/(null|zero|stdin|stdout|stderr|tty|u?random)$/
const PATTERN_FIRST = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack"])

const MAX_GLOB = 500

/** What a glob names, as the shell would expand it — dotfiles included, to be safe. Undefined
 *  when it names too many to judge one by one. */
function expandGlob(abs: string): string[] | undefined {
  const parts = abs.split("/")
  const at = parts.findIndex((x) => /[*?[]/.test(x))
  const base = parts.slice(0, at).join("/") || "/"
  const out: string[] = []
  try {
    for (const f of new Bun.Glob(parts.slice(at).join("/")).scanSync({ cwd: base, dot: true, onlyFiles: false, followSymlinks: false })) {
      out.push(join(base, f))
      if (out.length > MAX_GLOB) return undefined
    }
  } catch {}
  return out.length ? out : [abs]
}

/** The files a command names, absolute: its arguments that are not options (a search tool's
 *  pattern excepted), what an input redirection reads, and what a glob expands to. A word that is
 *  not really a path resolves inside the directory, harmlessly. `unsure`: a glob too wide to judge. */
function commandPaths(commands: string[], cwd: string): { paths: string[]; unsure: boolean } {
  const out: string[] = []
  let unsure = false
  const add = (a: string) => {
    const home = a === "~" || a.startsWith("~/") ? join(homedir(), a.slice(1)) : a.replace(/^\$\{?HOME\}?(?=\/|$)/, homedir())
    const abs = resolve(cwd, home)
    if (!/[*?[]/.test(abs)) return void out.push(abs)
    const all = expandGlob(abs)
    if (all) out.push(...all)
    else unsure = true
  }
  for (const c of commands) {
    const w = words(c)
    // rg --files lists files: there is no pattern to skip, the first word is a path.
    let skipPattern = PATTERN_FIRST.has(basename(w[0] ?? "")) && !w.some((x) => x === "-e" || x.startsWith("--regexp") || x === "-f" || x === "--files")
    let afterRedirect = false
    let readNext = false
    for (const a of w.slice(1)) {
      // An input redirection reads a file just as an argument does: `cat < f`, `cat 0<f`.
      const input = /^\d*<(?![<>(])(.*)$/.exec(a)
      if (input) {
        if (input[1]) add(input[1])
        else readNext = true
        continue
      }
      if (readNext) {
        readNext = false
        add(a)
        continue
      }
      if (/^\d*>/.test(a) || a === "&>" || a === "&>>") {
        afterRedirect = true
        continue
      }
      if (afterRedirect) {
        afterRedirect = false
        continue
      }
      if (!a || a.startsWith("-") || DEVICES.test(a)) continue
      if (skipPattern) {
        skipPattern = false
        continue
      }
      add(a)
    }
  }
  return { paths: out, unsure }
}

export function evaluate(req: PermissionRequest, ctx: Context): Decision {
  const d = evaluateRules(req, ctx)
  if (req.alwaysAsk && d.action !== "deny") return { action: "ask", reason: req.alwaysAsk, always: [] }
  return d
}

function evaluateRules(req: PermissionRequest, ctx: Context): Decision {
  // 1. The floor.
  if (req.command) {
    const hit = hardlineCommand(req.command, ctx.hardline)
    if (hit) return { action: "deny", reason: `refused: ${hit.description} (hardline rule ${hit.id})`, always: [] }
  }
  // Where each path really is: a symlink is judged by what it points to.
  const root = realPath(ctx.root)
  const real = (req.paths ?? []).map(realPath)
  if (req.class === "write") {
    for (const [i, p] of real.entries()) {
      const guarded = protectedPath(req.paths![i]!) ?? protectedPath(p)
      if (guarded) return { action: "deny", reason: `refused: ${guarded} is never written by a tool`, always: [] }
    }
  }

  // 2. Rules. Every pattern is looked up; the strictest answer wins.
  let patterns = req.patterns
  let unsafe: string[] = []
  if (req.command !== undefined) {
    const split = splitCommand(req.command)
    patterns = split.commands.length ? split.commands : [req.command]
    unsafe = split.unsafe
  }
  let ruled: Action = "allow"
  for (const p of patterns.length ? patterns : ["*"]) ruled = strictest(ruled, lookup(req.permission, p, ctx.rules))
  // An allow cannot be trusted when the line does something the split cannot see.
  if (ruled === "allow" && unsafe.length) ruled = "ask"
  // A written deny is not walked past by another spelling: `sudo -u x git push`, `env A=1 git
  // push`, `timeout 5 git push` or `sh -c "git push"` is also judged as plain `git push`. Only a
  // deny is taken from the plain spelling; an allow there would loosen what the line asks.
  if (req.command !== undefined && ruled !== "deny")
    for (const p of plainCommands(req.command)) if (lookup(req.permission, p, ctx.rules) === "deny") ruled = "deny"

  // A command is also judged by the files it names: `cat .env` reads .env, `cat ~/.ssh/id` is
  // outside the project, whatever the allow rule for `cat *` says.
  let named: string[] = []
  if (req.command !== undefined) {
    const c = commandPaths(patterns, real[0] ?? root)
    named = c.paths.map(realPath)
    if (c.unsure && ruled === "allow") ruled = "ask"
  }
  // Reading a file by another tool (grep, glob, list) or a command follows the read rules too.
  if (req.permission !== "read" && (req.class === "read" || req.command !== undefined))
    for (const p of [...(req.command === undefined ? real : []), ...named])
      if (inside(p, root)) ruled = strictest(ruled, lookup("read", relative(root, p) || ".", ctx.rules))
  // And read by where it really is: a link named notes.txt that points at .env reads .env.
  if (req.permission === "read")
    for (const p of real) if (inside(p, root)) ruled = strictest(ruled, lookup("read", relative(root, p) || ".", ctx.rules))

  const external = [...real, ...named].filter((p) => !inside(p, root))
  let externalAction: Action = "allow"
  for (const p of external) externalAction = strictest(externalAction, lookup("external_directory", p, ctx.rules))

  const always = alwaysPatterns(req, patterns)

  if (ruled === "deny") return { action: "deny", reason: "denied by permission rules", always }
  if (externalAction === "deny") return { action: "deny", reason: `outside the project: ${external.join(", ")}`, always }

  // 3. The mode.
  switch (ctx.mode) {
    case "auto":
      return { action: "allow", reason: "auto mode", always }

    case "plan": {
      const planDir = ctx.planDir === undefined ? undefined : realPath(ctx.planDir)
      const planWrite =
        req.class === "write" && planDir !== undefined && inside(planDir, root) && real.length > 0 && real.every((p) => inside(p, planDir))
      if (planWrite) return { action: "allow", reason: "plan file", always }
      if (req.class === "read" || req.class === "interact") return withExternal(ruled, externalAction, external, always)
      if (ruled === "allow") return withExternal("allow", externalAction, external, always)
      return {
        action: "deny",
        reason: "plan mode: only reading and already-approved actions; write the plan under .agent/plans and call plan_submit",
        always,
      }
    }

    case "edit": {
      // Files, named: a tool that touches no path (skill_manage, an MCP tool) is not file work,
      // whatever its class, and keeps asking.
      const projectDir = ctx.projectDir === undefined ? undefined : realPath(ctx.projectDir)
      const fileWork =
        (req.class === "read" || req.class === "write") &&
        req.command === undefined &&
        real.length > 0 &&
        !(req.class === "write" && real.some((p) => guardedEdit(p, projectDir)))
      // Edit mode lifts the catch-all `"*": ask`, not a rule somebody wrote for this tool
      // (reading `.env` still asks).
      const specificAsk = patterns.some((p) => {
        const r = lookupRule(req.permission, p, ctx.rules)
        return r?.action === "ask" && r.permission !== "*"
      })
      if (fileWork && external.length === 0 && !specificAsk) return { action: "allow", reason: "edit mode", always }
      return withExternal(ruled, externalAction, external, always)
    }

    case "manual":
      return withExternal(ruled, externalAction, external, always)
  }
}

function withExternal(ruled: Action, ext: Action, external: string[], always: string[]): Decision {
  const action = strictest(ruled, ext)
  const reason = action === "allow" ? "allowed by rules" : ext !== "allow" ? `outside the project: ${external.join(", ")}` : "needs approval"
  return { action, reason, always }
}

/** Commands that run another command, or can: approving one with `*` would approve anything. */
const EXACT_ONLY = new Set(ARITY.exact_only)

/** "Always allow" patterns: the arity prefix of each command (`git commit *`), or the exact paths.
 *  None for a line of several commands where one runs others (`curl x | sh`, `find . | xargs rm`):
 *  "always" would store `curl *` and `sh`, and from then on any `curl … | sh` ran unasked. */
export function alwaysPatterns(req: PermissionRequest, patterns: string[]): string[] {
  if (req.always) return req.always
  if (req.command === undefined) return patterns
  if (patterns.length > 1 && patterns.some((c) => EXACT_ONLY.has(basename(words(c)[0] ?? "")))) return []
  const out = new Set<string>()
  for (const c of patterns) {
    const w = words(c)
    if (EXACT_ONLY.has(basename(w[0] ?? ""))) {
      out.add(c)
      continue
    }
    const head = prefix(w)
    if (!head.length) continue
    out.add(head.length < w.length ? `${head.join(" ")} *` : head.join(" "))
  }
  return [...out]
}
