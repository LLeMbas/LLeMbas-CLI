// skills_list, skill_view and skill_manage, after Hermes Agent (tools/skills_tool.py,
// tools/skill_manager_tool.py; MIT, © Nous Research). See src/skill/index.ts.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join, relative } from "node:path"
import { paths } from "../config/paths.ts"
import { z } from "zod"
import { threatMessage } from "../memory/threats.ts"
import { CATEGORY, within, findSkill, globalSkillsDir, INDEX_DESCRIPTION, linkedFiles, loadSkills, MAX_DESCRIPTION, MAX_FILE, MAX_NAME, NAME, type Skill, skillFile, splitFrontmatter, SUPPORT_DIRS } from "../skill/index.ts"
import { replace } from "./replace-text.ts"
import { defineTool, ToolError, type ToolContext } from "./tool.ts"
import { described } from "../harness.ts"
import { CLI_VARS } from "./spec-vars.ts"

const skillsOf = (ctx: ToolContext): Skill[] => ctx.skills?.list() ?? loadSkills()

export const skillsListTool = defineTool({
  ...described("skills_list", CLI_VARS.skills_list),
  purpose: false,
  access: "skills",
  schema: z.object({ category: z.string().optional() }),
  permission: () => ({ permission: "skills", class: "read", patterns: ["list"] }),
  async run(a, ctx) {
    const all = skillsOf(ctx)
    const shown = a.category ? all.filter((s) => (s.category ?? "general") === a.category) : all
    if (!shown.length) return { output: a.category ? `No skills in "${a.category}". Categories: ${[...new Set(all.map((s) => s.category ?? "general"))].join(", ") || "(none)"}` : "No skills yet.", title: "0 skills" }
    const out = shown.map((s) => `${s.name}${s.category ? ` [${s.category}]` : ""}${s.source === "project" ? " (project)" : ""} — ${s.description.slice(0, MAX_DESCRIPTION)}`)
    return { output: `${out.join("\n")}\n\nLoad one with skill_view(name).`, title: `${shown.length} skills` }
  },
})

export const skillViewTool = defineTool({
  ...described("skill_view", CLI_VARS.skill_view),
  purpose: false,
  access: "skills",
  schema: z.object({
    name: z.string(),
    file_path: z.string().optional(),
  }),
  permission: (a) => ({ permission: "skills", class: "read", patterns: [a.name] }),
  async run(a, ctx) {
    const skills = skillsOf(ctx)
    const s = findSkill(skills, a.name)
    if (!s) throw new ToolError(`There is no skill "${a.name}". Skills: ${skills.map((x) => x.name).join(", ") || "(none)"}`)
    if (a.file_path) {
      try {
        return { output: skillFile(s, a.file_path).slice(0, MAX_FILE), title: `${s.name}/${a.file_path}` }
      } catch (e) {
        throw new ToolError((e as Error).message)
      }
    }
    const body = splitFrontmatter(readFileSync(s.file, "utf8"))?.body.trim() ?? ""
    const files = linkedFiles(s.dir)
    const head = [`# Skill: ${s.name}`, s.description, `Directory: ${s.dir}`, ...(s.related.length ? [`Related skills: ${s.related.join(", ")}`] : [])].join("\n")
    const tail = files.length ? `\n\nSupporting files (skill_view(name, file_path) reads one; run a script by its absolute path):\n${files.map((f) => `- ${f}`).join("\n")}` : ""
    return { output: `${head}\n\n${body.slice(0, MAX_FILE)}${tail}`, title: s.name }
  },
})

// Revisions (after LLeMbas's skill_revisions): every change keeps what it replaced, under the data
// directory — never beside the skills, where the loader would find the copies. `revert` puts the
// last one back, keeping the current state as a revision in its turn (so twice is no change).
const KEEP_REVISIONS = 20
const historyDir = (name: string) => join(paths.data, "skill-history", name)

function saveRevision(name: string, dir: string, files: Map<string, string>) {
  if (!files.size) return
  const at = join(historyDir(name), new Date().toISOString().replace(/[:.]/g, "-"))
  for (const [f, text] of files) {
    const to = join(at, "files", relative(dir, f))
    mkdirSync(dirname(to), { recursive: true })
    writeFileSync(to, text)
  }
  writeFileSync(join(at, "dir"), dir)
  const all = readdirSync(historyDir(name)).sort()
  for (const old of all.slice(0, Math.max(0, all.length - KEEP_REVISIONS))) rmSync(join(historyDir(name), old), { recursive: true, force: true })
}

/** Every file under a directory, by path — links are not followed, and not kept. */
function filesUnder(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  if (!existsSync(dir) || lstatSync(dir).isSymbolicLink()) return out
  for (const f of new Bun.Glob("**/*").scanSync({ cwd: dir, dot: false, followSymlinks: false })) {
    const p = join(dir, f)
    if (lstatSync(p).isFile()) out.set(p, readFileSync(p, "utf8"))
  }
  return out
}

export function revisions(name: string): string[] {
  return existsSync(historyDir(name)) ? readdirSync(historyDir(name)).sort() : []
}

const Op = z.object({
  action: z.enum(["create", "patch", "write_file", "remove_file", "delete", "revert"]),
  name: z.string(),
  description: z.string().optional(),
  instructions: z.string().optional(),
  content: z.string().optional(),
  category: z.string().optional(),
  where: z.enum(["global", "project"]).optional(),
  old_string: z.string().optional(),
  new_string: z.string().optional(),
  replace_all: z.boolean().optional(),
  file_path: z.string().optional(),
  file_content: z.string().optional(),
})
type Op = z.infer<typeof Op>

const SHAPE = (name: string) => `It must look like this:\n---\nname: ${name}\ndescription: Use when …\n---\n\nThe instructions.\n(Or send description and instructions instead of content, and the file is written for you.)`

/** A SKILL.md from its parts; YAML-quoted so a colon in the description cannot break it. */
export const composeSkill = (name: string, description: string, instructions: string) =>
  `---\nname: ${name}\ndescription: ${JSON.stringify(description.trim().replace(/\s+/g, " "))}\n---\n\n${instructions.trim()}\n`

/** What a SKILL.md must be: frontmatter with a valid name and a description, and a body. */
export function validateSkill(text: string, name: string): string | undefined {
  if (text.length > MAX_FILE) return `SKILL.md is ${text.length} characters; the limit is ${MAX_FILE}. Move detail into references/.`
  const fm = splitFrontmatter(text)
  if (!fm) return `SKILL.md must start with frontmatter between two --- lines. ${SHAPE(name)}`
  if (String(fm.meta.name ?? "") !== name) return `The frontmatter name must be "${name}".`
  const d = String(fm.meta.description ?? "").trim()
  if (!d) return `The frontmatter needs a description: one sentence saying when to use the skill. ${SHAPE(name)}`
  if (d.length > MAX_DESCRIPTION) return `The description is ${d.length} characters; the limit is ${MAX_DESCRIPTION}.`
  if (!fm.body.trim()) return `SKILL.md needs instructions after the closing --- line. ${SHAPE(name)}`
  return undefined
}

function supportPath(s: { dir: string }, rel?: string): string {
  if (!rel) throw new ToolError("file_path is needed")
  const parts = rel.split(/[\\/]/)
  if (rel.startsWith("/") || parts.includes("..") || !(SUPPORT_DIRS as readonly string[]).includes(parts[0]!) || parts.length < 2)
    throw new ToolError(`"${rel}" must be a path inside the skill under ${SUPPORT_DIRS.join("/, ")}/`)
  const p = join(s.dir, rel)
  if (!within(s.dir, p)) throw new ToolError(`"${rel}" leads out of the skill's directory`)
  return p
}

export const skillManageTool = defineTool({
  ...described("skill_manage", CLI_VARS.skill_manage),
  access: "skill_manage",
  schema: z.object({ operations: z.array(Op).min(1).max(20) }),
  permission: (a) => ({ permission: "skill_manage", class: "write", patterns: a.operations.map((o) => `${o.action} ${o.name}`) }),
  async run(a, ctx) {
    const ops = a.operations as Op[]
    if (ops.some((o) => o.action === "delete" || o.action === "revert") && ops.length > 1) throw new ToolError(`${ops.find((o) => o.action === "delete" || o.action === "revert")!.action} must be the only operation in its call.`)
    // Every name is checked before anything else: it becomes a directory name below.
    for (const o of ops) if (!NAME.test(o.name) || o.name.length > MAX_NAME) throw new ToolError(`"${o.name}" is not a valid skill name: lowercase letters, digits and -, starting with a letter or digit, up to ${MAX_NAME}.`)
    const skills = skillsOf(ctx)
    if (ops[0]!.action === "revert") {
      const name = ops[0]!.name
      const revs = revisions(name)
      if (!revs.length) throw new ToolError(`"${name}" has no earlier version kept.`)
      const at = join(historyDir(name), revs.at(-1)!)
      const now = findSkill(skills, name)
      // Where it goes back to: the skill as loaded now, else where it was kept from — and only ever
      // a directory of that name inside a skills directory.
      const dir = now?.dir ?? readFileSync(join(at, "dir"), "utf8").trim()
      const roots = [globalSkillsDir(), ...(ctx.skills?.projectDir ? [join(ctx.skills.projectDir, "skills")] : [])]
      if (basename(dir) !== name || !roots.some((r) => within(r, dir) && dir !== r)) throw new ToolError(`the kept version of "${name}" points outside the skills directories; not restored`)
      const current = filesUnder(now?.dir ?? dir)
      const back = filesUnder(join(at, "files"))
      rmSync(at, { recursive: true, force: true })
      saveRevision(name, now?.dir ?? dir, current)
      // The skill as it was: those files, and nothing it gained since.
      rmSync(now?.dir ?? dir, { recursive: true, force: true })
      for (const [f, text] of back) {
        const to = join(dir, relative(join(at, "files"), f))
        mkdirSync(dirname(to), { recursive: true })
        writeFileSync(to, text)
      }
      ctx.skills?.changed?.()
      return { output: `Reverted ${name} to its version of ${revs.at(-1)!.slice(0, 19).replace("T", " ")}. The version it replaced is kept: revert again to undo this.`, title: `revert ${name}` }
    }
    // Files as they were, to put back if anything fails.
    const backup = new Map<string, string | undefined>()
    // Whose file each one is: what is kept as a revision once the call succeeds.
    const owner = new Map<string, { name: string; dir: string }>()
    let whole: { name: string; dir: string; files: Map<string, string> } | undefined
    let current: { name: string; dir: string } | undefined
    const keep = (f: string) => {
      if (!backup.has(f)) backup.set(f, existsSync(f) ? readFileSync(f, "utf8") : undefined)
      if (current && !owner.has(f)) owner.set(f, current)
    }
    const write = (f: string, text: string) => {
      keep(f)
      mkdirSync(dirname(f), { recursive: true })
      writeFileSync(`${f}.tmp`, text)
      renameSync(`${f}.tmp`, f)
      written.push(f)
    }
    const created = new Map<string, { dir: string; file: string }>()
    const notes: string[] = []
    const written: string[] = []
    try {
      for (const [i, o] of ops.entries()) {
        const at = ops.length > 1 ? `operation ${i + 1} (${o.action} ${o.name}): ` : ""
        const fail = (m: string): never => {
          throw new ToolError(at + m)
        }
        if (!NAME.test(o.name) || o.name.length > MAX_NAME) fail(`"${o.name}" is not a valid skill name: lowercase letters, digits and -, starting with a letter or digit, up to ${MAX_NAME}.`)
        const existing = created.get(o.name) ?? findSkill(skills, o.name)
        if (o.action === "create") {
          if (existing) fail(`a skill "${o.name}" already exists (${existing.dir}). Use patch.`)
          if (o.category && (!CATEGORY.test(o.category) || o.category.includes("/"))) fail(`"${o.category}" is not a valid category.`)
          const text = o.content ?? (o.description?.trim() && o.instructions?.trim() ? composeSkill(o.name, o.description, o.instructions) : fail("create needs description and instructions (or content: the whole SKILL.md)."))
          const bad = validateSkill(text, o.name) ?? threatMessage(text, "The skill")
          if (bad) fail(bad)
          const base = o.where === "project" ? (ctx.skills?.projectDir ? join(ctx.skills.projectDir, "skills") : fail("this project has no project directory, so the skill cannot go there.")) : globalSkillsDir()
          const dir = join(base, ...(o.category ? [o.category] : []), o.name)
          // A directory the loader skipped (disabled, another OS, bad frontmatter) is still somebody's.
          if (existsSync(dir)) fail(`${dir} already exists, though it is not a loaded skill (disabled, for another system, or its SKILL.md is not valid). Choose another name, or ask the user.`)
          const file = join(dir, "SKILL.md")
          write(file, text.endsWith("\n") ? text : text + "\n")
          created.set(o.name, { dir, file })
          const d = String(splitFrontmatter(text)!.meta.description).trim()
          if (d.length > INDEX_DESCRIPTION) notes.push(`${o.name}: the skills list shows only "${d.slice(0, INDEX_DESCRIPTION - 3)}..." — put the trigger first.`)
          continue
        }
        if (!existing) fail(`there is no skill "${o.name}".`)
        const s = existing!
        // A skill made in this same call has no earlier version to keep.
        current = created.has(o.name) ? undefined : { name: o.name, dir: s.dir }
        if (o.action === "delete") {
          whole = { name: o.name, dir: s.dir, files: filesUnder(s.dir) }
          keep(s.file)
          rmSync(s.dir, { recursive: true, force: true })
          continue
        }
        if (o.action === "write_file") {
          const f = supportPath(s, o.file_path)
          const text = o.file_content ?? fail("write_file needs file_content.")
          if (text.length > MAX_FILE) fail(`the file is ${text.length} characters; the limit is ${MAX_FILE}.`)
          const bad = threatMessage(text, "The file")
          if (bad) fail(bad)
          write(f, text)
          continue
        }
        if (o.action === "remove_file") {
          const f = supportPath(s, o.file_path)
          if (!existsSync(f)) fail(`${o.file_path} does not exist.`)
          keep(f)
          rmSync(f)
          continue
        }
        // patch
        const f = o.file_path ? supportPath(s, o.file_path) : s.file
        if (!existsSync(f)) fail(`${o.file_path ?? "SKILL.md"} does not exist.`)
        const before = readFileSync(f, "utf8")
        let after: string
        if (o.old_string !== undefined) {
          try {
            after = replace(before, o.old_string, o.new_string ?? "", o.replace_all ?? false)
          } catch (e) {
            fail(`${(e as Error).message} old_string must be the exact text now in the file — read it with skill_view first. The file begins:\n${before.slice(0, 500)}`)
          }
        } else after = o.content ?? fail("patch needs old_string and new_string (or content: a whole new file).")
        if (f === s.file) {
          const bad = validateSkill(after!, o.name)
          if (bad) fail(`the patch would break SKILL.md: ${bad}`)
        }
        const threat = threatMessage(after!, "The skill")
        if (threat) fail(threat)
        write(f, after!)
      }
    } catch (e) {
      // All or nothing: put back every file this call touched.
      for (const [f, text] of backup) {
        if (text === undefined) rmSync(f, { force: true })
        else {
          mkdirSync(dirname(f), { recursive: true })
          writeFileSync(f, text)
        }
      }
      for (const { dir } of created.values()) rmSync(dir, { recursive: true, force: true })
      throw e
    }
    // Kept as a revision: every file this call changed or removed, as it was before.
    if (whole) saveRevision(whole.name, whole.dir, whole.files)
    else {
      // The whole skill as it was: as it is now, with what this call changed put back.
      const bySkill = new Map<string, { dir: string; files: Map<string, string> }>()
      for (const [f, text] of backup) {
        const o = owner.get(f)
        if (!o) continue
        const entry = bySkill.get(o.name) ?? { dir: o.dir, files: filesUnder(o.dir) }
        if (text === undefined) entry.files.delete(f)
        else entry.files.set(f, text)
        bySkill.set(o.name, entry)
      }
      for (const [name, e] of bySkill) saveRevision(name, e.dir, e.files)
    }
    ctx.skills?.changed?.()
    const summary = ops.map((o) => `${o.action} ${o.name}${o.file_path ? `/${o.file_path}` : ""}`).join(", ")
    const files = [...new Set(written)]
    return {
      output: `Done: ${summary}.${files.length ? `\nWritten: ${files.join(", ")}` : ""}${notes.length ? `\n${notes.join("\n")}` : ""}\nskill_view shows a skill as it is now; the skills list in your instructions changes from the next session.`,
      title: summary.slice(0, 80),
    }
  },
})
