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
