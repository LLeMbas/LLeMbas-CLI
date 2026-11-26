import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { analyzeSituation, CompletionContext, extractImports, summarizeSource } from "../src/acp/complete_context.ts"
import { FileIndex } from "../src/project/files.ts"

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function makeProject(files: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lmb-ctx-")))
  dirs.push(dir)
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel)
    mkdirSync(join(abs, ".."), { recursive: true })
    writeFileSync(abs, body)
  }
  return dir
}

test("analyzeSituation distinguishes comment, import, member, and code", () => {
  expect(analyzeSituation("const x = 1\n// writing a note ", "", "typescript").kind).toBe("comment")
  expect(analyzeSituation("/* block comment\nstill inside ", "", "typescript").kind).toBe("comment")
  expect(analyzeSituation("# python comment ", "", "python").kind).toBe("comment")

  const imp = analyzeSituation('import { foo } from "./uti', "", "typescript")
  expect(imp.kind).toBe("import")
  expect(imp.partialImport).toBe("./uti")

  const pyImp = analyzeSituation("from services.au", "", "python")
  expect(pyImp.kind).toBe("import")
  expect(pyImp.partialImport).toBe("services.au")

  const mem = analyzeSituation("const u = loadUser(id)\nu.", "\nreturn u", "typescript")
  expect(mem.kind).toBe("member")
  expect(mem.receiver).toBe("u")
  expect(mem.identifiers).toContain("loadUser")

  const code = analyzeSituation("export function greet(profile: UserProfile) {\n  return ", "\n}", "typescript")
  expect(code.kind).toBe("code")
  expect(code.identifiers).toContain("UserProfile")
})

test("extractImports parses TS/JS, Python, Rust, and C/C++ imports", () => {
  expect(extractImports('import { a } from "./alpha"\nconst b = require("../beta")')).toEqual(["./alpha", "../beta"])
  expect(extractImports("from pkg.mod import helper\nimport pkg.other")).toEqual(["pkg.mod", "pkg.other"])
  expect(extractImports("use crate::net::client;\nmod parser;")).toEqual(["net::client", "parser"])
  expect(extractImports('#include "config.h"\n#include <stdio.h>')).toEqual(["config.h"])
})

test("summarizeSource keeps short files whole and condenses long files to declarations", () => {
  const short = "export function add(a: number, b: number) { return a + b }\n"
  const s1 = summarizeSource(short)
  expect(s1.summary).toBe(short)
  expect(s1.symbols.has("add")).toBe(true)

  const longLines = [
    "/** User record */",
    "export interface UserRecord {",
    "  id: string",
    "  name: string",
    "}",
    ...Array.from({ length: 120 }, (_, i) => `  const filler_${i} = ${i}`),
    "export function formatUser(u: UserRecord): string {",
    "  return u.name",
    "}",
  ].join("\n")
  const s2 = summarizeSource(longLines)
  expect(s2.summary).toContain("export interface UserRecord")
  expect(s2.summary).toContain("export function formatUser")
  expect(s2.summary).not.toContain("filler_90")
  expect(s2.symbols.has("UserRecord")).toBe(true)
  expect(s2.symbols.has("formatUser")).toBe(true)
})

test("CompletionContext gathers situation-appropriate chunks, prefers unsaved buffers, and keeps KV-cache order stable", () => {
  const root = makeProject({
    "src/types.ts": "export interface WidgetConfig {\n  retries: number\n  timeoutMs: number\n}\n",
    "src/helper.ts": "export function buildWidget(name: string) {\n  return { name }\n}\n",
    "src/app.ts": 'import { WidgetConfig } from "./types"\nimport { buildWidget } from "./helper"\n',
  })
  const indices = new Map<string, FileIndex>()
  const ctx = new CompletionContext((r) => {
    let idx = indices.get(r)
    if (!idx) {
      idx = new FileIndex(r)
      indices.set(r, idx)
    }
    return idx
  })

  // Comment line -> no project chunks fetched.
  const commentChunks = ctx.gather({
    root,
    path: join(root, "src/app.ts"),
    language: "typescript",
    prefix: 'import { WidgetConfig } from "./types"\n// explain ',
    suffix: "",
  })
  expect(commentChunks).toEqual([])

  // Import line -> workspace file paths only.
  const importChunks = ctx.gather({
    root,
    path: join(root, "src/app.ts"),
    language: "typescript",
    prefix: 'import { x } from "./hel',
    suffix: "",
  })
  expect(importChunks.length).toBe(1)
  expect(importChunks[0]!.path).toBe("<workspace-files>")
  expect(importChunks[0]!.text).toContain("src/helper.ts")

  // Pre-warm establishes stable session order: types.ts before helper.ts.
  ctx.warm(root, join(root, "src/app.ts"))

  // First completion emphasizes helper.ts (`buildWidget`), second emphasizes types.ts (`WidgetConfig`):
  // both return chunks in the SAME stable session order so KV-cache prefixes stay warm!
  const first = ctx.gather({
    root,
    path: join(root, "src/app.ts"),
    language: "typescript",
    prefix: 'import { WidgetConfig } from "./types"\nimport { buildWidget } from "./helper"\nconst w = buildWidget(',
    suffix: "",
  })
  const second = ctx.gather({
    root,
    path: join(root, "src/app.ts"),
    language: "typescript",
    prefix: 'import { WidgetConfig } from "./types"\nimport { buildWidget } from "./helper"\nconst c: WidgetConfig = { ',
    suffix: "",
  })
  expect(first.map((c) => c.path)).toEqual(["src/types.ts", "src/helper.ts"])
  expect(second.map((c) => c.path)).toEqual(["src/types.ts", "src/helper.ts"])

  // Unsaved editor buffer overrides disk contents immediately.
  const withUnsaved = ctx.gather({
    root,
    path: join(root, "src/app.ts"),
    language: "typescript",
    prefix: 'import { WidgetConfig } from "./types"\nconst c: WidgetConfig = { ',
    suffix: "",
    open: [{ path: join(root, "src/types.ts"), text: "export interface WidgetConfig {\n  unsavedFlag: boolean\n}\n" }],
  })
  expect(withUnsaved.find((c) => c.path === "src/types.ts")?.text).toContain("unsavedFlag")

  // Disk cache invalidates when mtime/size change.
  const helperPath = join(root, "src/helper.ts")
  writeFileSync(helperPath, "export function buildWidget(name: string, strict: boolean) { return { name, strict } }\n")
  const future = new Date(Date.now() + 5000)
  utimesSync(helperPath, future, future)
  const afterEdit = ctx.gather({
    root,
    path: join(root, "src/app.ts"),
    language: "typescript",
    prefix: 'import { buildWidget } from "./helper"\nbuildWidget(',
    suffix: "",
  })
  expect(afterEdit.find((c) => c.path === "src/helper.ts")?.text).toContain("strict: boolean")
})
