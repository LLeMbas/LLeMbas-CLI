// The menus built on the shared one: /help, /permissions, /status, /agents — and what the same
// commands say where there is no menu.
import { afterEach, expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { expandSlash } from "../../src/session/commands.ts"
import { COMMANDS } from "../../src/tui/commands.ts"
import { parseRule } from "../../src/tui/menus.ts"
import { tui } from "./harness.tsx"

let t: Awaited<ReturnType<typeof tui>> | undefined
afterEach(() => t?.stop())
const box = (n: any): TextareaRenderable => (n instanceof TextareaRenderable ? n : n.getChildren?.().map(box).find(Boolean))
const widest = () => Math.max(...t!.frame().split("\n").map((l) => l.trimEnd().length))
const text = (cmd: string) => (expandSlash(t!.app, cmd) as { text: string }).text

test("/help is a menu: commands under headings, found by typing; enter runs one, or puts one that needs words in the box", async () => {
  t = await tui([], { width: 110, height: 36 })
  const a = box(t.setup.renderer.root)
  await t.input.typeText("/help")
  t.input.pressEnter()
  expect(await t.until("Help — commands and keys")).toBe(true)
  let f = t.frame()
  expect(f).toContain("This session")
  expect(f).toContain("/new")
  expect(f).toContain("type to find")
  expect(f).not.toContain("⚠")
  // Typing finds a command by what it does, not only by its name.
  for (const ch of "permission rules") t.input.pressKey(ch)
  await t.settle()
  f = t.frame()
  expect(f).toContain("/permissions")
  expect(f).not.toContain("/theme")
  t.input.pressEnter()
  expect(await t.until("Permissions — mode")).toBe(true)
  t.input.pressEscape()
  await t.settle()
  // One that needs words goes into the box to be finished.
  await t.input.typeText("/help")
  t.input.pressEnter()
  expect(await t.until("Help — commands and keys")).toBe(true)
  for (const ch of "/rename") t.input.pressKey(ch)
  await t.settle()
  t.input.pressEnter()
  await t.settle()
  expect(a.plainText).toBe("/rename ")
  // The keys are rows too.
  a.setText("")
  await t.input.typeText("/help")
  t.input.pressEnter()
  expect(await t.until("Help — commands and keys")).toBe(true)
  for (const ch of "ctrl+g") t.input.pressKey(ch)
  await t.settle()
  expect(t.frame()).toContain("Keys")
  expect(t.frame()).toContain("ctrl+g continue")
})

test("every command has a place in /help", async () => {
  t = await tui([], { width: 110, height: 60 })
  await t.input.typeText("/help")
  t.input.pressEnter()
  expect(await t.until("Help — commands and keys")).toBe(true)
  const missing: string[] = []
  for (const cmd of COMMANDS) {
    for (const ch of `/${cmd.name}`) t.input.pressKey(ch)
    await t.settle(12)
    if (!new RegExp(`/${cmd.name}(\\s|$)`, "m").test(t.frame())) missing.push(cmd.name)
    for (let i = 0; i <= cmd.name.length; i++) t.input.pressBackspace()
    await t.settle(8)
  }
  expect(missing).toEqual([])
}, 40_000)

test("/permissions: the rules by where they were made; enter changes one; a rule can be added and this session's removed", async () => {
  t = await tui([], { width: 110, height: 36 }, "permission:\n  bash:\n    'git push *': deny\n")
  await t.input.typeText("/permissions")
  t.input.pressEnter()
  expect(await t.until("Permissions — mode manual")).toBe(true)
  let f = t.frame()
  expect(f).toContain("Add a rule…")
  expect(f).toContain("Your config")
  expect(f).toMatch(/✗ bash git push \* {2}denied/)
  expect(f).toContain("this session only")
  expect(f).toContain("not trusted")
  // Add one.
  t.input.pressEnter()
  expect(await t.until("Add a permission rule")).toBe(true)
  expect(t.frame()).toContain("Type the rule and press enter")
  for (const ch of "bash git status* allow") t.input.pressKey(ch)
  await t.settle()
  t.input.pressEnter()
  expect(await t.until("Permissions — mode manual")).toBe(true)
  expect(t.app.engine.ruleFor("bash", "git status*")).toBe("allow")
  f = t.frame()
  expect(f).toContain("This session")
  expect(f).toMatch(/● bash git status\* {2}always allowed/)
  // The menu comes back on the rule just made: enter opens it, and it can be removed.
  t.input.pressEnter()
  expect(await t.until("Remove this session's rule")).toBe(true)
  for (let i = 0; i < 3; i++) t.input.pressArrow("down")
  t.input.pressEnter()
  expect(await t.until("Permissions — mode manual")).toBe(true)
  expect(t.app.engine.ruleFor("bash", "git status*")).not.toBe("allow")
  t.input.pressEscape()
  await t.settle()
  // The person's own deny is not loosened from here: said, and nothing changes.
  expect(t.app.engine.setRule({ permission: "bash", pattern: "git push *", action: "allow" })).toMatchObject({ refused: { action: "deny" } })
  expect(parseRule("bash git status* allow")).toEqual({ permission: "bash", pattern: "git status*", action: "allow" })
  expect(parseRule("mcp__files__read deny")).toEqual({ permission: "mcp__files__read", pattern: "*", action: "deny" })
  expect(parseRule("edit src/my file.ts ask")).toEqual({ permission: "edit", pattern: "src/my file.ts", action: "ask" })
  expect(typeof parseRule("bash")).toBe("string")
  expect(typeof parseRule("bash git status* maybe")).toBe("string")
})

test("/status: one screen; what needs attention is marked; enter opens what changes it", async () => {
  t = await tui([], { width: 110, height: 40 })
  await t.input.typeText("/status")
  t.input.pressEnter()
  expect(await t.until("Status")).toBe(true)
  const f = t.frame()
  for (const s of ["This program", "The LLeMbas server", "This session", "This project", "MCP servers", "This terminal"]) expect(f).toContain(s)
  expect(f).toMatch(/● version +2\./)
  expect(f).toMatch(/● model +fake\/coder/)
  // The test project is not trusted: that is the one row marked.
  expect(f).toMatch(/⚠ trusted +no: its \.agent config is ignored/)
  expect(f).toContain("pasting images")
  // Enter on the model row opens the model picker.
  for (let i = 0; i < 2; i++) t.input.pressArrow("down")
  t.input.pressEnter()
  expect(await t.until("fake/other")).toBe(true)
})

test("/agents is a menu; enter puts the subagent's name in the box to hand it a task", async () => {
  t = await tui([], { width: 110, height: 36 })
  const a = box(t.setup.renderer.root)
  await t.input.typeText("/agents")
  t.input.pressEnter()
  expect(await t.until("Subagents — ")).toBe(true)
  expect(t.frame()).toContain("Built in")
  expect(t.frame()).toContain("New subagent…")
  const first = t.app.agents[0]!.name
  t.input.pressEnter()
  await t.settle()
  expect(a.plainText).toBe(`/agents ${first} `)
})

test("the menus fit a 60-column terminal", async () => {
  t = await tui([], { width: 60, height: 24 }, "permission:\n  bash:\n    'git push --force-with-lease origin some-very-long-branch-name-indeed *': deny\n")
  for (const cmd of ["/help", "/permissions", "/status", "/agents", "/mcp", "/settings"]) {
    await t.input.typeText(cmd)
    t.input.pressEnter()
    await t.settle(120)
    expect(t.frame()).toContain("esc close")
    expect(widest()).toBeLessThanOrEqual(60)
    t.input.pressEscape()
    await t.settle(60)
  }
})

test("without a menu the same commands are plain text: /permissions and /status over the link and in lembas run", async () => {
  t = await tui([], undefined, "permission:\n  bash:\n    'git push *': deny\n")
  t.app.engine.setRule({ permission: "edit", pattern: "docs/*", action: "allow" })
  const p = text("/permissions")
  expect(p).toStartWith("Mode: manual.")
  expect(p).toContain("This session:\n- allow: edit docs/*")
  expect(p).toContain("Your config:\n- deny: bash git push *")
  expect(p).toContain("Built in:")
  const s = text("/status")
  expect(s).toContain("This program:\n- version: ")
  expect(s).toContain("- model: fake/coder")
  expect(s).toMatch(/- trusted: no: .*\(needs attention\)/)
  expect(s).toContain("- servers: none configured")
})

test("a command chosen in a menu goes through the same guard as one typed: not while a reply runs", async () => {
  const { delta, usage } = await import("../fake-provider.ts")
  t = await tui([{ chunks: [delta({ content: "Slow" }), delta({ content: "ly" }), delta({ content: " going" }), delta({ content: " on" }), delta({ content: " and on." }), usage(100, 5)], gapMs: 500 }], { width: 110, height: 40 })
  await t.input.typeText("go")
  t.input.pressEnter()
  expect(await t.until("Slow")).toBe(true)
  const session = t.app.engine.sessionId
  const messages = t.app.engine.messages.length
  // /help → /new, while the reply streams.
  await t.input.typeText("/help")
  t.input.pressEnter()
  expect(await t.until("Help — commands and keys")).toBe(true)
  for (const ch of "/new") t.input.pressKey(ch)
  await t.settle()
  t.input.pressEnter()
  expect(await t.until("wait for the reply to finish (esc stops it)")).toBe(true)
  expect(t.app.engine.sessionId).toBe(session)
  expect(t.app.engine.messages.length).toBeGreaterThanOrEqual(messages)
  // /status → the model row → /model, likewise.
  await t.input.typeText("/status")
  t.input.pressEnter()
  expect(await t.until("This program")).toBe(true)
  for (let i = 0; i < 2; i++) t.input.pressArrow("down")
  await t.settle()
  t.input.pressEnter()
  await t.settle(150)
  expect(t.frame()).not.toContain("fake/other") // the model picker did not open
  expect(t.frame().split("wait for the reply to finish").length - 1).toBe(2)
  expect(await t.until("and on.")).toBe(true)
}, 30_000)

test("a paste goes into Add a rule; Enter on a row that is only to be read keeps the menu open", async () => {
  t = await tui([], { width: 110, height: 40 })
  await t.input.typeText("/permissions")
  t.input.pressEnter()
  expect(await t.until("Permissions — mode manual")).toBe(true)
  t.input.pressEnter()
  expect(await t.until("Add a permission rule")).toBe(true)
  await t.input.pasteBracketedText("bash make test* allow\n")
  await t.settle()
  expect(t.frame()).toContain("bash make test* allow")
  t.input.pressEnter()
  expect(await t.until("Permissions — mode manual")).toBe(true)
  expect(t.app.engine.ruleFor("bash", "make test*")).toBe("allow")
  t.input.pressEscape()
  await t.settle()
  // /help: a key is a row to read.
  await t.input.typeText("/help")
  t.input.pressEnter()
  expect(await t.until("Help — commands and keys")).toBe(true)
  for (const ch of "shift+enter") t.input.pressKey(ch)
  await t.settle()
  t.input.pressEnter()
  await t.settle(120)
  expect(t.frame()).toContain("Help — commands and keys")
  t.input.pressEscape()
  await t.settle()
  // /status: a row with nothing behind it, likewise.
  await t.input.typeText("/status")
  t.input.pressEnter()
  expect(await t.until("This program")).toBe(true)
  t.input.pressEnter() // "version"
  await t.settle(120)
  expect(t.frame()).toContain("This program")
})
