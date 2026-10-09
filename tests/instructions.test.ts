// config.yaml `instructions`: more files for the system prompt.
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../src/config/load.ts"
import { paths } from "../src/config/paths.ts"
import { instructionFiles } from "../src/prompt/assemble.ts"

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
