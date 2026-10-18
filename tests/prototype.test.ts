// Prototypes in the terminal (harness spec 1.1.0, blocks/prototypes.md): a completed
// `prototype-chat` / `prototype-page` fence is saved as a file under the state directory, the
// model's output as it is, and drawn as one line in its place; /prototype lists them. How the
// fence's info line is read is the conformance area `prototype` (tests/conformance.ts).
import { afterEach, expect, test } from "bun:test"
import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { paths } from "../src/config/paths.ts"
import { parseInfo, splitPrototypes, titleFor } from "../src/prototype/fence.ts"
import { listPrototypes, prototypeDir, savePrototype, slugOf } from "../src/prototype/store.ts"
import { delta } from "./fake-provider.ts"
import { tui } from "./tui/harness.tsx"

let t: Awaited<ReturnType<typeof tui>> | undefined
afterEach(() => t?.stop())

const PAGE = "<!doctype html>\n<title>Bakery</title>\n<p>Fresh bread.</p>"

test("the info line: the kind whatever its case, the title the rest of the line or the page's own", () => {
  expect(parseInfo("prototype-chat Monthly sales")).toEqual({ kind: "chat", title: "Monthly sales" })
  expect(parseInfo("Prototype-Page")).toEqual({ kind: "page", title: "" })
  expect(parseInfo("prototype")).toEqual({ kind: "chat", title: "" })
  expect(parseInfo("html")).toBeNull()
  expect(titleFor("<title>  <b>From</b>\n the page </title>", "")).toBe("From the page")
  expect(titleFor(PAGE, "Given")).toBe("Given")
  expect(titleFor("<p>none</p>", "")).toBe("")
})

test("a reply split: markdown as it is, a prototype fence closed or still streaming, other code blocks left alone", () => {
  const text = "Here:\n\n```prototype-page Bakery landing\n" + PAGE + "\n```\n\nAnd code:\n\n```js\nconsole.log(1)\n```\n\n```prototype-chat Chart\n<p>half"
  const segs = splitPrototypes(text)
  expect(segs.map((s) => s.kind)).toEqual(["text", "prototype", "text", "prototype"])
  expect(segs[1]).toMatchObject({ kind: "prototype", info: { kind: "page", title: "Bakery landing" }, code: PAGE, closed: true, start: 7 })
  expect(segs[2]).toEqual({ kind: "text", text: "\nAnd code:\n\n```js\nconsole.log(1)\n```\n" })
  expect(segs[3]).toMatchObject({ kind: "prototype", closed: false, code: "<p>half" })
  // A fence that is a longer run of backticks, or tildes, closes only with its own; `~~~` inside
  // a backtick fence is content.
  const tilde = splitPrototypes("~~~prototype\n```\nnot a fence\n```\n~~~\n")
  expect(tilde[0]).toMatchObject({ kind: "prototype", closed: true, code: "```\nnot a fence\n```" })
  expect(splitPrototypes("plain text, no fence")).toEqual([{ kind: "text", text: "plain text, no fence" }])
})

test("saved under the state directory, numbered, slugged from the title, 0600, once per content", () => {
  const id = "ses_proto_test"
  const path = savePrototype(id, PAGE, { kind: "page", title: "Bakery landing" })
  expect(path).toBe(join(prototypeDir(id), "1-bakery-landing.html"))
  expect(path.startsWith(join(paths.state, "prototypes"))).toBe(true)
  expect(readFileSync(path, "utf8")).toBe(PAGE)
  expect(statSync(path).mode & 0o777).toBe(0o600)
  // The same page again is the same file; a different one is the next number, named by its
  // own <title> when the fence gave none, by its kind when neither says.
  expect(savePrototype(id, PAGE, { kind: "page", title: "Bakery landing" })).toBe(path)
  expect(savePrototype(id, "<title>Sales: Q3</title><p>x</p>", { kind: "chat", title: "" })).toBe(join(prototypeDir(id), "2-sales-q3.html"))
  expect(savePrototype(id, "<p>bare</p>", { kind: "chat", title: "" })).toBe(join(prototypeDir(id), "3-chat.html"))
  expect(listPrototypes(id).map((p) => p.name)).toEqual(["1-bakery-landing.html", "2-sales-q3.html", "3-chat.html"])
  expect(slugOf("Čaj & káva: ráno", "chat")).toBe("čaj-káva-ráno")
})

test("in the TUI a completed prototype fence is one line saying where it was saved; /prototype lists them", async () => {
  const reply = "A page for you:\n\n```prototype-page Bakery landing\n" + PAGE + "\n```\n\nThat is the landing page."
  t = await tui([{ chunks: [delta({ content: reply.slice(0, 40) }), delta({ content: reply.slice(40) })] }], { width: 120, height: 30 }, "", { store: true })
  await t.input.typeText("make a page")
  t.input.pressEnter()
  expect(await t.until("That is the landing page.")).toBe(true)
  const id = t.app.engine.sessionId!
  const saved = listPrototypes(id)
  expect(saved).toHaveLength(1)
  expect(saved[0]!.name).toBe("1-bakery-landing.html")
  expect(readFileSync(saved[0]!.path, "utf8")).toBe(PAGE)
  // Drawn as the one line, not as the code block; the markdown around it as before.
  expect(await t.until("prototype · Bakery landing · saved to")).toBe(true)
  expect(t.frame()).toContain("A page for you:")
  expect(t.frame()).not.toContain("Fresh bread.")
  await t.input.typeText("/prototype")
  t.input.pressEnter()
  expect(await t.until(`1  ${saved[0]!.path}`.slice(0, 60))).toBe(true)
  await t.input.typeText("/prototype 2")
  t.input.pressEnter()
  expect(await t.until("no prototype 2 here")).toBe(true)
  expect(existsSync(saved[0]!.path)).toBe(true)
})
