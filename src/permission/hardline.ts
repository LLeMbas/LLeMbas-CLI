// The floor: commands that are refused in every mode, auto included, and that no
// project config can re-enable. Patterns ported from Hermes Agent tools/approval_detection.py
// HARDLINE_PATTERNS (MIT, © 2025 Nous Research), plus LLeMbas CLI's own (force-push to main).
import { homedir } from "node:os"
import { basename, join, posix, resolve } from "node:path"
import { globalPaths, localRoot, paths } from "../config/paths.ts"
import { splitCommand, words } from "./bash.ts"
import SPEC from "../../harness/permission/hardline.json"

export interface HardlineRule {
  id: string
  description: string
  re: RegExp
}

const rule = (id: string, description: string, src: string): HardlineRule => ({ id, description, re: new RegExp(src, SPEC.flags) })

// The rules themselves are the harness spec's (harness/permission/hardline.json), which LLeMbas
// checks commands against too.
export const BUILTIN_HARDLINE: HardlineRule[] = SPEC.rules.map((r) => rule(r.id, r.description, r.pattern))

export interface HardlineOptions {
  extra?: string[]
  disable?: string[]
}

export function hardlineRules(opts: HardlineOptions = {}): HardlineRule[] {
  const disabled = new Set(opts.disable ?? [])
  const rules = BUILTIN_HARDLINE.filter((r) => !disabled.has(r.id))
  for (const [i, src] of (opts.extra ?? []).entries()) rules.push(rule(`extra-${i}`, `configured: ${src}`, src))
  return rules
}

/** The rule a command line trips, if any. Checked on the raw line, so splitting cannot hide one,
 *  and on each command in a plain spelling, so writing it differently cannot hide one either. */
export function hardlineCommand(line: string, rules: HardlineRule[]): HardlineRule | undefined {
  for (const l of [line, ...plainCommands(line)]) {
    const hit = rules.find((r) => r.re.test(l))
    if (hit) return hit
  }
  return undefined
}

// Commands that run the rest of their words as a command, and their options that take a value;
// shell keywords; shells whose -c is a command line; git's options that take a value — the spec's.
const WRAPPERS: Record<string, string[]> = SPEC.plain.wrappers
const KEYWORDS = new Set(SPEC.plain.keywords)
const SHELLS = new Set(SPEC.plain.shells)
const GIT_VALUE = new Set(SPEC.plain.git_value_options)

function plainPath(a: string): string {
  const home = homedir()
  let p = a === "~" || a.startsWith("~/") ? home + a.slice(1) : a.replace(/^\$\{?HOME\}?(?=\/|$)/, home)
  if (!p.startsWith("/")) return a
  p = posix.normalize(p)
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1)
  if (p === home) return "~"
  if (p.startsWith(home + "/")) return "~" + p.slice(home.length)
  return p
}

/** Each simple command of a line, rewritten plainly: no VAR= prefixes, wrappers (sudo -u x, env
 *  -i, timeout 5, xargs…), quotes, escapes or program paths; paths normalised (`/etc/` is /etc,
 *  the home directory is ~); `sh -c "…"` read as the line it runs. */
export function plainCommands(line: string, depth = 0): string[] {
  if (depth > 3) return []
  const out: string[] = []
  // What a substitution runs is a command too: `echo $(git push)` runs `git push`. Read from
  // inside each $( … ) and ` … `, so neither a rule nor the floor is walked past by wrapping a
  // command in one.
  for (const inner of substitutions(line)) out.push(...plainCommands(inner, depth + 1))
  for (const c of splitCommand(line).commands) {
    let w = words(c).map((x) => x.replace(/^\(+/, "").replace(/\)+$/, "")).filter((x) => x !== "")
    for (;;) {
      while (w.length && (KEYWORDS.has(w[0]!) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]!))) w = w.slice(1)
      const prog = basename(w[0] ?? "")
      const takes = WRAPPERS[prog]
      if (!takes) break
      let i = 1
      while (i < w.length) {
        const a = w[i]!
        if (a === "--") {
          i++
          break
        }
        if (prog === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) {
          i++
          continue
        }
        if (prog === "env" && (a === "-S" || a.startsWith("--split-string"))) {
          const inner = a.includes("=") ? a.slice(a.indexOf("=") + 1) : w[i + 1]
          if (inner) out.push(...plainCommands(inner, depth + 1))
          i = w.length
          break
        }
        if (!a.startsWith("-")) break
        i += takes.includes(a) ? 2 : 1
      }
      // timeout's first word after its options is the duration.
      if (prog === "timeout" && i < w.length) i++
      w = w.slice(i)
    }
    if (!w.length) continue
    const prog = basename(w[0]!)
    let args = w.slice(1)
    if (SHELLS.has(prog)) {
      const flag = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a))
      if (flag >= 0 && args[flag + 1] !== undefined) out.push(...plainCommands(args[flag + 1]!, depth + 1))
    }
    if (prog === "git") {
      let i = 0
      while (i < args.length && args[i]!.startsWith("-")) i += GIT_VALUE.has(args[i]!) ? 2 : 1
      args = args.slice(i)
    }
    const quote = (x: string) => (/[\s;&|`$()<>'"]/.test(x) ? `'${x.replace(/'/g, "")}'` : x)
    out.push([prog, ...args.map(plainPath)].map(quote).join(" "))
  }
  return out
}

/** The command lines inside a line's $( … ) and ` … ` substitutions (outermost first; nested ones
 *  are found when each is read in turn). Inside single quotes nothing is a substitution. */
export function substitutions(line: string): string[] {
  const out: string[] = []
  let quote: "'" | '"' | null = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (quote === "'") {
      if (ch === "'") quote = null
      continue
    }
    if (ch === "\\") {
      i++
      continue
    }
    if (ch === "'" && !quote) {
      quote = "'"
      continue
    }
    if (ch === '"') {
      quote = quote === '"' ? null : '"'
      continue
    }
    if (ch === "$" && line[i + 1] === "(" && line[i + 2] !== "(") {
      let depth = 0
      let j = i + 1
      for (; j < line.length; j++) {
        if (line[j] === "(") depth++
        else if (line[j] === ")" && --depth === 0) break
      }
      out.push(line.slice(i + 2, j))
      i = j
      continue
    }
    if (ch === "`") {
      const end = line.indexOf("`", i + 1)
      if (end === -1) break
      out.push(line.slice(i + 1, end))
      i = end
    }
  }
  return out
}

/** Paths no tool may write, whatever the mode (the spec's, plus LLeMbas CLI's own connections.yaml).
 *  `<config>/` is guarded in the user's config directory and, in local mode, in the local one too. */
export function protectedPath(abs: string): string | undefined {
  const home = homedir()
  const configs = [...new Set([paths.config, globalPaths.config])]
  const guarded: [string, string][] = SPEC.protected_paths.flatMap((g) =>
    g.path.startsWith("<config>/")
      ? configs.map((c): [string, string] => [resolve(c, g.path.slice("<config>/".length)), g.label ?? g.path])
      : [[g.path.startsWith("~/") ? resolve(home, g.path.slice(2)) : g.path, g.label ?? g.path] as [string, string]],
  )
  for (const [p, label] of guarded) if (abs === p || abs.startsWith(p + "/")) return label
  // Local mode keeps its config, keys, trust and sessions inside the project, where edit mode would
  // otherwise let a tool rewrite them: no tool writes there — the program does, as it does in
  // ~/.config. Except the worktrees, which are where a session may work.
  const root = localRoot()
  const inside = (p: string) => abs === p || abs.startsWith(p + "/")
  if (root && inside(root) && !inside(join(root, "data", "worktrees"))) return "local mode's own files"
  return undefined
}
