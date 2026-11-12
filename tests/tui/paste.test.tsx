// Paste placeholders in the prompt box (src/tui/paste.ts, prompt.tsx): a long paste and an image
// are shown as a placeholder and sent in full.
import { afterEach, expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
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

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
/** Run with these environment variables set, then put back. */
async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v)
  try {
    await fn()
  } finally {
    for (const [k, v] of Object.entries(before)) v === undefined ? delete process.env[k] : (process.env[k] = v)
  }
}
const NOT_REMOTE = { SSH_CONNECTION: undefined, SSH_TTY: undefined, SSH_CLIENT: undefined }

test("an image pasted as a data URL is saved and shown as [Image 1]; a data URL that is no image is pasted as the text it is", async () => {
  t = await tui([{ chunks: [delta({ content: "Seen." }), usage(100, 5)] }])
  const a = box(t.setup.renderer.root)
  await t.input.typeText("what is this ")
  await t.input.pasteBracketedText(`data:image/png;base64,${PNG_B64}`)
  await t.settle()
  expect(a.plainText).toBe("what is this [Image 1] ")
  const notOne = `data:image/png;base64,${Buffer.from("this is certainly not a picture").toString("base64")}`
  await t.input.pasteBracketedText(notOne)
  await t.settle()
  expect(a.plainText).toBe(`what is this [Image 1] ${notOne}`)
  // A long one gets the placeholder any long text gets, and is sent as its text.
  const long = `data:image/png;base64,${Buffer.from("not a picture either, ".repeat(12)).toString("base64")}`
  a.insertText(" ")
  await t.input.pasteBracketedText(long)
  await t.settle()
  expect(a.plainText).toBe(`what is this [Image 1] ${notOne} [Pasted text ${long.length} chars] `)
  t.input.pressEnter()
  expect(await t.until("Seen.")).toBe(true)
  // Sent as the @path of the copy kept under the state directory.
  const m = /@(\S+clipboard\/paste-[\w-]+\.png)/.exec(JSON.parse(sent()) as string)
  expect(m).not.toBeNull()
  expect(JSON.parse(sent()) as string).toContain(long)
  expect(readFileSync(m![1]!).toString("base64")).toBe(PNG_B64)
  expect(m![1]!.startsWith(join(paths.state, "clipboard"))).toBe(true)
})

test("ctrl+v with no image: said in a word, the box stays usable; over SSH one line names what works", async () => {
  await withEnv({ ...NOT_REMOTE, DISPLAY: undefined, WAYLAND_DISPLAY: undefined }, async () => {
    t = await tui([])
    const a = box(t.setup.renderer.root)
    t.input.pressKey("v", { ctrl: true })
    // Not waited for: typing goes on at once.
    await t.input.typeText("still typing")
    expect(a.plainText).toBe("still typing")
    expect(await t.until("or use @path")).toBe(true)
    t.stop()
  })
  await withEnv({ SSH_CONNECTION: "192.0.2.1 50000 192.0.2.2 22", DISPLAY: undefined, WAYLAND_DISPLAY: undefined, TERM: "xterm-256color", KITTY_WINDOW_ID: undefined, TMUX: undefined }, async () => {
    t = await tui([], { width: 220, height: 30 })
    t.input.pressKey("v", { ctrl: true })
    expect(await t.until("no image reached this terminal over SSH")).toBe(true)
    const f = t.frame()
    expect(f).toContain("data:image/png;base64")
    expect(f).toContain("@path")
    expect(f).toContain("web, Desktop or Android app")
  })
})

test("over SSH in kitty: ctrl+v asks the terminal for its clipboard, and the image arrives as [Image 1]", async () => {
  await withEnv({ SSH_CONNECTION: "192.0.2.1 50000 192.0.2.2 22", DISPLAY: undefined, WAYLAND_DISPLAY: undefined, TERM: "xterm-kitty", TMUX: undefined, STY: undefined, ZELLIJ: undefined }, async () => {
    t = await tui([], undefined, "kitty_clipboard: true\n")
    const a = box(t.setup.renderer.root)
    const r = t.setup.renderer as any
    const b64 = (s: string) => Buffer.from(s).toString("base64")
    const asked: string[] = []
    // The terminal's half, answered through the renderer's own input: what kitty would send back.
    r.writeOut = (seq: string) => {
      if (!seq.startsWith("\x1b]5522;")) return
      asked.push(seq)
      const id = /id=([^:;]+)/.exec(seq)![1]
      const want = Buffer.from(seq.slice(seq.lastIndexOf(";") + 1).replace("\x1b\\", ""), "base64").toString()
      const reply = (meta: string, payload = "") => r.stdin.emit("data", Buffer.from(`\x1b]5522;type=read:status=${meta}:id=${id}${payload ? `;${payload}` : ""}\x1b\\`))
      setTimeout(() => {
        reply("OK")
        if (want === ".") reply(`DATA:mime=${b64(".")}`, b64("text/plain image/png"))
        else reply(`DATA:mime=${b64("image/png")}`, PNG_B64)
        reply("DONE")
      }, 5)
    }
    await t.input.typeText("see ")
    t.input.pressKey("v", { ctrl: true })
    const end = Date.now() + 4000
    while (Date.now() < end && !a.plainText.includes("[Image 1]")) await t.settle(40)
    expect(a.plainText).toBe("see [Image 1] ")
    expect(asked.length).toBe(2)
  })
})

test("what is dictated is added after a placeholder, which still stands for its text", async () => {
  const stt = Bun.serve({ port: 0, fetch: () => Response.json({ text: "Explain this." }) })
  const mic = join(import.meta.dir, "..", "fixtures", "voice", "mic.ts")
  try {
    t = await tui([{ chunks: [delta({ content: "Explained." }), usage(100, 5)] }], { width: 100, height: 30 }, `voice:\n  stt: { base_url: "http://127.0.0.1:${stt.port}/v1" }\n  recorder_command: ["${process.execPath}", "${mic}", "1"]\n  silence_seconds: 0.4\n`)
    const a = box(t.setup.renderer.root)
    await t.input.pasteBracketedText(LONG)
    await t.settle()
    t.input.pressKey("t", { ctrl: true })
    const end = Date.now() + 8000
    while (Date.now() < end && !a.plainText.includes("Explain this.")) await t.settle(40)
    expect(a.plainText).toBe("[Pasted text 4 lines] Explain this.")
    t.input.pressEnter()
    expect(await t.until("Explained.")).toBe(true)
    expect(sent()).toContain("first line\\nsecond line\\nthird line\\nfourth line Explain this.")
  } finally {
    void stt.stop(true)
  }
})

// ---- found in review ----

test("a paste over a selection: the placeholder goes where the text went, and still stands for it — text and image", async () => {
  t = await tui([{ chunks: [delta({ content: "ok" }), usage(100, 5)] }, { chunks: [delta({ content: "ok2" }), usage(100, 5)] }])
  const a = box(t.setup.renderer.root)
  // Shift+Right from the start: the cursor ends up after the selection, the text goes in before it.
  await t.input.typeText("hello world")
  a.cursorOffset = 0
  for (let i = 0; i < 5; i++) t.input.pressArrow("right", { shift: true })
  await t.settle()
  expect(a.hasSelection()).toBe(true)
  await t.input.pasteBracketedText(LONG)
  await t.settle()
  expect(a.plainText).toContain("[Pasted text 4 lines] ")
  t.input.pressEnter()
  expect(await t.until("ok")).toBe(true)
  expect(sent()).toContain("first line\\nsecond line\\nthird line\\nfourth line")
  expect(sent()).not.toContain("[Pasted text")
  // A mouse drag over the box, then an image pasted in its place.
  const png = join(t.cwd, "pic.png")
  writeFileSync(png, Buffer.from(PNG_B64, "base64"))
  await t.input.typeText("hello world")
  await t.settle()
  const lines = t.frame().split("\n")
  const y = lines.findIndex((l) => l.includes("❯ hello world"))
  const x = lines[y]!.indexOf("hello world")
  await t.setup.mockMouse.drag(x, y, x + 5, y)
  await t.settle()
  expect(a.hasSelection()).toBe(true)
  await t.input.pasteBracketedText(png)
  await t.settle()
  expect(a.plainText).toContain("[Image 1] ")
  t.input.pressEnter()
  expect(await t.until("ok2")).toBe(true)
  expect(sent(1)).toContain(`@${png}`)
  expect(sent(1)).not.toContain("[Image 1]")
})

test("the same paste twice is two copies unless it is the opening gesture: the cursor where the first paste left it", async () => {
  t = await tui([{ chunks: [delta({ content: "ok" }), usage(100, 5)] }])
  const a = box(t.setup.renderer.root)
  await t.input.pasteBracketedText(LONG)
  await t.settle()
  // Something typed in between — even in place of the space — and it is a second copy; the
  // typed character stays.
  t.input.pressBackspace()
  await t.input.typeText("Q")
  await t.input.pasteBracketedText(LONG)
  await t.settle()
  expect(a.plainText).toBe("[Pasted text 4 lines]Q[Pasted text 4 lines] ")
  // Elsewhere in the box: a copy, not the gesture.
  a.cursorOffset = 0
  await t.input.pasteBracketedText(LONG)
  await t.settle()
  expect(a.plainText).toBe("[Pasted text 4 lines] [Pasted text 4 lines]Q[Pasted text 4 lines] ")
  t.input.pressEnter()
  expect(await t.until("ok")).toBe(true)
  expect(sent()).toStartWith(JSON.stringify(`${LONG} ${LONG}Q${LONG}`).slice(0, -1))
})

test("a placeholder is one thing: cutting into it removes all of it, never a stump with its text silently gone", async () => {
  t = await tui([{ chunks: [delta({ content: "ok" }), usage(100, 5)] }])
  const a = box(t.setup.renderer.root)
  await t.input.typeText("pre ")
  await t.input.pasteBracketedText(LONG)
  await t.settle()
  // A selection from inside "pre" into the middle of the label, deleted.
  a.setSelection(2, 10)
  await t.settle()
  t.input.pressBackspace()
  await t.settle()
  expect(a.plainText).toBe("pr ")
  // Undo brings the whole placeholder back, and it still stands for its text.
  a.undo()
  a.undo()
  await t.settle()
  if (!a.plainText.includes("[Pasted text 4 lines]")) a.undo()
  await t.settle()
  expect(a.plainText).toContain("[Pasted text 4 lines]")
  // Kill to the end of the line from inside the text before it takes the placeholder whole.
  a.setText("")
  await t.input.typeText("one two ")
  await t.input.pasteBracketedText(LONG)
  await t.settle()
  a.cursorOffset = 4
  t.input.pressKey("k", { ctrl: true })
  await t.settle()
  expect(a.plainText).toBe("one ")
  await t.input.typeText("three")
  t.input.pressEnter()
  expect(await t.until("ok")).toBe(true)
  expect(sent()).toStartWith('"one three\\n')
})

test("a paste of white space is white space, not a clipboard read", async () => {
  t = await tui([])
  const a = box(t.setup.renderer.root)
  await t.input.typeText("x")
  await t.input.pasteBracketedText("\n")
  await t.settle(300)
  expect(a.plainText).toBe("x\n")
  expect(t.frame()).not.toMatch(/clipboard|no image/)
})

test("a session whose first prompt is a paste is titled by its words, and the prompt event carries them; only this transcript shows the label", async () => {
  t = await tui([{ chunks: [delta({ content: "ok" }), usage(100, 5)] }], undefined, "titles: prompt\n", { store: true })
  const prompts: { text: string }[] = []
  t.app.bus.on((e) => void (e.type === "prompt" && prompts.push(e)))
  const pasted = `Please review this function carefully and say what is wrong with it, in order of importance\nfunction a() {}\nfunction b() {}\nfunction c() {}`
  await t.input.pasteBracketedText(pasted)
  await t.settle()
  t.input.pressEnter()
  expect(await t.until("ok")).toBe(true)
  await t.settle(200)
  expect(t.frame()).toContain("┃ [Pasted text 4 lines]")
  expect(prompts[0]!.text).toBe(pasted)
  const title = t.app.store!.session(t.app.engine.sessionId!)!.title
  expect(title).toStartWith("Please review this function carefully")
  expect(title).not.toContain("[Pasted")
  expect(title).not.toContain("function a")
  expect(title.length).toBeLessThanOrEqual(80)
})

test("over SSH in kitty: off unless turned on; a reply that stalls inside a packet types nothing into the box and saves nothing", async () => {
  const SSH = { SSH_CONNECTION: "192.0.2.1 50000 192.0.2.2 22", DISPLAY: undefined, WAYLAND_DISPLAY: undefined, TERM: "xterm-kitty", TMUX: undefined, STY: undefined, ZELLIJ: undefined }
  const b64 = (s: string) => Buffer.from(s).toString("base64")
  await withEnv(SSH, async () => {
    // Off by default: the terminal is never asked, and the line says what works.
    t = await tui([], { width: 220, height: 30 })
    let asked = 0
    ;(t.setup.renderer as any).writeOut = (seq: string) => void (seq.startsWith("\x1b]5522;") && asked++)
    t.input.pressKey("v", { ctrl: true })
    expect(await t.until("no image reached this terminal over SSH")).toBe(true)
    expect(asked).toBe(0)
    t.stop()

    t = await tui([], { width: 220, height: 30 }, "kitty_clipboard: true\n")
    const a = box(t.setup.renderer.root)
    const r = t.setup.renderer as any
    const before = existsSync(join(paths.state, "clipboard")) ? readdirSync(join(paths.state, "clipboard")).length : 0
    r.writeOut = (seq: string) => {
      if (!seq.startsWith("\x1b]5522;")) return
      const id = /id=([^:;]+)/.exec(seq)![1]
      const want = Buffer.from(seq.slice(seq.lastIndexOf(";") + 1).replace("\x1b\\", ""), "base64").toString()
      const emit = (s: string) => r.stdin.emit("data", Buffer.from(s))
      const reply = (meta: string, payload = "") => `\x1b]5522;type=read:status=${meta}:id=${id}${payload ? `;${payload}` : ""}\x1b\\`
      setTimeout(async () => {
        emit(reply("OK"))
        if (want === ".") return void (emit(reply(`DATA:mime=${b64(".")}`, b64("text/plain image/png"))), emit(reply("DONE")))
        // The packet stops arriving half-way for longer than the input parser waits.
        const whole = reply(`DATA:mime=${b64("image/png")}`, PNG_B64)
        emit(whole.slice(0, 60))
        await Bun.sleep(80)
        emit(whole.slice(60))
        emit(reply("DONE"))
      }, 5)
    }
    await t.input.typeText("see ")
    t.input.pressKey("v", { ctrl: true })
    expect(await t.until("did not arrive whole")).toBe(true)
    expect(a.plainText).toBe("see ")
    expect(existsSync(join(paths.state, "clipboard")) ? readdirSync(join(paths.state, "clipboard")).length : 0).toBe(before)
    // The box takes input again once the read is over.
    await t.input.typeText("now")
    expect(a.plainText).toBe("see now")
  })
})
