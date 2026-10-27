// Instruction files: the stacked chain from the project root to the working directory (spec 3.0.0),
// and config.yaml `instruction_files`, more files for the system prompt.
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../src/config/load.ts"
import { paths } from "../src/config/paths.ts"
import { assembleSystem, instructionFiles } from "../src/prompt/assemble.ts"

test("global entries may be anywhere; a project's only inside the project, links followed", () => {
  const outside = mkdtempSync(join(tmpdir(), "ph-outside-"))
  writeFileSync(join(outside, "style.md"), "Write tersely.")
  writeFileSync(join(outside, "secret"), "PRIVATE KEY")
  const root = mkdtempSync(join(tmpdir(), "ph-instr-"))
  mkdirSync(join(root, "docs"))
  writeFileSync(join(root, "docs", "rules.md"), "Tabs, not spaces.")
  symlinkSync(join(outside, "secret"), join(root, "docs", "link.md"))
  mkdirSync(join(root, ".agent"))
  writeFileSync(join(root, ".agent", "config.yaml"), `instruction_files: [docs/rules.md, ${join(outside, "secret")}, docs/link.md, docs/missing.md]\n`)
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(join(paths.config, "config.yaml"), `instruction_files: [${join(outside, "style.md")}]\n`)
  const loaded = loadConfig({ projectConfigDir: join(root, ".agent"), trusted: true })
  expect(loaded.instructions).toEqual([
    { path: join(outside, "style.md"), global: true },
    { path: "docs/rules.md", global: false },
    { path: join(outside, "secret"), global: false },
    { path: "docs/link.md", global: false },
    { path: "docs/missing.md", global: false },
  ])
  const files = instructionFiles(root, root, loaded.instructions)
  expect(files.map((f) => f.text)).toEqual(["Write tersely.", "Tabs, not spaces."])
  writeFileSync(join(paths.config, "config.yaml"), "")
})

// Spec 3.0.0: instruction files stack from the project root down to the working directory,
// outermost first, one per directory (AGENTS.md before CLAUDE.md); before, only the nearest counted.
test("instruction files stack from the root down to the working directory, outermost first", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ph-stack-")))
  const outside = mkdtempSync(join(tmpdir(), "ph-stack-out-"))
  writeFileSync(join(outside, "AGENTS.md"), "NOT THE PROJECT'S")
  mkdirSync(join(root, "pkg", "src", "deep"), { recursive: true })
  writeFileSync(join(root, "AGENTS.md"), "root rules")
  writeFileSync(join(root, "CLAUDE.md"), "never both")
  writeFileSync(join(root, "pkg", "CLAUDE.md"), "package rules\n## Git\ncommit freely")
  // A link out of the project is no instruction file: the walk goes on below it.
  symlinkSync(join(outside, "AGENTS.md"), join(root, "pkg", "src", "AGENTS.md"))
  writeFileSync(join(root, "pkg", "src", "deep", "AGENTS.md"), "deep rules")
  // Below the working directory: not in the chain (the read tool hands it over when reached).
  mkdirSync(join(root, "pkg", "src", "deep", "below"))
  writeFileSync(join(root, "pkg", "src", "deep", "below", "AGENTS.md"), "below")
  writeFileSync(join(paths.config, "config.yaml"), "")
  const files = instructionFiles(join(root, "pkg", "src", "deep"), root)
  expect(files.filter((f) => f.chain).map((f) => [f.path.slice(root.length + 1), f.text])).toEqual([
    ["AGENTS.md", "root rules"],
    ["pkg/CLAUDE.md", "package rules\n## Git\ncommit freely"],
    ["pkg/src/deep/AGENTS.md", "deep rules"],
  ])
  // A working directory outside the root is read as the root.
  expect(instructionFiles(outside, root).filter((f) => f.chain).map((f) => f.path)).toEqual([join(root, "AGENTS.md")])
  // In the prompt: each by its path in the project, outermost first; git is settled by any of them.
  const system = assembleSystem({ modelRef: "s/m", family: "local", cwd: join(root, "pkg", "src", "deep"), root, isGit: true, mode: "manual", planDir: join(root, ".agent", "plans"), toolNames: [] })
  const at = (s: string) => system.indexOf(s)
  expect(at("Instructions from AGENTS.md:")).toBeGreaterThan(-1)
  expect(at("Instructions from AGENTS.md:")).toBeLessThan(at("Instructions from pkg/CLAUDE.md:"))
  expect(at("Instructions from pkg/CLAUDE.md:")).toBeLessThan(at("Instructions from pkg/src/deep/AGENTS.md:"))
  expect(system).not.toContain("NOT THE PROJECT'S")
  expect(system).not.toContain("never both")
  expect(system).toContain("## Keeping AGENTS.md")
  expect(system).not.toContain("## Git in this project")
  expect(system).not.toContain("This project has no AGENTS.md yet")
})

test("no instruction file anywhere on the way: the project is told to make one", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ph-stack-none-")))
  mkdirSync(join(root, "a"))
  writeFileSync(join(paths.config, "config.yaml"), "")
  const system = assembleSystem({ modelRef: "s/m", family: "local", cwd: join(root, "a"), root, isGit: false, mode: "manual", planDir: join(root, ".agent", "plans"), toolNames: [] })
  expect(system).toContain(`It goes at the project root: ${root}/AGENTS.md.`)
})
