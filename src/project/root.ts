import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { parseDocument } from "yaml"
import { paths } from "../config/paths.ts"
import type { Rule } from "../permission/evaluate.ts"
import { assertProjectFile } from "./safe.ts"

export interface Project {
  root: string
  /** `.agent`, or `.lembas` when `.agent` is already something else's. */
  dir: string
  gitRoot?: string
  exists: boolean
}

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory()

/** The names the per-project directory goes by: `.agent`, or `.lembas` when `.agent` is
 *  something else's. */
export const PROJECT_DIR_NAMES = [".agent", ".lembas"] as const

/** What git must not see of any of them: each one's per-user state. */
export const LOCAL_DIRS = PROJECT_DIR_NAMES.map((n) => `${n}/local/`)

// `.agent` is a name other tools use too (`.agent/` for several agents' rules and workflows), so
// it counts as ours only with something of ours in it: the config, plans, the task board or the
// per-user state. `.lembas` is ours by name.
const GENERIC = new Set([".agent"])
const MARKERS = ["config.yaml", "plans", "tasks.md", "local"]
const marked = (dir: string) => MARKERS.some((m) => existsSync(join(dir, m)))
/** A project directory of ours at `root`, under `name`. */
const ours = (root: string, name: string) => isDir(join(root, name)) && (!GENERIC.has(name) || marked(join(root, name)))
const empty = (dir: string) => {
  try {
    return readdirSync(dir).length === 0
  } catch {
    return false
  }
}

/** The name of the per-project directory under `root`: the one of ours already there, else
 *  `.agent` — or `.lembas`, when `.agent` is something else's (a file, or a directory with things
 *  in it but nothing of ours). An empty `.agent` is taken: there is nothing in it to collide with. */
export function projectDirName(root: string): string {
  const existing = PROJECT_DIR_NAMES.find((n) => ours(root, n))
  if (existing) return existing
  const primary = join(root, ".agent")
  if (existsSync(primary) && !(isDir(primary) && empty(primary))) return ".lembas"
  return ".agent"
}

export function findGitRoot(start: string): string | undefined {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir
    if (dirname(dir) === dir) return undefined
  }
}

/** Nearest ancestor with a project directory; otherwise the git root; otherwise `cwd` itself. */
export function findProject(cwd: string): Project {
  const gitRoot = findGitRoot(cwd)
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    // An unmarked `.agent` is passed over, so a `.lembas` beside somebody else's `.agent` is still
    // the project's.
    for (const name of PROJECT_DIR_NAMES) if (ours(dir, name)) return { root: dir, dir: join(dir, name), gitRoot, exists: true }
    if (dir === gitRoot || dirname(dir) === dir) break
  }
  const root = gitRoot ?? resolve(cwd)
  return { root, dir: join(root, projectDirName(root)), gitRoot, exists: false }
}

// ── trust ────────────────────────────────────────────────────────────────────────────────────
// A project's own config, commands and MCP servers are honoured only once its root is trusted.

type TrustLevel = "trusted" | "readonly"

function trustFile() {
  return join(paths.state, "trust.json")
}

function readTrust(): Record<string, TrustLevel> {
  try {
    return JSON.parse(readFileSync(trustFile(), "utf8"))
  } catch {
    return {}
  }
}

export function trustOf(root: string): TrustLevel | undefined {
  return readTrust()[resolve(root)]
}

/** Every directory trusted on this machine. */
export function trustedRoots(): string[] {
  return Object.entries(readTrust())
    .filter(([, level]) => level === "trusted")
    .map(([dir]) => dir)
}

/** Whether `dir` is a trusted directory or inside one — what a remote session needs. A git
 *  repository inside a trusted home is its own project, and its own `.agent` config still needs
 *  its own trust to be read; but the person who trusted the directory around it has said work may
 *  happen anywhere in there. */
export function trustedWithin(dir: string): boolean {
  const target = resolve(dir)
  return trustedRoots().some((t) => target === t || target.startsWith(t.endsWith("/") ? t : `${t}/`))
}

export function setTrust(root: string, level: TrustLevel) {
  const t = readTrust()
  t[resolve(root)] = level
  mkdirSync(paths.state, { recursive: true })
  writeFileSync(trustFile(), JSON.stringify(t, null, 2))
}

/** "Always allow (project)": add the rule to the project's config.yaml, keeping its comments. */
export function persistProjectRule(project: Project, rule: Rule) {
  const file = join(project.dir, "config.yaml")
  mkdirSync(project.dir, { recursive: true })
  assertProjectFile(file, project.root)
  const doc = parseDocument(existsSync(file) ? readFileSync(file, "utf8") : "")
  if (!doc.contents) doc.contents = doc.createNode({}) as never
  const current = doc.getIn(["permission", rule.permission])
  if (typeof current === "string") {
    doc.setIn(["permission", rule.permission], doc.createNode({ "*": current }))
  }
  doc.setIn(["permission", rule.permission, rule.pattern], rule.action)
  writeFileSync(file, doc.toString())
}
