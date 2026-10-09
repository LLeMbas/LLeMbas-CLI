// The first time LLeMbas CLI opens a directory: trust, git, and the .agent skeleton.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { paths } from "../config/paths.ts"
import type { Project } from "./root.ts"

const CONFIG_TEMPLATE = `# LLeMbas CLI settings for this project. Merged over ~/.config/lembas/config.yaml,
# and read only while the project is trusted. Connections cannot be set here.
#
# mode: edit                     # manual | edit | auto | plan
# model: connection/model
# permission:
#   bash:
#     "npm test *": allow
#     "npm publish *": deny
`

/** Create the project directory (config template, plans/, commands/, skills/, agents/, local/). */
export function initProjectDir(p: Project): string[] {
  const made: string[] = []
  for (const sub of ["", "plans", "commands", "skills", "agents", "local"]) {
    const d = join(p.dir, sub)
    if (!existsSync(d)) {
      mkdirSync(d, { recursive: true })
      made.push(relative(p.root, d) || ".")
    }
  }
  const cfg = join(p.dir, "config.yaml")
  if (!existsSync(cfg)) {
    writeFileSync(cfg, CONFIG_TEMPLATE)
    made.push(relative(p.root, cfg))
  }
  return made
}

/** Keep `.agent/local/` (per-user state) out of git. Returns true when .gitignore changed. */
export function ignoreLocal(p: Project): boolean {
  if (!p.gitRoot) return false
  const file = join(p.gitRoot, ".gitignore")
  const entry = `/${relative(p.gitRoot, join(p.dir, "local"))}/`
  const text = existsSync(file) ? readFileSync(file, "utf8") : ""
  if (text.split("\n").some((l) => l.trim() === entry || l.trim() === entry.slice(1))) return false
  appendFileSync(file, `${text && !text.endsWith("\n") ? "\n" : ""}# LLeMbas CLI per-user state\n${entry}\n`)
  return true
}

// ── per-directory preferences: "never offer git init here" ─────────────────────────────────
function prefsFile() {
  return join(paths.state, "projects.json")
}

type Prefs = Record<string, { gitInit?: "never" }>

function readPrefs(): Prefs {
  try {
    return JSON.parse(readFileSync(prefsFile(), "utf8"))
  } catch {
    return {}
  }
}

export function neverGitInit(root: string): boolean {
  return readPrefs()[root]?.gitInit === "never"
}

export function setNeverGitInit(root: string) {
  const p = readPrefs()
  p[root] = { ...p[root], gitInit: "never" }
  mkdirSync(paths.state, { recursive: true })
  writeFileSync(prefsFile(), JSON.stringify(p, null, 2))
}
