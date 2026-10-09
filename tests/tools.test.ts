import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyPatchTool } from "../src/tool/apply_patch.ts"
import { bashKillTool, bashOutputTool, bashTool } from "../src/tool/bash.ts"
import { editTool } from "../src/tool/edit.ts"
import { multieditTool } from "../src/tool/multiedit.ts"
import { formatAnswers, questionSchema, unattendedReply, type QuestionRequest } from "../src/tool/question.ts"
import { readTool } from "../src/tool/read.ts"
import { todoTool } from "../src/tool/todo.ts"
import type { ToolContext } from "../src/tool/tool.ts"

function ctx(): ToolContext {
  const root = mkdtempSync(join(tmpdir(), "ph-tools-"))
  return { root, cwd: root, signal: new AbortController().signal, readFiles: new Set(), fileStamps: new Map(), bashTimeoutMs: 5000 }
}

const REQ: QuestionRequest = {
  why: "Two things decide the design.",
  questions: [
    { header: "Database", question: "Which database?", options: [{ label: "PostgreSQL", recommended: true }, { label: "SQLite" }] },
    { header: "Layers", question: "Which layers?", multiple: true, options: [{ label: "API" }, { label: "CLI" }, { label: "Web" }] },
    { header: "Auth", question: "Sessions how?", options: [{ label: "JWT" }, { label: "Cookies" }] },
    { header: "Deploy", question: "Where to?", options: [{ label: "Docker" }, { label: "Bare metal" }] },
  ],
}

describe("question", () => {
  test("the answer text: options, recommended, custom, a question back — and what to do next", () => {
    const text = formatAnswers(REQ, {
      answers: [
        { kind: "options", labels: ["PostgreSQL"] },
        { kind: "options", labels: ["API", "CLI"] },
        { kind: "custom", text: "signed cookies, no server store" },
        { kind: "back", text: "What does Docker add to build time?" },
      ],
    })
    expect(text).toBe(`Q1 [Database] Which database?
→ PostgreSQL (the one you recommended)
Q2 [Layers] Which layers?
→ API, CLI
Q3 [Auth] Sessions how?
→ custom: "signed cookies, no server store"
Q4 [Deploy] Where to?
↩ counter-question: "What does Docker add to build time?"

Q1, Q2, Q3 are answered. Instead of answering Q4, the user asked you a question. Answer it in your reply, then call question again with only Q4 — adjusted if your answer changes the options.`)
    expect(formatAnswers(REQ, { dismissed: true })).toContain("Do not ask them again")
  })

  test("nobody present: the recommended option, said to be automatic; or the first; or dismissed", () => {
    const rec = unattendedReply(REQ, "recommended")
    expect(formatAnswers(REQ, rec)).toContain("→ PostgreSQL (the one you recommended) (chosen automatically: nobody is present")
    expect(!rec.dismissed && rec.answers[1]).toEqual({ kind: "options", labels: ["API"] })
    expect(unattendedReply(REQ, "fail")).toEqual({ dismissed: true })
  })

  test("lenient input: a single question, options as strings, `choices`, a missing header", () => {
    const a = questionSchema.parse({ question: "Tabs or spaces?", choices: ["tabs", "spaces"] }) as QuestionRequest
    expect(a.questions[0]).toMatchObject({ header: "Tabs or spaces", options: [{ label: "tabs" }, { label: "spaces" }] })
  })
})

describe("file tools", () => {
  test("multiedit applies in order, and on any failure changes nothing", async () => {
    const c = ctx()
    writeFileSync(join(c.root, "a.ts"), "let x = 1\nlet y = 2\n")
    await readTool.run({ path: "a.ts" }, c)
    await multieditTool.run({ path: "a.ts", edits: [{ old: "x = 1", new: "x = 10" }, { old: "x = 10", new: "x = 11" }] }, c)
    expect(readFileSync(join(c.root, "a.ts"), "utf8")).toBe("let x = 11\nlet y = 2\n")
    await expect(multieditTool.run({ path: "a.ts", edits: [{ old: "y = 2", new: "y = 3" }, { old: "nope", new: "x" }] }, c)).rejects.toThrow("step 2 of 2")
    expect(readFileSync(join(c.root, "a.ts"), "utf8")).toBe("let x = 11\nlet y = 2\n")
  })

  test("apply_patch: add, update with context, move, delete — or nothing", async () => {
    const c = ctx()
    writeFileSync(join(c.root, "app.py"), "def greet():\n    print('Hi')\n\ngreet()\n")
    writeFileSync(join(c.root, "old.txt"), "bye\n")
    const r = await applyPatchTool.run(
      {
        patch: `*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: app.py
*** Move to: main.py
@@ def greet():
-    print('Hi')
+    print('Hello, world!')
*** Delete File: old.txt
*** End Patch`,
      },
      c,
    )
    expect(readFileSync(join(c.root, "hello.txt"), "utf8")).toBe("Hello world\n")
    expect(readFileSync(join(c.root, "main.py"), "utf8")).toContain("Hello, world!")
    expect(existsSync(join(c.root, "app.py"))).toBe(false)
    expect(existsSync(join(c.root, "old.txt"))).toBe(false)
    expect(r.title).toContain("hello.txt")
    await expect(
      applyPatchTool.run({ patch: "*** Begin Patch\n*** Add File: x.txt\n+x\n*** Update File: main.py\n@@\n-not there\n+y\n*** End Patch" }, c),
    ).rejects.toThrow("Nothing was applied")
    expect(existsSync(join(c.root, "x.txt"))).toBe(false)
  })

  test("apply_patch takes a unified diff: by its headers or by path, created and deleted files, all or nothing", async () => {
    const c = ctx()
    writeFileSync(join(c.root, "a.txt"), "one\ntwo\nthree\n")
    writeFileSync(join(c.root, "crlf.txt"), "\uFEFFx\r\ny\r\n")
    writeFileSync(join(c.root, "gone.txt"), "bye\n")
    // No headers: the file is the path. Wrong line numbers are only a hint.
    await applyPatchTool.run({ patch: "@@ -40,2 +40,2 @@\n one\n-two\n+TWO\n", path: "a.txt" }, c)
    expect(readFileSync(join(c.root, "a.txt"), "utf8")).toBe("one\nTWO\nthree\n")
    // A BOM and CRLF are kept.
    await applyPatchTool.run({ patch: "--- a/crlf.txt\n+++ b/crlf.txt\n@@ -1,2 +1,2 @@\n x\n-y\n+Y\n" }, c)
    expect(readFileSync(join(c.root, "crlf.txt"), "utf8")).toBe("\uFEFFx\r\nY\r\n")
    // Several files in one git diff: a new one, a deleted one, a changed one.
    const r = await applyPatchTool.run(
      {
        patch: [
          "diff --git a/new.txt b/new.txt", "new file mode 100644", "--- /dev/null", "+++ b/new.txt", "@@ -0,0 +1,2 @@", "+hello", "+world",
          "diff --git a/gone.txt b/gone.txt", "--- a/gone.txt", "+++ /dev/null", "@@ -1 +0,0 @@", "-bye",
          "--- a/a.txt", "+++ b/a.txt", "@@ -3 +3 @@", "-three", "+3",
        ].join("\n"),
      },
      c,
    )
    expect(readFileSync(join(c.root, "new.txt"), "utf8")).toBe("hello\nworld\n")
    expect(existsSync(join(c.root, "gone.txt"))).toBe(false)
    expect(readFileSync(join(c.root, "a.txt"), "utf8")).toBe("one\nTWO\n3\n")
    expect(r.title).toContain("new.txt")
    // One hunk that does not fit: no file is touched, and the model is shown what is there.
    await expect(applyPatchTool.run({ patch: "--- /dev/null\n+++ b/x.txt\n@@ -0,0 +1 @@\n+x\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-nothing like this\n+y\n" }, c)).rejects.toThrow("->     1  one")
    expect(existsSync(join(c.root, "x.txt"))).toBe(false)
    await expect(applyPatchTool.run({ patch: "@@ -1 +1 @@\n-one\n+1\n" }, c)).rejects.toThrow("names no file")
    // The permission request names the files before anything is read.
    expect(applyPatchTool.permission({ patch: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+1\n" }, c).patterns).toEqual(["a.txt"])
    expect(applyPatchTool.permission({ patch: "@@ -1 +1 @@\n-one\n+1\n", path: "b.txt" }, c).patterns).toEqual(["b.txt"])
  })

  test("a byte-order mark survives edit, multiedit and both apply_patch formats", async () => {
    const c = ctx()
    const bom = (name: string) => (writeFileSync(join(c.root, name), "\uFEFFx\ny\n"), c.readFiles.add(join(c.root, name)))
    bom("e.txt")
    await editTool.run({ path: "e.txt", old: "y", new: "Y" }, c)
    bom("m.txt")
    await multieditTool.run({ path: "m.txt", edits: [{ old: "y", new: "Y" }] }, c)
    bom("p.txt")
    await applyPatchTool.run({ patch: "*** Begin Patch\n*** Update File: p.txt\n@@\n x\n-y\n+Y\n*** End Patch" }, c)
    bom("u.txt")
    await applyPatchTool.run({ patch: "@@ -1,2 +1,2 @@\n x\n-y\n+Y\n", path: "u.txt" }, c)
    for (const f of ["e.txt", "m.txt", "p.txt", "u.txt"]) expect(readFileSync(join(c.root, f), "utf8")).toBe("\uFEFFx\nY\n")
  })

  test("apply_patch: a file named twice gets both changes; a move never overwrites", async () => {
    const c = ctx()
    writeFileSync(join(c.root, "f.txt"), "one\ntwo\nthree\nfour\n")
    writeFileSync(join(c.root, "g.txt"), "keep me\n")
    await applyPatchTool.run({ patch: "*** Begin Patch\n*** Update File: f.txt\n@@\n-one\n+ONE\n two\n*** Update File: f.txt\n@@\n three\n-four\n+FOUR\n*** End Patch" }, c)
    expect(readFileSync(join(c.root, "f.txt"), "utf8")).toBe("ONE\ntwo\nthree\nFOUR\n")
    await expect(applyPatchTool.run({ patch: "*** Begin Patch\n*** Update File: f.txt\n*** Move to: g.txt\n@@\n-ONE\n+1\n*** End Patch" }, c)).rejects.toThrow("does not overwrite")
    expect(readFileSync(join(c.root, "g.txt"), "utf8")).toBe("keep me\n")
    expect(readFileSync(join(c.root, "f.txt"), "utf8")).toBe("ONE\ntwo\nthree\nFOUR\n")
  })

  test("todo replaces the list and reports progress", async () => {
    const c = ctx()
    const todos = { items: [] as { content: string; status: "pending" | "in_progress" | "completed" | "cancelled" }[] }
    // Through the schema, as the engine does: it turns the bare string into a pending item.
    const args = todoTool.schema.parse({ todos: [{ content: "read", status: "completed" }, { content: "fix", status: "in_progress" }, "test"] })
    const r = await todoTool.run(args, { ...c, todos })
    expect(r.output).toBe("[x] read\n[>] fix\n[ ] test")
    expect(r.title).toBe("1/3 done")
    expect(todos.items).toHaveLength(3)
  })
})

describe("background bash", () => {
  test("start, read new output, see it finish; kill a long one", async () => {
    const c = ctx()
    const started = await bashTool.run({ command: "echo one; sleep 0.5; echo two", background: true }, c)
    const id = /as (job\d+)/.exec(started.output)![1]!
    expect(started.output).toContain("one")
    const later = await bashOutputTool.run({ id, wait: 3 }, c)
    expect(later.output).toContain("two")
    await Bun.sleep(200)
    expect((await bashOutputTool.run({ id }, c)).output).toContain("exited with 0")
    const long = await bashTool.run({ command: "sleep 30", background: true }, c)
    const id2 = /as (job\d+)/.exec(long.output)![1]!
    expect((await bashKillTool.run({ id: id2 }, c)).output).toContain("Stopped")
    expect((await bashOutputTool.run({ id: id2, wait: 3 }, c)).output).toMatch(/exited with (null|143|-?\d+)/)
  })
})

describe("paths the way a model writes them", () => {
  test("~/x is the home directory, not a directory named ~; a missing directory says so", async () => {
    const { absPath } = await import("../src/tool/tool.ts")
    const { homedir } = await import("node:os")
    const { listTool, globTool } = await import("../src/tool/search.ts")
    const c = ctx()
    expect(absPath("~/notes.md", c)).toBe(join(homedir(), "notes.md"))
    expect(absPath("~", c)).toBe(homedir())
    expect(absPath("a/~b", c)).toBe(join(c.root, "a/~b"))
    await expect(listTool.run({ path: "nope" }, c)).rejects.toThrow("nope does not exist")
    await expect(globTool.run({ pattern: "*", path: "nope" }, c)).rejects.toThrow("nope does not exist")
  })
})
