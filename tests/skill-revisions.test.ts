// Skill revisions (after LLeMbas's skill_revisions): a change keeps what it replaced; revert puts
// it back, and a second revert undoes the first; a deleted skill comes back whole.
import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { globalSkillsDir } from "../src/skill/index.ts"
import { revisions, skillManageTool } from "../src/tool/skills.ts"

const skill = (name: string, description: string, body = "Do the thing.") => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`
const ctx = () => ({ root: "/p", cwd: "/p", signal: new AbortController().signal, readFiles: new Set<string>(), fileStamps: new Map(), bashTimeoutMs: 1000 }) as any
const run = (operations: object[]) => skillManageTool.run({ operations } as any, ctx())

test("patch keeps the version before; revert puts it back, twice is no change; a supporting file survives", async () => {
  const name = `rev-${Date.now().toString(36)}`
  await run([{ action: "create", name, content: skill(name, "Use when testing revisions.", "First text.") }, { action: "write_file", name, file_path: "references/a.md", file_content: "ref" }])
  expect(revisions(name)).toHaveLength(0)
  await run([{ action: "patch", name, old_string: "First text.", new_string: "Second text." }])
  expect(revisions(name)).toHaveLength(1)
  const file = join(globalSkillsDir(), name, "SKILL.md")
  expect(readFileSync(file, "utf8")).toContain("Second text.")
  await run([{ action: "revert", name }])
  expect(readFileSync(file, "utf8")).toContain("First text.")
  expect(readFileSync(join(globalSkillsDir(), name, "references/a.md"), "utf8")).toBe("ref")
  await run([{ action: "revert", name }])
  expect(readFileSync(file, "utf8")).toContain("Second text.")
})

test("a deleted skill comes back whole; revert must be alone; nothing to revert is said", async () => {
  const name = `del-${Date.now().toString(36)}`
  await run([{ action: "create", name, content: skill(name, "Use when testing delete.") }, { action: "write_file", name, file_path: "scripts/x.sh", file_content: "echo x" }])
  await run([{ action: "delete", name }])
  expect(existsSync(join(globalSkillsDir(), name))).toBe(false)
  await run([{ action: "revert", name }])
  expect(readFileSync(join(globalSkillsDir(), name, "scripts/x.sh"), "utf8")).toBe("echo x")
  await expect(run([{ action: "revert", name }, { action: "delete", name }])).rejects.toThrow("only operation")
  await expect(run([{ action: "revert", name: "never-was" }])).rejects.toThrow("no earlier version")
})

test("revert never leaves the history and skills directories: a name with .. is refused, a forged entry is not followed", async () => {
  await expect(run([{ action: "revert", name: "../../../../tmp/x" }])).rejects.toThrow("not a valid skill name")
  const { mkdirSync, writeFileSync, existsSync: exists } = await import("node:fs")
  const { paths } = await import("../src/config/paths.ts")
  const victim = (await import("node:fs")).mkdtempSync(join((await import("node:os")).tmpdir(), "ph-victim-"))
  writeFileSync(join(victim, "keep.txt"), "mine")
  const name = `forged-${Date.now().toString(36)}`
  const at = join(paths.data, "skill-history", name, "2026-10-03T00-00-00-000Z")
  mkdirSync(join(at, "files"), { recursive: true })
  writeFileSync(join(at, "dir"), victim)
  writeFileSync(join(at, "files", "evil.txt"), "x")
  await expect(run([{ action: "revert", name }])).rejects.toThrow("outside the skills directories")
  expect(exists(join(victim, "keep.txt"))).toBe(true)
  expect(exists(join(victim, "evil.txt"))).toBe(false)
})
