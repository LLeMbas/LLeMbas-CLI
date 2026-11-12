// Paste placeholders in the prompt box (src/tui/paste.ts, prompt.tsx): a long paste and an image
// are shown as a placeholder and sent in full.
import { afterEach, expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { paths } from "../../src/config/paths.ts"
import { nextImageNumber, pasteLabel } from "../../src/tui/paste.ts"
import { delta, usage } from "../fake-provider.ts"
import { tui } from "./harness.tsx"

let t: Awaited<ReturnType<typeof tui>> | undefined
afterEach(() => t?.stop())

const box = (n: any): TextareaRenderable => (n instanceof TextareaRenderable ? n : n.getChildren?.().map(box).find(Boolean))
const LONG = ["first line", "second line", "third line", "fourth line"].join("\n")
/** The last user message of request `i`, as JSON text. */
const sent = (i = 0) => JSON.stringify((t!.fake.requests[i]!.messages as { role: string; content: unknown }[]).filter((m) => m.role === "user").at(-1)!.content)

test("which pastes get a placeholder, and what it says", () => {
  expect(pasteLabel("one\ntwo")).toBeUndefined()
  expect(pasteLabel("one\ntwo\nthree")).toBe("[Pasted text 3 lines]")
  expect(pasteLabel("x".repeat(150))).toBeUndefined()
  expect(pasteLabel("x".repeat(151))).toBe("[Pasted text 151 chars]")
  // Two long lines are still one long text, counted in characters (code points).
  expect(pasteLabel(`${"é".repeat(100)}\n${"é".repeat(100)}`)).toBe("[Pasted text 201 chars]")
  expect(nextImageNumber([])).toBe(1)
  expect(nextImageNumber(["[Image 1]", "[Pasted text 3 lines]", "[Image 4]"])).toBe(5)
})

test("a long paste shows as a placeholder; the text itself is sent, and the transcript shows the placeholder", async () => {
  t = await tui([{ chunks: [delta({ content: "Read it." }), usage(100, 5)] }])
  const a = box(t.setup.renderer.root)
  await t.input.typeText("look: ")
  await t.input.pasteBracketedText(LONG)
  await t.settle()
  expect(a.plainText).toBe("look: [Pasted text 4 lines] ")
  expect(t.frame()).toContain("look: [Pasted text 4 lines]")
  await t.input.typeText("thanks")
  t.input.pressEnter()
  expect(await t.until("Read it.")).toBe(true)
  expect(sent()).toContain("look: first line\\nsecond line\\nthird line\\nfourth line thanks")
  expect(sent()).not.toContain("[Pasted text")
  expect(t.frame()).toContain("┃ look: [Pasted text 4 lines] thanks")
  expect(a.plainText).toBe("")
})

test("a short paste goes in as it is; text after wide characters keeps the placeholder in place", async () => {
  t = await tui([{ chunks: [delta({ content: "ok" }), usage(100, 5)] }])
  const a = box(t.setup.renderer.root)
  await t.input.pasteBracketedText("just\ntwo")
  await t.settle()
  expect(a.plainText).toBe("just\ntwo")
  a.setText("")
  // Offsets in the box are columns: a wide character before the placeholder must not shift it.
  a.insertText("日本語 🙂 ")
  await t.input.pasteBracketedText(LONG)
  await t.settle()
  a.insertText("end")
  expect(a.plainText).toBe("日本語 🙂 [Pasted text 4 lines] end")
  t.input.pressEnter()
  expect(await t.until("ok")).toBe(true)
  expect(sent()).toContain("日本語 🙂 first line\\nsecond line\\nthird line\\nfourth line end")
})

test("deleting the placeholder removes the content; undo in the box brings both back", async () => {
  t = await tui([{ chunks: [delta({ content: "ok" }), usage(100, 5)] }])
  const a = box(t.setup.renderer.root)
  await t.input.typeText("a ")
  await t.input.pasteBracketedText(LONG)
  await t.settle()
  t.input.pressBackspace() // the space after it
  t.input.pressBackspace() // the placeholder, whole
  await t.settle()
  expect(a.plainText).toBe("a ")
  a.undo()
  await t.settle()
  expect(a.plainText).toContain("[Pasted text 4 lines]")
  a.gotoBufferEnd()
  t.input.pressBackspace()
  await t.settle()
  expect(a.plainText).toBe("a ")
  await t.input.typeText("b")
  t.input.pressEnter()
  expect(await t.until("ok")).toBe(true)
  expect(sent()).toStartWith('"a b\\n')
  expect(sent()).not.toContain("first line")
})

test("the same paste again, right after its placeholder, opens it", async () => {
  t = await tui([])
  const a = box(t.setup.renderer.root)
  await t.input.pasteBracketedText(LONG)
  await t.settle()
  expect(a.plainText).toBe("[Pasted text 4 lines] ")
  await t.input.pasteBracketedText(LONG)
  await t.settle()
  expect(a.plainText).toBe(LONG)
})

test("two pastes with the same label keep their own text; an @file completed beside them leaves them alone", async () => {
  t = await tui([{ chunks: [delta({ content: "ok" }), usage(100, 5)] }])
  const a = box(t.setup.renderer.root)
  await t.input.pasteBracketedText("a1\na2\na3")
  await t.input.pasteBracketedText("b1\nb2\nb3")
  await t.settle()
  expect(a.plainText).toBe("[Pasted text 3 lines] [Pasted text 3 lines] ")
  await t.input.typeText("@hello")
  expect(await t.until("hello.txt")).toBe(true)
  t.input.pressTab()
  await t.settle()
  expect(a.plainText).toBe("[Pasted text 3 lines] [Pasted text 3 lines] @hello.txt ")
  t.input.pressEnter()
  expect(await t.until("ok")).toBe(true)
  expect(sent()).toContain("a1\\na2\\na3 b1\\nb2\\nb3 @hello.txt")
})

test("history and /undo give the text in full", async () => {
  t = await tui([{ chunks: [delta({ content: "Answered." }), usage(100, 5)] }])
  const a = box(t.setup.renderer.root)
  await t.input.typeText("see ")
  await t.input.pasteBracketedText(LONG)
  await t.settle()
  t.input.pressEnter()
  expect(await t.until("Answered.")).toBe(true)
  // History is the file other sessions read too: the text itself.
  const history = readFileSync(join(paths.state, "history.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as string)
  expect(history.at(-1)).toBe(`see ${LONG} `)
  t.input.pressArrow("up")
  await t.settle()
  expect(a.plainText).toBe(`see ${LONG} `)
  a.setText("")
  await t.input.typeText("/undo")
  t.input.pressEnter()
  await t.settle(200)
  expect(a.plainText).toContain(`see ${LONG}`)
})

test("a refused send puts the placeholder back, still standing for its text", async () => {
  t = await tui([{ chunks: [delta({ content: "Slow" }), delta({ content: "ly" }), delta({ content: " done." }), usage(100, 5)], gapMs: 300 }, { chunks: [delta({ content: "Second." }), usage(100, 5)] }])
  const a = box(t.setup.renderer.root)
  await t.input.typeText("go")
  t.input.pressEnter()
  expect(await t.until("Slow")).toBe(true)
  // Busy with a turn: a command that must wait is refused, and the box comes back whole.
  await t.input.typeText("/compact ")
  await t.input.pasteBracketedText(LONG)
  await t.settle(20)
  t.input.pressEnter()
  await t.settle(20)
  expect(t.frame()).toContain("wait for the reply to finish")
  expect(a.plainText).toBe("/compact [Pasted text 4 lines] ")
  expect(await t.until("ly done.")).toBe(true) // the notice above went in mid-reply
  // Still a placeholder: sent now as a prompt, it is the text.
  a.cursorOffset = 0
  for (let k = 0; k < "/compact ".length; k++) a.deleteChar()
  t.input.pressEnter()
  expect(await t.until("Second.")).toBe(true)
  expect(sent(1)).toContain("first line\\nsecond line")
})

test("copying a selection in the box copies the text in full", async () => {
  t = await tui([])
  const a = box(t.setup.renderer.root)
  await t.input.typeText("x ")
  await t.input.pasteBracketedText(LONG)
  await t.settle()
  const copied: string[] = []
  ;(t.setup.renderer as any).copyToClipboardOSC52 = (s: string) => (copied.push(s), true)
  // Drag across the box's one row.
  const y = t.frame().split("\n").findIndex((l) => l.includes("[Pasted text 4 lines]"))
  const x = t.frame().split("\n")[y]!.indexOf("x [Pasted")
  await t.setup.mockMouse.drag(x, y, x + 30, y)
  await t.settle()
  expect(copied.at(-1)).toBe(`x ${LONG} `)
  expect(a.plainText).toBe("x [Pasted text 4 lines] ")
})

test("paste: full shows the text itself", async () => {
  t = await tui([], undefined, "paste: full\n")
  const a = box(t.setup.renderer.root)
  await t.input.pasteBracketedText(LONG)
  await t.settle()
  expect(a.plainText).toBe(LONG)
})

test("a pasted path to an image is [Image N], numbered after the highest in the box, and sent as its @path", async () => {
  t = await tui([{ chunks: [delta({ content: "Seen." }), usage(100, 5)] }])
  const a = box(t.setup.renderer.root)
  // A 1×1 PNG.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64")
  const one = join(t.cwd, "shot one.png")
  const two = join(t.cwd, "two.png")
  writeFileSync(one, png)
  writeFileSync(two, png)
  await t.input.pasteBracketedText(`'${one}'`)
  await t.input.pasteBracketedText(two)
  await t.settle()
  expect(a.plainText).toBe("[Image 1] [Image 2] ")
  // The first one deleted: the next is numbered after the highest still there.
  a.cursorOffset = "[Image 1] ".length
  t.input.pressBackspace()
  t.input.pressBackspace()
  await t.settle()
  expect(a.plainText).toBe("[Image 2] ")
  a.gotoBufferEnd()
  await t.input.pasteBracketedText(`file://${one.replace(/ /g, "%20")}`)
  await t.settle()
  expect(a.plainText).toBe("[Image 2] [Image 3] ")
  t.input.pressEnter()
  expect(await t.until("Seen.")).toBe(true)
  expect(t.frame()).toContain("┃ [Image 2] [Image 3]")
  expect(sent()).toContain(`@${two} @${one.replace(/ /g, "\\\\ ")}`)
  expect(t.frame()).toContain("attached")
})

test("an @file completed after wide characters replaces its own token, nothing else", async () => {
  t = await tui([])
  const a = box(t.setup.renderer.root)
  a.insertText("日本語の説明 ")
  await t.input.typeText("@hello")
  expect(await t.until("hello.txt")).toBe(true)
  t.input.pressTab()
  await t.settle()
  expect(a.plainText).toBe("日本語の説明 @hello.txt ")
})
