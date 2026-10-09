import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { paths } from "../src/config/paths.ts"
import { hardlineRules } from "../src/permission/hardline.ts"
import { attachmentsFor } from "../src/project/attach.ts"
import { customCommands, expandCommand } from "../src/project/commands.ts"
import { FileIndex } from "../src/project/files.ts"
import { findProject, projectDirName } from "../src/project/root.ts"

function tree() {
  const root = mkdtempSync(join(tmpdir(), "ph-proj-"))
  mkdirSync(join(root, "src/deep"), { recursive: true })
  writeFileSync(join(root, "src/app.ts"), Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n")
  writeFileSync(join(root, "src/deep/util.ts"), "export {}\n")
  writeFileSync(join(root, "README.md"), "# hi\n")
  return root
}

describe("@ attachments", () => {
  test("a file, a line range, a directory; an email is left alone; attached files count as read", () => {
    const root = tree()
    const ctx = { root, cwd: root, readFiles: new Set<string>(), fileStamps: new Map() }
    const atts = attachmentsFor("look at @src/app.ts and @src/app.ts#3-5 and @src/ — mail me@example.com", ctx)
    expect(atts.map((a) => a.path)).toEqual(["src/app.ts", "src/app.ts", "src/"])
    expect(atts[0]!.text).toStartWith('<file path="src/app.ts">\n1: line 1')
    expect(atts[1]!.text).toBe('<file path="src/app.ts" lines="3-5">\n3: line 3\n4: line 4\n5: line 5\n</file>')
    expect(atts[2]!.text).toBe('<directory path="src/">\napp.ts\ndeep/\n</directory>')
    expect(ctx.readFiles.has(join(root, "src/app.ts"))).toBe(true)
  })
})

describe("custom commands", () => {
  test("global and project, the project overriding; $ARGUMENTS, $1, !`cmd`, and the hardline", () => {
    const root = tree()
    mkdirSync(join(paths.config, "commands"), { recursive: true })
    writeFileSync(join(paths.config, "commands", "review.md"), "---\ndescription: review a file\n---\nReview $1 carefully. All: $ARGUMENTS\nBranch: !`echo main`\n")
    writeFileSync(join(paths.config, "commands", "danger.md"), "Here: !`rm -rf /`\n")
    const pdir = join(root, ".agent")
    mkdirSync(join(pdir, "commands"), { recursive: true })
    writeFileSync(join(pdir, "commands", "danger.md"), "---\ndescription: project one\n---\nsafe\n")
    const cmds = customCommands(pdir)
    const review = cmds.find((c) => c.name === "review")!
    expect(review.description).toBe("review a file")
    expect(cmds.find((c) => c.name === "danger")!.source).toBe("project")
    expect(expandCommand(review, "src/app.ts quickly", root, hardlineRules())).toBe("Review src/app.ts carefully. All: src/app.ts quickly\nBranch: main")
    const globalDanger = customCommands(undefined).find((c) => c.name === "danger")!
    expect(expandCommand(globalDanger, "", root, hardlineRules())).toContain("[not run — recursive delete of the root filesystem]")
  })
})

describe("file index", () => {
  test("fuzzy match, and a trailing / lists one level", () => {
    const idx = new FileIndex(tree())
    expect(idx.search("utl")[0]).toBe("src/deep/util.ts")
    expect(idx.search("src/")).toEqual(["src/deep/", "src/app.ts"])
  })
})

describe("the project directory", () => {
  test("a new project gets .agent at the git root; an empty .agent is where it goes", () => {
    const root = mkdtempSync(join(tmpdir(), "lembas-proj-"))
    mkdirSync(join(root, ".git"))
    mkdirSync(join(root, "src"))
    expect(findProject(join(root, "src"))).toMatchObject({ root, dir: join(root, ".agent"), exists: false })
    mkdirSync(join(root, ".agent"))
    expect(projectDirName(root)).toBe(".agent")
  })

  test("another tool's .agent is not a project: a new one is .lembas, not inside it", () => {
    const theirs = mkdtempSync(join(tmpdir(), "lembas-proj-"))
    mkdirSync(join(theirs, ".git"))
    mkdirSync(join(theirs, ".agent", "rules"), { recursive: true })
    expect(findProject(theirs)).toMatchObject({ root: theirs, dir: join(theirs, ".lembas"), exists: false })
    mkdirSync(join(theirs, ".lembas"))
    expect(findProject(theirs)).toMatchObject({ dir: join(theirs, ".lembas"), exists: true })
  })

  test("our own .agent is found by any one of its markers", () => {
    for (const marker of ["config.yaml", "plans", "tasks.md", "local"]) {
      const mine = mkdtempSync(join(tmpdir(), "lembas-proj-"))
      if (marker.includes(".")) {
        mkdirSync(join(mine, ".agent"))
        writeFileSync(join(mine, ".agent", marker), "")
      } else mkdirSync(join(mine, ".agent", marker), { recursive: true })
      expect(findProject(mine)).toMatchObject({ dir: join(mine, ".agent"), exists: true })
    }
  })
})
