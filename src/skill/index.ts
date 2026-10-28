// Skills, after Hermes Agent (tools/skills_tool.py, agent/skill_utils.py, agent/prompt_builder.py,
// agent/skill_commands.py; MIT, © Nous Research): a directory with a SKILL.md (YAML frontmatter
// with a name and a description, then instructions) and optional references/, templates/,
// scripts/ and assets/. Only the name and the first line of the description go into the system
// prompt; the model loads the rest with skill_view when a task calls for it.
//
// Where they are found, a same-named skill in an earlier place winning:
//   .agent/skills/ (a trusted project) → ~/.config/lembas/skills/ → config skills.external_dirs
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { platform } from "node:os"
import { basename, join, relative } from "node:path"
import { parse } from "yaml"
import { expandHome, paths } from "../config/paths.ts"

export interface Skill {
  name: string
  description: string
  category?: string
  tags: string[]
  related: string[]
  dir: string
  file: string
  source: "project" | "global" | "external"
}

export const SUPPORT_DIRS = ["references", "templates", "scripts", "assets"] as const
const SKIP = new Set([".git", ".github", ".archive", ".venv", "venv", "node_modules", "site-packages", "__pycache__", ...SUPPORT_DIRS])
/** A name skill_manage makes (filesystem.md, *Skills*; the Agent Skills format's rule): lowercase
 *  letters, digits and -, starting with a letter or a digit, at most MAX_NAME. */
export const NAME = /^[a-z0-9][a-z0-9-]*$/
/** A category directory's name. */
export const CATEGORY = /^[a-z0-9][a-z0-9._-]*$/
export const MAX_NAME = 64
export const MAX_DESCRIPTION = 1024
export const INDEX_DESCRIPTION = 60
export const MAX_FILE = 100_000
const OS: Record<string, string> = { linux: "linux", darwin: "macos", win32: "windows" }

export const globalSkillsDir = () => join(paths.config, "skills")

/** The frontmatter and the body. Malformed YAML falls back to `key: value` lines, as Hermes does. */
export function splitFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } | undefined {
  const text = raw.replace(/^﻿/, "").replace(/\r\n/g, "\n")
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text)
  if (!m) return undefined
  let meta: Record<string, unknown> = {}
  try {
    const y = parse(m[1]!)
    if (y && typeof y === "object" && !Array.isArray(y)) meta = y as Record<string, unknown>
  } catch {
    for (const line of m[1]!.split("\n")) {
      const kv = /^([\w-]+):\s*(.*)$/.exec(line)
      if (kv) meta[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, "")
    }
  }
  return { meta, body: text.slice(m[0].length) }
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [])

function readSkill(file: string, root: string, source: Skill["source"]): Skill | undefined {
  let raw: string
  try {
    raw = readFileSync(file, "utf8").slice(0, 4000)
  } catch {
    return undefined
  }
  const fm = splitFrontmatter(raw)
  if (!fm) return undefined
  const dir = join(file, "..")
  const hermes = ((fm.meta.metadata as any)?.hermes ?? {}) as Record<string, unknown>
  // A skill for another OS is not offered.
  const platforms = list(fm.meta.platforms)
  if (platforms.length && !platforms.map((p) => p.toLowerCase()).includes(OS[platform()] ?? platform())) return undefined
  const rel = relative(root, dir).split("/")
  // The name goes into the system prompt and becomes a command: one line, the length of a name.
  const name = String(fm.meta.name ?? basename(dir)).replace(/\s+/g, " ").trim()
  if (!name || name.length > MAX_NAME || /[<>]/.test(name)) return undefined
  return {
    name,
    description: String(fm.meta.description ?? "").trim().replace(/\s+/g, " "),
    category: rel.length > 1 ? rel.slice(0, -1).join("/") : typeof hermes.category === "string" ? hermes.category : undefined,
    tags: list(fm.meta.tags ?? hermes.tags),
    related: list(fm.meta.related_skills ?? hermes.related_skills),
    dir,
    file,
    source,
  }
}

function scan(root: string, source: Skill["source"], dir = root, depth = 0): Skill[] {
  if (!existsSync(dir) || depth > 3) return []
  if (depth > 0 && existsSync(join(dir, "SKILL.md"))) {
    const s = readSkill(join(dir, "SKILL.md"), root, source)
    return s ? [s] : []
  }
  let names: string[] = []
  try {
    names = readdirSync(dir).sort()
  } catch {
    return []
  }
  return names.filter((n) => !SKIP.has(n) && !n.startsWith(".")).flatMap((n) => {
    const p = join(dir, n)
    try {
      return statSync(p).isDirectory() ? scan(root, source, p, depth + 1) : []
    } catch {
      return []
    }
  })
}

export interface SkillSources {
  /** .agent of a trusted project. */
  projectDir?: string
  external?: string[]
  disabled?: string[]
}

/** Every skill, a same-named one from an earlier place winning. */
export function loadSkills(src: SkillSources = {}): Skill[] {
  const byName = new Map<string, Skill>()
  const places: [string, Skill["source"]][] = [
    ...(src.projectDir ? [[join(src.projectDir, "skills"), "project"] as [string, Skill["source"]]] : []),
    [globalSkillsDir(), "global"],
    ...(src.external ?? []).map((d) => [expandHome(d), "external"] as [string, Skill["source"]]),
  ]
  for (const [dir, source] of places) for (const s of scan(dir, source)) if (!byName.has(s.name) && !src.disabled?.includes(s.name)) byName.set(s.name, s)
  return [...byName.values()].sort((a, b) => (a.category ?? "").localeCompare(b.category ?? "") || a.name.localeCompare(b.name))
}

export function findSkill(skills: Skill[], name: string): Skill | undefined {
  const n = name.trim().toLowerCase()
  return skills.find((s) => s.name.toLowerCase() === n) ?? skills.find((s) => slug(s.name) === slug(n))
}

/** The name as a slash command: lowercase, `_` and spaces as `-`. */
export const slug = (name: string) => name.toLowerCase().replace(/[\s_]+/g, "-").replace(/[^\w-]/g, "").replace(/-+/g, "-")

/** Supporting files, relative to the skill's directory. */
export function linkedFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string, depth: number) => {
    if (!existsSync(d) || depth > 4) return
    let names: string[]
    try {
      names = readdirSync(d).sort()
    } catch {
      return
    }
    for (const n of names) {
      const p = join(d, n)
      // A dangling link or an unreadable entry is left out, not a reason to fail the skill.
      try {
        if (!within(dir, p)) continue
        if (statSync(p).isDirectory()) walk(p, depth + 1)
        else out.push(relative(dir, p))
      } catch {}
    }
  }
  for (const sub of SUPPORT_DIRS) walk(join(dir, sub), 0)
  return out
}

const short = (d: string) => (d.length > INDEX_DESCRIPTION ? d.slice(0, INDEX_DESCRIPTION - 3) + "..." : d)

/** The list for the system prompt's skills block (harness/prompts/blocks/skills.md), by category. */
export function skillLines(skills: Skill[]): string {
  const groups = new Map<string, Skill[]>()
  for (const s of skills) groups.set(s.category ?? "general", [...(groups.get(s.category ?? "general") ?? []), s])
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([cat, ss]) => [`  ${cat}:`, ...ss.map((s) => `    - ${s.source === "project" ? "[project] " : ""}${s.name}: ${short(s.description)}`)])
    .join("\n")
}

/** The user turn a /skill command sends (Hermes' wording, adapted). */
export function skillMessage(s: Skill, instruction: string): string {
  const body = splitFrontmatter(readFileSync(s.file, "utf8"))?.body.trim() ?? ""
  const files = linkedFiles(s.dir)
  return [
    `[IMPORTANT: The user has invoked the "${s.name}" skill: follow its instructions. The full skill is below.]`,
    "",
    body,
    "",
    `[Skill directory: ${s.dir}]`,
    "Resolve relative paths in this skill (scripts/…, templates/…) against that directory.",
    ...(files.length ? ["", "[Supporting files — load one with skill_view(name, file_path), or run a script by its absolute path:]", ...files.map((f) => `- ${f}`)] : []),
    ...(instruction.trim() ? ["", `The user's instruction with it: ${instruction.trim()}`] : []),
  ].join("\n")
}

/** Whether a path, symlinks followed, is inside a directory (Hermes' validate_within_dir). A path
 *  that does not exist yet is judged by its nearest existing parent. */
export function within(dir: string, p: string): boolean {
  let head = p
  const rest: string[] = []
  for (;;) {
    try {
      const real = join(realpathSync(head), ...rest)
      const base = realpathSync(dir)
      return real === base || real.startsWith(base + "/")
    } catch {
      const up = join(head, "..")
      if (up === head) return false
      rest.unshift(basename(head))
      head = up
    }
  }
}

/** Read a file inside a skill's directory; never outside it. */
export function skillFile(s: Skill, rel: string): string {
  if (!rel || rel.startsWith("/") || /^[A-Za-z]:/.test(rel) || rel.split(/[\\/]/).includes("..")) throw new Error(`"${rel}" is not a path inside the skill`)
  const p = join(s.dir, rel)
  if (existsSync(p) && !within(s.dir, p)) throw new Error(`"${rel}" leads out of the skill's directory`)
  if (!existsSync(p) || !statSync(p).isFile()) throw new Error(`${s.name} has no ${rel}. Its files: ${linkedFiles(s.dir).join(", ") || "(none)"}`)
  return readFileSync(p, "utf8")
}

/** For write and apply_patch: a SKILL.md written outside every place skills are loaded from is not
 *  a skill. Models asked to "save a skill" do this; the note sends them to skill_manage. */
export function straySkillNote(paths: string[], ctx: { skills?: { list(): Skill[]; projectDir?: string } }): string {
  if (!ctx.skills) return ""
  const roots = [globalSkillsDir(), ...(ctx.skills.projectDir ? [join(ctx.skills.projectDir, "skills")] : [])]
  const stray = paths.filter((p) => /skill.*\.md$|^skill\.md$/i.test(basename(p)) && !roots.some((r) => p.startsWith(r + "/")))
  return stray.length ? `\nNote: a SKILL.md here is an ordinary file — LLeMbas CLI does not load it as a skill. To save a skill, use skill_manage (create).` : ""
}
