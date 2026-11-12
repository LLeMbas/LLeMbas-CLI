// MCP in the TUI: what is said as the servers start, and the /mcp menu.
import { afterEach, expect, test } from "bun:test"
import { join } from "node:path"
import { mcpWord } from "../../src/tui/components/status.tsx"
import { NOTICES } from "../../src/tui/notices.ts"
import { tui } from "./harness.tsx"

let t: Awaited<ReturnType<typeof tui>> | undefined
afterEach(() => t?.stop())

const server = join(import.meta.dir, "..", "fixtures", "mcp", "server.ts")
const local = (name: string) => `  ${name}:\n    command: ["${process.execPath}", "${server}"]\n`
const broken = (name: string) => `  ${name}:\n    command: ["${process.execPath}", "${join(import.meta.dir, "no-such-server.ts")}"]\n`

test("a server that connects says nothing at start: no warning sign, no block — the status bar counts it", async () => {
  t = await tui([], { width: 110, height: 30 }, `mcp:\n${local("fix")}`)
  await t.app.mcpReady
  await t.settle(200)
  const f = t.frame()
  expect(f).not.toContain(NOTICES.warn.glyph)
  expect(f).not.toContain("connected")
  expect(f).not.toContain("mcp__")
  expect(t.view.state.items.filter((i) => i.kind === "notice")).toEqual([])
  expect(f.split("\n").at(-2)).toContain("MCP 1 · ")
})

test("a server that fails gets one plain line naming it and /mcp; the status bar says 1/2", async () => {
  t = await tui([], { width: 140, height: 30 }, `mcp:\n${local("fix")}${broken("gone")}`)
  await t.app.mcpReady
  await t.settle(300)
  const notices = t.view.state.items.filter((i) => i.kind === "notice") as { text: string; level: string }[]
  expect(notices.length).toBe(1)
  expect(notices[0]!.level).toBe("warn")
  expect(notices[0]!.text).toStartWith("MCP gone did not connect: ")
  expect(notices[0]!.text).toEndWith("— /mcp gone shows more and reconnects")
  expect(notices[0]!.text).not.toContain("\n")
  expect(t.frame().split("\n").at(-2)).toContain("MCP 1/2 · ")
})

test("the status bar's word for the servers", () => {
  expect(mcpWord([])).toEqual({ text: "", warn: false })
  expect(mcpWord([{ status: "disabled" }])).toEqual({ text: "", warn: false })
  expect(mcpWord([{ status: "connected" }, { status: "connected" }, { status: "disabled" }])).toEqual({ text: "MCP 2", warn: false })
  expect(mcpWord([{ status: "connected" }, { status: "connecting" }])).toEqual({ text: "MCP 1/2", warn: false })
  expect(mcpWord([{ status: "connected" }, { status: "needs_auth" }])).toEqual({ text: "MCP 1/2", warn: true })
  expect(mcpWord([{ status: "failed" }])).toEqual({ text: "MCP 0/1", warn: true })
})

test("a notice with a level is drawn by the table: only a warning carries the warning sign", async () => {
  t = await tui([])
  t.app.bus.emit({ type: "notice", level: "info", message: "it happened" })
  t.app.bus.emit({ type: "notice", level: "success", message: "it worked" })
  t.app.bus.emit({ type: "notice", level: "warn", message: "look at this" })
  t.app.bus.emit({ type: "notice", level: "error", message: "it broke" })
  t.app.bus.emit({ type: "notice", message: "no level given" })
  await t.settle()
  const f = t.frame()
  expect(f).toContain("· it happened")
  expect(f).toContain("✓ it worked")
  expect(f).toContain("⚠ look at this")
  expect(f).toContain("✗ it broke")
  expect(f).toContain("⚠ no level given")
})

// ---- the /mcp menu ----

import { existsSync, readFileSync } from "node:fs"
import { expandSlash } from "../../src/session/commands.ts"
import { mcpText } from "../../src/mcp/text.ts"
import type { ServerState } from "../../src/mcp/index.ts"

/** A server put into the manager as if it had connected (no process): `tools` of them. */
function fake(name: string, o: Partial<ServerState> & { toolCount?: number; source?: "global" | "project" } = {}): ServerState {
  const { toolCount = 2, source = "global", ...rest } = o
  return {
    name,
    cfg: { url: `https://example.org/${name}/mcp`, source } as never,
    status: "connected",
    tools: Array.from({ length: toolCount }, (_, i) => ({ name: `tool_${i}`, description: `Does thing ${i}.\nA second line about thing ${i}.`, inputSchema: {} })),
    prompts: [],
    resources: false,
    stderr: [],
    gen: 0,
    ...rest,
  }
}
const put = (...servers: ServerState[]) => {
  for (const s of servers) t!.app.mcp.servers.set(s.name, s)
}
const widest = () => Math.max(...t!.frame().split("\n").map((l) => l.trimEnd().length))

test("/mcp with no servers says how to add one, in the menu — not a dump", async () => {
  t = await tui([])
  await t.input.typeText("/mcp")
  t.input.pressEnter()
  expect(await t.until("MCP servers")).toBe(true)
  expect(t.frame()).toContain("No MCP servers are configured.")
  expect(t.frame()).toContain("esc close")
  t.input.pressEscape()
  await t.settle()
  expect(t.frame()).not.toContain("No MCP servers are configured.")
})

test("/mcp: the servers with state and where they come from; enter opens one; a tool's rule is changed there; esc goes back", async () => {
  t = await tui([], { width: 100, height: 32 }, `mcp:\n${local("fix")}${broken("gone")}`)
  await t.app.mcpReady
  await t.settle(200)
  await t.input.typeText("/mcp")
  t.input.pressEnter()
  expect(await t.until("MCP servers — 1 of 2 connected")).toBe(true)
  let f = t.frame()
  expect(f).toContain("Your config")
  expect(f).toMatch(/● fix {2}\d+ tools, \d+ prompts?/)
  expect(f).toMatch(/✗ gone {2}failed: /)
  t.input.pressEnter() // fix is first
  expect(await t.until("MCP · fix")).toBe(true)
  f = t.frame()
  expect(f).toContain("connected — ")
  expect(f).toContain("from your config")
  expect(f).toContain("Actions")
  expect(f).toContain("Reconnect")
  expect(f).toContain("Switch off")
  expect(f).not.toContain("Sign in") // a local server has no sign-in
  expect(f).toMatch(/Tools \(\d+\)/)
  expect(f).toContain("esc back")
  // Type to search the tools, then open the one found.
  await t.input.typeText("echo")
  await t.settle()
  expect(t.frame()).toMatch(/○ echo {2}asks · read-only · Repeat the text/)
  expect(t.frame()).toContain("mcp__fix__echo") // the highlighted tool's own name and description
  t.input.pressEnter()
  expect(await t.until("fix · echo")).toBe(true)
  expect(t.frame()).toContain("● Ask each time")
  t.input.pressArrow("down")
  t.input.pressEnter() // Always allow
  expect(await t.until("MCP · fix")).toBe(true)
  expect(t.app.engine.ruleFor("mcp__fix__echo")).toBe("allow")
  await t.input.typeText("echo")
  await t.settle()
  expect(t.frame()).toMatch(/● echo {2}always allowed/)
  // Esc: back to the list, on the server that was open; esc again closes.
  t.input.pressEscape()
  expect(await t.until("MCP servers — 1 of 2 connected")).toBe(true)
  t.input.pressEscape()
  await t.settle()
  expect(t.frame()).not.toContain("MCP servers —")
})

test("/mcp <name> opens that server; a failed one offers its last error in full; an unknown name is said", async () => {
  t = await tui([], { width: 100, height: 32 }, `mcp:\n${broken("gone")}`)
  await t.app.mcpReady
  await t.settle(200)
  await t.input.typeText("/mcp gone")
  t.input.pressEnter()
  expect(await t.until("MCP · gone")).toBe(true)
  expect(t.frame()).toContain("failed: ")
  expect(t.frame()).toContain("Connect again")
  expect(t.frame()).toContain("Read the last error in full")
  for (let i = 0; i < 2; i++) t.input.pressArrow("down")
  t.input.pressEnter()
  expect(await t.until("MCP · gone · the last error")).toBe(true)
  t.input.pressEscape()
  expect(await t.until("Connect again")).toBe(true)
  t.input.pressEscape()
  expect(await t.until("MCP servers — 0 of 1 connected")).toBe(true)
  t.input.pressEscape()
  await t.settle()
  await t.input.typeText("/mcp nosuch")
  t.input.pressEnter()
  expect(await t.until('no MCP server "nosuch" — gone')).toBe(true)
})

test("/mcp at 60 columns, with 30 servers and a server of 200 tools: nothing wider than the screen, the list scrolls, search finds", async () => {
  t = await tui([], { width: 60, height: 24 })
  put(...Array.from({ length: 29 }, (_, i) => fake(`server-${String(i).padStart(2, "0")}`, i % 7 === 3 ? { status: "failed", error: "connection refused by the far side, which is a long reason to give", tools: [] } : i % 5 === 0 ? { status: "needs_auth", tools: [] } : {})), fake("big", { toolCount: 200, source: "project" }))
  t.app.mcp.tools()
  await t.input.typeText("/mcp")
  t.input.pressEnter()
  expect(await t.until("MCP servers — ")).toBe(true)
  expect(widest()).toBeLessThanOrEqual(60)
  expect(t.frame()).toContain("This project")
  expect(t.frame()).toMatch(/· 1\/30/) // where the cursor is, of how many
  expect(t.frame()).toContain("type to filter")
  await t.input.typeText("big")
  await t.settle()
  t.input.pressEnter()
  expect(await t.until("MCP · big")).toBe(true)
  expect(widest()).toBeLessThanOrEqual(60)
  expect(t.frame()).toContain("Tools (200)")
  // The end of a long list is a keypress away, and the footer says where that is.
  t.input.pressKey("END")
  await t.settle()
  expect(t.frame()).toContain("tool_199")
  expect(t.frame()).toMatch(/20\d\/20\d/)
  expect(widest()).toBeLessThanOrEqual(60)
  for (const ch of "tool_137") t.input.pressKey(ch)
  await t.settle()
  expect(t.frame()).toContain("tool_137")
  expect(t.frame()).toContain("Does thing 137.")
  expect(t.frame()).not.toContain("tool_138")
  expect(widest()).toBeLessThanOrEqual(60)
})

test("a rule the person's own config makes stricter is not loosened from the menu; a remote server offers sign-in", async () => {
  t = await tui([], { width: 100, height: 30 }, "permission:\n  mcp__web__tool_0: deny\n")
  put(fake("web", { status: "needs_auth", tools: [] }))
  await t.input.typeText("/mcp web")
  t.input.pressEnter()
  expect(await t.until("MCP · web")).toBe(true)
  expect(t.frame()).toContain("needs sign-in")
  expect(t.frame()).toContain("Sign in")
  expect(t.frame()).toContain("Sign out")
  expect(t.frame()).toContain("https://example.org/web/mcp")
  t.input.pressEscape()
  await t.settle()
  t.input.pressEscape()
  await t.settle()
  expect(t.app.engine.setRule({ permission: "mcp__web__tool_0", pattern: "*", action: "allow" })).toMatchObject({ refused: { action: "deny", source: "global" } })
  expect(t.app.engine.ruleFor("mcp__web__tool_0")).toBe("deny")
  // Stricter is always possible, and for an untrusted project it stays in the session.
  expect(t.app.engine.setRule({ permission: "mcp__web__tool_1", pattern: "*", action: "deny" })).toEqual({ saved: "session" })
  expect(existsSync(join(t.cwd, ".agent", "config.yaml"))).toBe(false)
})

test("without a menu — over the link, in lembas run — /mcp is a plain table, and /mcp <name> one server's tools", async () => {
  t = await tui([], { width: 100, height: 30 }, "permission:\n  mcp__alpha__tool_1: allow\n")
  put(fake("alpha"), fake("beta", { status: "failed", error: "connect ECONNREFUSED\nat the second line", tools: [] }), fake("lembas-library", { toolCount: 1 }))
  t.app.mcp.tools()
  const all = expandSlash(t.app, "/mcp")
  expect(all).toMatchObject({ kind: "message", name: "mcp" })
  const text = (all as { text: string }).text
  expect(text.split("\n")).toEqual([
    "MCP servers:",
    "- alpha — connected — 2 tools (your config)",
    "- beta — failed: connect ECONNREFUSED (your config)",
    "- lembas-library — connected — 1 tool (the LLeMbas server's library)",
    "",
    "/mcp <name> lists one server's tools. A tool asks before it runs unless a permission rule allows it.",
  ])
  const one = (expandSlash(t.app, "/mcp alpha") as { text: string }).text
  expect(one).toContain("alpha — connected — 2 tools")
  expect(one).toContain("\n- mcp__alpha__tool_0 — asks — Does thing 0.")
  expect(one).toContain("\n- mcp__alpha__tool_1 — always allowed — Does thing 1.")
  // One to a line in a terminal and where a reply is drawn as markdown: list lines, none indented.
  expect(text.split("\n").some((l) => /^ {1,3}\S/.test(l))).toBe(false)
  expect((expandSlash(t.app, "/mcp beta") as { text: string }).text).toContain("at the second line")
  expect((expandSlash(t.app, "/mcp off alpha") as { text: string }).text).toContain("done at the terminal")
  expect(mcpText(t.app.mcp, "nosuch")).toContain('No MCP server "nosuch"')
  expect(readFileSync(join(import.meta.dir, "..", "..", "src", "mcp", "text.ts"), "utf8")).not.toMatch(/\.lan\b/)
})
