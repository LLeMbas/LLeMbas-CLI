// Session titles: named from the first prompt at once, then by the model after the first reply.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../src/app.ts"
import type { AskReply } from "../src/bus/index.ts"
import { paths } from "../src/config/paths.ts"
import { Store } from "../src/session/store.ts"
import { cleanTitle, promptTitle } from "../src/session/title.ts"
import { delta, fakeProvider, usage, type Fake } from "./fake-provider.ts"

let fake: Fake | undefined
afterEach(() => fake?.stop())

function setup(script: Parameters<typeof fakeProvider>[0], config = "") {
  fake = fakeProvider(script)
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(
    join(paths.config, "connections.yaml"),
    `connections:\n  fake:\n    type: webui\n    url: ${fake.url}\n    models:\n      fake/m: { context: 32768 }\n      fake/tiny: { context: 8192 }\n`,
    { mode: 0o600 },
  )
  writeFileSync(join(paths.config, "config.yaml"), `model: fake/m\n${config}`)
  return mkdtempSync(join(tmpdir(), "lembas-title-"))
}

const noAsk = { ask: async (): Promise<AskReply> => ({ kind: "deny" }) }
const say = (text: string) => ({ chunks: [delta({ content: text }, "stop"), usage(10, 5)] })

async function until(f: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!f() && Date.now() < end) await Bun.sleep(10)
}

describe("titles from text", () => {
  test("a prompt's first readable line, cut at a word", () => {
    expect(promptTitle("\n\n## Fix the parser\nit breaks on tabs")).toBe("Fix the parser")
    expect(promptTitle("> quoted   with   spaces")).toBe("quoted with spaces")
    const long = promptTitle("word ".repeat(40))
    expect(long.length).toBeLessThanOrEqual(80)
    expect(long.endsWith("word…")).toBe(true)
    expect(promptTitle("   \n  ")).toBe("")
  })

  test("what models wrap a title in is taken off", () => {
    expect(cleanTitle('"Fixing the calc bug."')).toBe("Fixing the calc bug")
    expect(cleanTitle("Title: Parser tabs")).toBe("Parser tabs")
    expect(cleanTitle("**Title:** Parser tabs")).toBe("Parser tabs")
    expect(cleanTitle("<think>short</think>\n\n# Voice setup on the Pi\nmore")).toBe("Voice setup on the Pi")
    expect(cleanTitle("  \n ")).toBeUndefined()
  })
})

describe("a session gets a title", () => {
  test("from the prompt as it is sent, then from the model after the first reply", async () => {
    const dir = setup([say("The bug is in add()."), say("Fixing the calc bug")])
    const store = new Store(":memory:")
    const app = createApp({ cwd: dir, asker: noAsk, store, snapshots: false })
    const id = app.engine.sessionId!
    const titles: string[] = []
    app.bus.on((e) => e.type === "title" && titles.push(e.title))
    const running = app.engine.prompt("why does calc.py add wrong?\nhere is the traceback…")
    expect(store.session(id)!.title).toBe("why does calc.py add wrong?")
    expect(await running).toBe("stop")
    await until(() => store.session(id)!.title === "Fixing the calc bug")
    expect(store.session(id)!.title).toBe("Fixing the calc bug")
    expect(titles).toEqual(["why does calc.py add wrong?", "Fixing the calc bug"])
    // The title request: no tools, the first prompt and the first reply in it.
    const req = fake!.requests[1]
    expect(req.tools ?? []).toEqual([])
    expect(req.messages.at(-1).content).toContain("why does calc.py add wrong?")
    expect(req.messages.at(-1).content).toContain("The bug is in add().")
  })

  test("a command is named by what was typed, not by its expanded body", async () => {
    const dir = setup([say("Reviewed."), say("Session review")])
    const store = new Store(":memory:")
    const app = createApp({ cwd: dir, asker: noAsk, store, snapshots: false })
    const running = app.engine.prompt("You are reviewing a change. The diff:\n…", [], "/review head")
    expect(store.session(app.engine.sessionId!)!.title).toBe("/review head")
    await running
    await until(() => fake!.requests.length === 2)
    expect(fake!.requests[1].messages.at(-1).content).toContain("/review head")
  })

  test("titles: prompt makes no extra request; neither do later prompts", async () => {
    const dir = setup([say("one"), say("two")], "titles: prompt\n")
    const store = new Store(":memory:")
    const app = createApp({ cwd: dir, asker: noAsk, store, snapshots: false })
    await app.engine.prompt("first thing")
    await app.engine.prompt("second thing")
    await Bun.sleep(50)
    expect(fake!.requests).toHaveLength(2)
    expect(store.session(app.engine.sessionId!)!.title).toBe("first thing")
  })

  test("headless runs (modelTitles: false) are named from the prompt only", async () => {
    const dir = setup([say("ok")])
    const store = new Store(":memory:")
    const app = createApp({ cwd: dir, asker: noAsk, store, snapshots: false, modelTitles: false })
    await app.engine.prompt("tidy the imports")
    await Bun.sleep(50)
    expect(fake!.requests).toHaveLength(1)
    expect(store.session(app.engine.sessionId!)!.title).toBe("tidy the imports")
  })

  test("small_model writes the title when it is set", async () => {
    const dir = setup([say("answer"), say("Tiny title")], "small_model: fake/tiny\n")
    const store = new Store(":memory:")
    const app = createApp({ cwd: dir, asker: noAsk, store, snapshots: false })
    await app.engine.prompt("something")
    await until(() => store.session(app.engine.sessionId!)!.title === "Tiny title")
    expect(fake!.requests[0].model).toBe("fake/m")
    expect(fake!.requests[1].model).toBe("fake/tiny")
  })

  test("a failed title request leaves the prompt's title", async () => {
    const dir = setup([say("answer"), { status: 500, body: "nope" }])
    const store = new Store(":memory:")
    const app = createApp({ cwd: dir, asker: noAsk, store, snapshots: false })
    await app.engine.prompt("keep this name")
    await until(() => fake!.requests.length >= 2)
    await Bun.sleep(50)
    expect(store.session(app.engine.sessionId!)!.title).toBe("keep this name")
  })

  test("a session from before titles is named when resumed, and /new starts unnamed", async () => {
    const dir = setup([say("x"), say("Renamed by model")])
    const store = new Store(":memory:")
    const old = store.createSession(dir, "fake/m")
    store.append(old.id, { role: "user", parts: [{ type: "text", text: "the old question" }] })
    store.append(old.id, { role: "assistant", parts: [{ type: "text", text: "the old answer" }] })
    const app = createApp({ cwd: dir, asker: noAsk, store, snapshots: false })
    app.resume(old.id)
    expect(store.session(old.id)!.title).toBe("the old question")
    await app.engine.prompt("and another thing")
    await until(() => store.session(old.id)!.title === "Renamed by model")
    expect(store.session(old.id)!.title).toBe("Renamed by model")
    app.newSession()
    expect(store.session(app.engine.sessionId!)!.title).toBe("")
  })
})
