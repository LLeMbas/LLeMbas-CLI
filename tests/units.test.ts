import { describe, expect, test } from "bun:test"
import { advertisedEfforts, effortsFromTemplate, stripEffort } from "../src/provider/effort.ts"
import { ThinkSplitter } from "../src/provider/think.ts"
import { sseJson } from "../src/provider/sse.ts"
import { replace } from "../src/tool/replace.ts"

describe("think splitter", () => {
  test("plain text is never held back", () => {
    const s = new ThinkSplitter()
    expect(s.feed("hello world")).toEqual([{ kind: "text", text: "hello world" }])
  })
  test("a trailing partial tag is held until resolved", () => {
    const s = new ThinkSplitter()
    expect(s.feed("a <thi")).toEqual([{ kind: "text", text: "a " }])
    expect(s.feed("nking>b</thinking>c")).toEqual([
      { kind: "reasoning", text: "b" },
      { kind: "text", text: "c" },
    ])
  })
  test("flush releases a held partial", () => {
    const s = new ThinkSplitter()
    s.feed("x <")
    expect(s.flush()).toEqual([{ kind: "text", text: "<" }])
  })
})

describe("effort helpers", () => {
  test("advertised efforts are whole words after 'supported'", () => {
    expect(advertisedEfforts("Unexpected reasoning effort high. Supported types are xhigh (default), medium, and low.")).toEqual(["low", "medium", "xhigh"])
    expect(advertisedEfforts("nothing here")).toEqual([])
  })
  test("efforts from a chat template", () => {
    const tpl = "{%- if reasoning_effort not in ('xhigh', 'medium', 'low') %}{{ raise_exception('bad') }}{% endif %}"
    expect(effortsFromTemplate(tpl)).toEqual(["low", "medium", "xhigh"])
    expect(effortsFromTemplate("{%- set reasoning_effort = 'medium' %}")).toEqual([])
  })
  test("strip removes both forms but keeps other kwargs", () => {
    expect(stripEffort({ reasoning_effort: "low", chat_template_kwargs: { reasoning_effort: "low", x: 1 } })).toEqual({ chat_template_kwargs: { x: 1 } })
  })
})

describe("sse", () => {
  test("frames without blank lines between them, comments, CRLF", async () => {
    const body = new Response(': keep-alive\r\ndata: {"a":1}\r\ndata: {"a":2}\n\ndata: [DONE]\n\n').body!
    const got = []
    for await (const f of sseJson(body)) got.push(f.data)
    expect(got).toEqual([{ a: 1 }, { a: 2 }])
  })
})

describe("replace (OpenCode cascade)", () => {
  test("exact, indentation-flexible, and ambiguity", () => {
    expect(replace("a\nb\nc", "b", "B")).toBe("a\nB\nc")
    expect(replace("  if x:\n    y()\n", "if x:\n  y()", "if z:\n  y()")).toContain("if z:")
    expect(() => replace("x x", "x", "y")).toThrow("multiple")
    expect(replace("x x", "x", "y", true)).toBe("y y")
  })
})

describe("sse error lines", () => {
  test("a bare JSON error line and an `error:` field both surface", async () => {
    const body = new Response('data: {"a":1}\n\n{"error":{"code":500,"message":"boom"}}\n\nerror: {"message":"two"}\n\n').body!
    const got = []
    for await (const f of sseJson(body)) got.push(f)
    expect(got).toEqual([
      { event: undefined, data: { a: 1 } },
      { event: "error", data: { error: { code: 500, message: "boom" } } },
      { event: "error", data: { error: { message: "two" } } },
    ])
  })
})

describe("sse final line", () => {
  test("an error on the last line with no newline after it is not lost", async () => {
    const body = new Response('data: {"a":1}\n\n{"error":{"message":"last"}}').body!
    const got = []
    for await (const f of sseJson(body)) got.push(f)
    expect(got.at(-1)).toEqual({ event: "error", data: { error: { message: "last" } } })
  })
})

describe("grep", () => {
  test("literal search, and a hint when a regex finds nothing", async () => {
    const { grepTool } = await import("../src/tool/search.ts")
    const { mkdtempSync, writeFileSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const root = mkdtempSync(join(tmpdir(), "lembas-grep-"))
    writeFileSync(join(root, "a.py"), "return total / (len(values) - 1)\n")
    const ctx = { root, cwd: root, signal: new AbortController().signal, readFiles: new Set<string>(), fileStamps: new Map(), bashTimeoutMs: 1000 }
    const miss = await grepTool.run({ pattern: "(len(values) - 1)" }, ctx)
    expect(miss.output).toContain("literal: true")
    const hit = await grepTool.run({ pattern: "(len(values) - 1)", literal: true }, ctx)
    expect(hit.output).toContain("a.py:1:")
  })
})

describe("prompt families", () => {
  test("every family gets the shared base plus its own overlay; the overlay is chosen by id or by config", async () => {
    const { assembleSystem } = await import("../src/prompt/assemble.ts")
    const base = { modelRef: "x/y", cwd: "/p", root: "/p", isGit: false, mode: "manual" as const, planDir: "/p/.agent/plans", toolNames: [] }
    const local = assembleSystem({ ...base, family: "local" })
    expect(local).toContain("# Using tools")
    expect(local).toContain("# Act, don't describe")
    const gpt = assembleSystem({ ...base, family: "gpt" })
    expect(gpt).toContain("# Using tools")
    expect(gpt).toContain("Use apply_patch for hand edits")
    expect(gpt).not.toContain("# Act, don't describe")
    expect(assembleSystem({ ...base, family: "anthropic" })).toContain("# Professional objectivity")
    expect(assembleSystem({ ...base, family: "gemini" })).toContain("1. **Understand**")
    expect(assembleSystem({ ...base, family: "nonsense" })).not.toContain("<!--")
  })
})

describe("the project's AGENTS.md", () => {
  test("missing: make it, and ask how git is used first; without a Git section: ask; with one: just keep it current", async () => {
    const { assembleSystem } = await import("../src/prompt/assemble.ts")
    const { mkdtempSync, writeFileSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const root = mkdtempSync(join(tmpdir(), "ph-agents-"))
    const base = { modelRef: "x/y", family: "local", cwd: root, root, isGit: true, mode: "edit" as const, planDir: join(root, ".agent/plans"), toolNames: [] }
    const missing = assembleSystem(base)
    expect(missing).toContain(`This project has no AGENTS.md yet`)
    expect(missing).toContain(`${root}/AGENTS.md`)
    expect(missing).toContain("which branch the work goes on")
    expect(assembleSystem({ ...base, isGit: false })).toContain("not a git repository yet")
    expect(assembleSystem({ ...base, subagent: { name: "explore", instructions: "look" } })).not.toContain("AGENTS.md yet")

    writeFileSync(join(root, "AGENTS.md"), "# Ambitious\n\nA game.\n")
    const noGit = assembleSystem(base)
    expect(noGit).toContain('AGENTS.md has no "## Git" section')
    expect(noGit).toContain("## Keeping AGENTS.md")

    writeFileSync(join(root, "AGENTS.md"), "# Ambitious\n\n## Git\n\nCommit when a change is done, on main.\n")
    const settled = assembleSystem(base)
    expect(settled).not.toContain('has no "## Git" section')
    expect(settled).toContain("## Keeping AGENTS.md")
    expect(settled).toContain("Commit when a change is done, on main.")
  })
})

describe("durations", () => {
  test("seconds, then minutes, then hours", async () => {
    const { duration } = await import("../src/duration.ts")
    expect(duration(8_400)).toBe("8.4s")
    expect(duration(8_400, true)).toBe("8s")
    expect(duration(65_000)).toBe("1m 05s")
    expect(duration(59 * 60_000 + 59_000)).toBe("59m 59s")
    expect(duration(2 * 3_600_000 + 3 * 60_000 + 9_000)).toBe("2h 03m")
  })
})

describe("search keys", () => {
  test("{file:} and {env:} are filled in; an unreadable key turns off that service only", async () => {
    const { loadConfig } = await import("../src/config/load.ts")
    const { searchOrder } = await import("../src/search/index.ts")
    const { paths } = await import("../src/config/paths.ts")
    const { mkdirSync, writeFileSync } = await import("node:fs")
    const { join } = await import("node:path")
    mkdirSync(paths.config, { recursive: true })
    writeFileSync(join(paths.config, "connections.yaml"), "connections: {}\n", { mode: 0o600 })
    writeFileSync(join(paths.config, "fc.token"), "s3cret\n")
    process.env.PH_TEST_SEARX = "sx-key"
    writeFileSync(
      join(paths.config, "config.yaml"),
      `search:\n  order: [searxng, firecrawl, ddg]\n  searxng: { base_url: https://search.example, api_key: "{env:PH_TEST_SEARX}" }\n  firecrawl: { base_url: https://fc.example, api_key: "{file:${join(paths.config, "fc.token")}}" }\n`,
    )
    let l = loadConfig()
    expect(l.config.search?.firecrawl?.api_key).toBe("s3cret")
    expect(l.config.search?.searxng?.api_key).toBe("sx-key")
    writeFileSync(
      join(paths.config, "config.yaml"),
      `search:\n  order: [firecrawl, ddg]\n  firecrawl: { base_url: https://fc.example, api_key: "{file:${join(paths.config, "missing.token")}}" }\n`,
    )
    l = loadConfig()
    expect(l.config.search?.firecrawl).toBeUndefined()
    expect(l.warnings.some((w) => w.startsWith("search: firecrawl is off"))).toBe(true)
    expect(searchOrder(l.config.search!)).toEqual(["ddg"])
    delete process.env.PH_TEST_SEARX
  })
})
