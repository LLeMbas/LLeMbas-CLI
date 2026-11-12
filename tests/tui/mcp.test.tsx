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
  // No notice of any kind, and no warning sign anywhere on the screen.
  expect(t.view.state.items.filter((i) => i.kind === "notice")).toEqual([])
  expect(f).not.toContain(NOTICES.warn.glyph)
  expect(f).not.toContain("connected")
  expect(f).not.toContain("mcp__")
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
  expect(notices[0]!.text).toEndWith("— /mcp gone shows more")
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
  expect(t.app.engine.setRule({ permission: "mcp__web__tool_1", pattern: "*", action: "deny" })).toEqual({ saved: "session", still: [] })
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
  // Over the link the text is drawn as markdown: a tool's name is code.
  expect(one).toContain("\n- `mcp__alpha__tool_0` — asks — Does thing 0.")
  expect(one).toContain("\n- `mcp__alpha__tool_1` — always allowed — Does thing 1.")
  // In lembas run it is printed as it is.
  const plain = (expandSlash(t.app, "/mcp alpha", { plain: true }) as { text: string }).text
  expect(plain).toContain("\n- mcp__alpha__tool_0 — asks — Does thing 0.")
  // One to a line in a terminal and where a reply is drawn as markdown: list lines, none indented.
  expect(text.split("\n").some((l) => /^ {1,3}\S/.test(l))).toBe(false)
  // An error is its first line only where the text may leave this machine.
  expect((expandSlash(t.app, "/mcp beta") as { text: string }).text).not.toContain("at the second line")
  // Only alone, or with exactly a server's name, is it the command; anything else is a prompt.
  expect(expandSlash(t.app, "/mcp off alpha")).toBeUndefined()
  expect(expandSlash(t.app, "/mcp nosuch")).toBeUndefined()
  expect(expandSlash(t.app, "/status of the build?")).toBeUndefined()
  expect(expandSlash(t.app, "/permissions please")).toBeUndefined()
  expect(mcpText(t.app.mcp, "nosuch")).toContain('No MCP server "nosuch"')
  expect(readFileSync(join(import.meta.dir, "..", "..", "src", "mcp", "text.ts"), "utf8")).not.toMatch(/\.lan\b/)
})

// ---- found in review ----

import { mkdirSync, writeFileSync } from "node:fs"
import { TextareaRenderable } from "@opentui/core"
import { paths } from "../../src/config/paths.ts"
const box = (n: any): TextareaRenderable => (n instanceof TextareaRenderable ? n : n.getChildren?.().map(box).find(Boolean))
const noticesOf = () => (t!.view.state.items.filter((i) => i.kind === "notice") as { text: string; level: string }[]).map((n) => n.text)

test("a server's strings cannot draw on the screen; a prompt goes into the box under its registered name", async () => {
  t = await tui([], { width: 110, height: 34 })
  const a = box(t.setup.renderer.root)
  put(
    fake("evil", {
      tools: [{ name: "wipe", description: "Clears \x1b[2J\x1b[Hthe \x1b]0;pwned\x07screen.\nAnd more.", inputSchema: {} }],
      prompts: [{ name: "do it.now", description: "Says \x1b[31mhello" }],
      error: undefined,
    }),
  )
  t.app.mcp.tools()
  await t.input.typeText("/mcp evil")
  t.input.pressEnter()
  expect(await t.until("MCP · evil")).toBe(true)
  const f = t.frame()
  expect(f).not.toContain("\x1b")
  expect(f).not.toContain("pwned")
  expect(f).toContain("Clears the screen.")
  expect(f).toContain("/evil:do_it_now")
  expect(f).not.toContain("/evil:do it.now")
  t.input.pressKey("END")
  await t.settle()
  t.input.pressEnter()
  await t.settle()
  expect(a.plainText).toBe("/evil:do_it_now ")
})

test("a reconnect that fails says so once; reading the error does not close the menu on Enter; signing out asks first", async () => {
  t = await tui([], { width: 120, height: 36 }, `mcp:\n${broken("gone")}`)
  await t.app.mcpReady
  await t.settle(300)
  expect(noticesOf().filter((x) => x.startsWith("MCP gone")).length).toBe(1)
  await t.input.typeText("/mcp gone")
  t.input.pressEnter()
  expect(await t.until("Connect again")).toBe(true)
  t.input.pressEnter() // Connect again
  const end = Date.now() + 6000
  while (Date.now() < end && noticesOf().filter((x) => x.startsWith("MCP gone")).length < 2) await t.settle(60)
  await t.settle(400)
  // One more line for the one more failure — not two.
  expect(noticesOf().filter((x) => x.startsWith("MCP gone")).length).toBe(2)
  expect(await t.until("MCP · gone")).toBe(true)
  // The error in full: Enter on a line of it does nothing, and the view stays.
  for (let i = 0; i < 2; i++) t.input.pressArrow("down")
  t.input.pressEnter()
  expect(await t.until("MCP · gone · the last error")).toBe(true)
  t.input.pressEnter()
  await t.settle(120)
  expect(t.frame()).toContain("MCP · gone · the last error")
  t.input.pressEscape()
  await t.settle()
  t.input.pressEscape()
  await t.settle()
  t.input.pressEscape()
  await t.settle()
  // Sign out: asked once, and "keep" is where the cursor starts.
  put(fake("web", { status: "connected" }))
  let out = 0
  t.app.mcp.logout = () => void out++
  await t.input.typeText("/mcp web")
  t.input.pressEnter()
  expect(await t.until("MCP · web")).toBe(true)
  for (let i = 0; i < 3; i++) t.input.pressArrow("down")
  t.input.pressEnter()
  expect(await t.until("Sign out of web?")).toBe(true)
  t.input.pressEnter() // keep the sign-in
  expect(await t.until("MCP · web")).toBe(true)
  expect(out).toBe(0)
  t.input.pressEnter()
  expect(await t.until("Sign out of web?")).toBe(true)
  t.input.pressArrow("up")
  t.input.pressEnter()
  await t.settle(150)
  expect(out).toBe(1)
})

test("a server the person's own config switches off is switched on for the session only, and the menu says why", async () => {
  t = await tui([], { width: 130, height: 34 })
  // As if the project were trusted: the question is only what "on" may be kept for.
  ;(t.app as { trusted: boolean }).trusted = true
  put(fake("quiet", { status: "disabled", cfg: { url: "https://example.org/quiet/mcp", source: "global", enabled: false } as never, tools: [] }))
  await t.input.typeText("/mcp quiet")
  t.input.pressEnter()
  expect(await t.until("MCP · quiet")).toBe(true)
  const row = t.frame().split("\n").find((l) => l.includes("Switch on"))!
  expect(row).toContain("connect it — for this session")
  expect(row).not.toContain("for this project")
  // Why, under the list while the row is highlighted.
  expect(t.frame()).toContain("Your own config switches this server off")
  expect(t.frame()).toContain("project cannot switch it")
})

test("a menu fits the rows there are, and its list does not move when the highlighted row has more to say", async () => {
  for (const height of [9, 12, 16]) {
    t?.stop()
    t = await tui([], { width: 80, height })
    put(fake("srv", { toolCount: 40 }))
    t.app.mcp.tools()
    await t.input.typeText("/mcp srv")
    t.input.pressEnter()
    expect(await t.until("MCP · srv")).toBe(true)
    const lines = t.frame().split("\n")
    // The whole box is on the screen: its title row and its bottom border, and the key hints.
    expect(lines.some((l) => l.includes("╭─ MCP · srv"))).toBe(true)
    expect(lines.some((l) => l.includes("╰"))).toBe(true)
    expect(t.frame()).toContain("esc back")
    expect(lines.filter((l, i) => i < lines.length - 1 || l.trim()).length).toBeLessThanOrEqual(height)
    // Nothing of the box is cut off: its top and bottom borders are both there, in that order.
    expect(lines.findIndex((l) => l.includes("╭─ MCP · srv"))).toBeLessThan(lines.findLastIndex((l) => l.includes("╰")))
  }
  t?.stop()
  t = await tui([], { width: 100, height: 36 })
  put(fake("srv", { toolCount: 5 }))
  t.app.mcp.tools()
  await t.input.typeText("/mcp srv")
  t.input.pressEnter()
  expect(await t.until("MCP · srv")).toBe(true)
  // On an action (nothing more to say) and then on a tool (a description under the list): the
  // rows of the list stay where they are.
  const rowOf = (text: string) => t!.frame().split("\n").findIndex((l) => l.includes(text))
  const before = [rowOf("Reconnect"), rowOf("tool_0"), rowOf("esc back")]
  for (let i = 0; i < 2; i++) t.input.pressArrow("down")
  await t.settle()
  expect(t.frame()).toContain("Does thing 0.")
  expect([rowOf("Reconnect"), rowOf("tool_0"), rowOf("esc back")]).toEqual(before)
})

test("a custom command named like a built-in is said at start, and reached with /command", async () => {
  mkdirSync(join(paths.config, "commands"), { recursive: true })
  const file = join(paths.config, "commands", "status.md")
  writeFileSync(file, "---\ndescription: my own status\n---\nSay how the build is doing. $ARGUMENTS\n")
  try {
    const { delta, usage } = await import("../fake-provider.ts")
    t = await tui([{ chunks: [delta({ content: "Green." }), usage(10, 2)] }], { width: 130, height: 30 })
    await t.settle(150)
    const said = noticesOf().filter((x) => x.includes("/status"))
    expect(said.length).toBe(1)
    expect(said[0]).toContain("has the name of a built-in command")
    expect(said[0]).toContain("/command status")
    await t.input.typeText("/command status today")
    t.input.pressEnter()
    expect(await t.until("Green.")).toBe(true)
    expect(JSON.stringify(t.fake.requests[0].messages.at(-1))).toContain("Say how the build is doing. today")
    // Over the link the same way; and /skill has a way too.
    expect(expandSlash(t.app, "/command status now")).toMatchObject({ kind: "prompt", name: "command" })
    expect(expandSlash(t.app, "/command nosuch")).toMatchObject({ kind: "message", error: true })
    expect(expandSlash(t.app, "/skill nosuchskill do it")).toMatchObject({ kind: "message", error: true, text: 'no skill "nosuchskill"' })
    expect(expandSlash(t.app, "/status")).toMatchObject({ kind: "message", name: "status" }) // the built-in still wins
  } finally {
    const { rmSync } = await import("node:fs")
    rmSync(file, { force: true })
  }
})
