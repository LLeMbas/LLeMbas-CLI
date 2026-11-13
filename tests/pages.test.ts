// HTML pages in a terminal (harness spec 3.8.0, pages.md): a terminal's model is never offered
// pages, but a reply that has one — a report, a chat seen over the link, an older session — is
// drawn with the note in the page's place, and the page is kept as a file under the state
// directory; /pages lists them. How a fence is read is the conformance area `pages`.
import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { paths } from "../src/config/paths.ts"
import { loadConfig } from "../src/config/load.ts"
import { pageNote, parseInfo, splitPages, textProjection, titleFor } from "../src/pages/fence.ts"
import { listPages, pageDir, savePage, slugOf } from "../src/pages/store.ts"
import { delta } from "./fake-provider.ts"
import { tui } from "./tui/harness.tsx"

let t: Awaited<ReturnType<typeof tui>> | undefined
afterEach(() => t?.stop())

const PAGE = "<!doctype html>\n<title>Bakery</title>\n<p>Fresh bread.</p>"

test("the info line: exactly html-view, the title the rest of the line or the page's own", () => {
  expect(parseInfo("html-view Monthly sales")).toEqual({ title: "Monthly sales" })
  expect(parseInfo("html-view")).toEqual({ title: "" })
  expect(parseInfo("HTML-View x")).toBeNull()
  expect(parseInfo("html")).toBeNull()
  expect(parseInfo("prototype-page Old")).toBeNull()
  expect(titleFor("<title>  <b>From</b>\n the page </title>", "")).toBe("From the page")
  expect(titleFor(PAGE, "Given")).toBe("Given")
  expect(titleFor("<p>none</p>", "")).toBe("Page")
})

test("a reply split: markdown as it is, a page fence closed or still streaming, other code blocks left alone", () => {
  const text = "Here:\n\n```html-view Bakery landing\n" + PAGE + "\n```\n\nAnd code:\n\n```js\nconsole.log(1)\n```\n\n```html-view\n<p>half"
  const segs = splitPages(text)
  expect(segs.map((s) => s.kind)).toEqual(["text", "page", "text", "page"])
  expect(segs[1]).toMatchObject({ kind: "page", title: "Bakery landing", code: PAGE, closed: true })
  expect(segs[3]).toMatchObject({ kind: "page", closed: false, code: "<p>half" })
  // As text: the finished page is its one line; the unfinished one is the code block it is.
  expect(textProjection(text)).toBe("Here:\n\n[page: Bakery landing]\n\nAnd code:\n\n```js\nconsole.log(1)\n```\n\n```html-view\n<p>half")
  expect(pageNote("Bakery landing")).toBe("This answer has a page: Bakery landing")
})

test("a page is saved once, as written, for this user only, under the state directory", () => {
  const id = `s-${Date.now()}`
  const path = savePage(id, PAGE, "Bakery landing")
  expect(path).toBe(join(pageDir(id), "1-bakery-landing.html"))
  expect(path.startsWith(join(paths.state, "pages"))).toBe(true)
  expect(readFileSync(path, "utf8")).toBe(PAGE)
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(savePage(id, PAGE, "Another name")).toBe(path)
  expect(savePage(id, "<title>Sales: Q3</title><p>x</p>", "")).toBe(join(pageDir(id), "2-sales-q3.html"))
  expect(savePage(id, "<p>bare</p>", "")).toBe(join(pageDir(id), "3-page.html"))
  expect(listPages(id).map((p) => p.n)).toEqual([1, 2, 3])
  expect(slugOf("Čaj & káva: ráno")).toBe("čaj-káva-ráno")
})

test("in the TUI a finished page is the note saying what it is and where it was saved; /pages lists them", async () => {
  const reply = "A page for you:\n\n```html-view Bakery landing\n" + PAGE + "\n```\n\nThat is the landing page."
  t = await tui([{ chunks: [delta({ content: reply.slice(0, 40) }), delta({ content: reply.slice(40) })] }], { width: 140, height: 30 }, "", { store: true })
  await t.input.typeText("make a page")
  t.input.pressEnter()
  expect(await t.until("That is the landing page.")).toBe(true)
  const id = t.app.engine.sessionId!
  const saved = listPages(id)
  expect(saved).toHaveLength(1)
  expect(saved[0]!.name).toBe("1-bakery-landing.html")
  expect(readFileSync(saved[0]!.path, "utf8")).toBe(PAGE)
  // The note in its place, not the source; the markdown around it as before.
  expect(await t.until("This answer has a page: Bakery landing — saved to")).toBe(true)
  expect(t.frame()).toContain("A page for you:")
  expect(t.frame()).not.toContain("Fresh bread.")
  await t.input.typeText("/pages")
  t.input.pressEnter()
  expect(await t.until(`1  ${saved[0]!.path}`.slice(0, 60))).toBe(true)
  await t.input.typeText("/pages 2")
  t.input.pressEnter()
  expect(await t.until("no page 2 here")).toBe(true)
  expect(existsSync(saved[0]!.path)).toBe(true)
  // A terminal's own model is never told about pages.
  expect(JSON.stringify(t.fake.requests[0].messages[0])).not.toContain("html-view")
})

test("the old `prototypes: true` setting is dropped with a line saying so, never an error", () => {
  mkdirSync(paths.config, { recursive: true })
  const file = join(paths.config, "config.yaml")
  const before = existsSync(file) ? readFileSync(file, "utf8") : undefined
  writeFileSync(file, "prototypes: true\n")
  try {
    const loaded = loadConfig()
    expect(loaded.warnings.some((w) => w.includes("prototypes was removed"))).toBe(true)
    expect((loaded.config as Record<string, unknown>).prototypes).toBeUndefined()
  } finally {
    if (before === undefined) writeFileSync(file, "")
    else writeFileSync(file, before)
  }
})

// Spec 3.8.1: with nothing said, a model asked to "show" a chart wrote an HTML file and opened it
// with `show` — a card to open where the drawing was asked for. The block says which is for what.
test("the block says a page is for what is to be seen and a shown file for what has to run", async () => {
  const block = await Bun.file(new URL("../harness/prompts/blocks/html-pages.md", import.meta.url)).text()
  const bullets = block.split("\n").filter((line) => line.startsWith("- "))
  const seen = bullets.find((line) => line.includes("asks to see something in your answer"))
  expect(seen).toBeDefined()
  expect(seen).toContain("Do not write it to an HTML file and open that with `show`")
  const runs = bullets.find((line) => line.includes("a page cannot be interactive"))
  expect(runs).toBeDefined()
  expect(runs).toContain("a page in an answer cannot run anything")
  expect(runs).toContain("open that with `show`")
  // The static rule comes between the two: what a page is, then what follows from it.
  const order = [seen, bullets.find((line) => line.startsWith("- A page is static")), runs].map((line) => bullets.indexOf(line as string))
  expect(order).toEqual([...order].sort((a, b) => a - b))
})
