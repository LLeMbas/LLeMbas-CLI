// The prefix (harness spec 3.1.0, context.md §10): the system prompt and the tool list are made once
// per session and resent byte for byte; what changes during it goes as a note on the next user
// message; compaction asks for its summary as the next turn of the same conversation; every
// request's cached input tokens are kept. These drive the real engine against a scripted server.
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../src/app.ts"
import type { AskReply } from "../src/bus/index.ts"
import { paths } from "../src/config/paths.ts"
import { TOOL_SPECS } from "../src/harness.ts"
import { Store } from "../src/session/store.ts"
import { isNote, NOTE, noteFor, PREFIX_META, summaryOf, toldAt, type Kept } from "../src/session/prefix.ts"
import { delta, fakeProvider, toolCall, usage, type Fake } from "./fake-provider.ts"

let fake: Fake | undefined
afterEach(() => fake?.stop())

const once = { ask: async (): Promise<AskReply> => ({ kind: "once" }) }

function setup(script: Parameters<typeof fakeProvider>[0], extra = "") {
  fake = fakeProvider(script)
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  fake:\n    type: webui\n    url: ${fake.url}\n    models:\n      fake/m: { context: 32768 }\n      fake/n: { context: 32768 }\n`, { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), `model: fake/m\ntitles: prompt\n${extra}`)
  const dir = mkdtempSync(join(tmpdir(), "lembas-prefix-"))
  Bun.spawnSync(["git", "init", "-q", dir])
  writeFileSync(join(dir, "AGENTS.md"), "# Demo\nBuild with make.\n")
  return dir
}

const reply = (text: string) => ({ chunks: [delta({ content: text }, "stop")] })
const system = (i: number) => fake!.requests.at(i)!.messages[0].content as string
const lastUser = (i: number) => {
  const m = fake!.requests.at(i)!.messages
  return [...m].reverse().find((x: { role: string }) => x.role === "user").content as string
}
const names = (i: number) => (fake!.requests.at(i)!.tools as { function: { name: string } }[]).map((t) => t.function.name)

test("no clock in the prompt: two requests across a date change send the same system bytes, and the date goes as a note", async () => {
  const dir = setup([reply("one"), reply("two"), reply("three")])
  const app = createApp({ cwd: dir, asker: once, store: false, snapshots: false })
  let day = "2026-11-04"
  app.engine.o.today = () => day
  await app.engine.prompt("first")
  await app.engine.prompt("second")
  day = "2026-11-05"
  await app.engine.prompt("third")
  expect(system(0)).not.toContain("Today")
  expect(system(0)).not.toContain("2026-11-0")
  expect(system(1)).toBe(system(0))
  expect(system(2)).toBe(system(0))
  expect(fake!.requests[2].tools).toEqual(fake!.requests[0].tools)
  expect(lastUser(0)).toBe(`first\n${NOTE.open}\nToday is 2026-11-04.\n${NOTE.close}`)
  expect(lastUser(1)).toBe("second")
  expect(lastUser(2)).toBe(`third\n${NOTE.open}\nToday is 2026-11-05.\n${NOTE.close}`)
  // A note is part of its message from then on: the next request sends the first one as it was.
  expect(fake!.requests[2].messages[1].content).toBe(lastUser(0))
})

test("a tool step carries no note; the note waits for the next user message", async () => {
  const dir = setup([{ chunks: [toolCall(0, "c1", "read", '{"path":"AGENTS.md"}')] }, reply("read it"), reply("ok")])
  const app = createApp({ cwd: dir, asker: once, store: false, snapshots: false })
  let day = "2026-11-04"
  app.engine.o.today = () => day
  app.bus.on((e) => {
    // The clock passes midnight while the tool runs.
    if (e.type === "tool_start") day = "2026-11-05"
  })
  await app.engine.prompt("look")
  expect(fake!.requests[1].messages.at(-1).role).toBe("tool")
  expect(system(1)).toBe(system(0))
  await app.engine.prompt("and now")
  expect(lastUser(2)).toBe(`and now\n${NOTE.open}\nToday is 2026-11-05.\n${NOTE.close}`)
})

test("the person's changes come as one note in the spec's order; the model's own do not", async () => {
  const dir = setup([
    { chunks: [toolCall(0, "w1", "plan_write", JSON.stringify({ title: "Fix", phases: [{ title: "P", tasks: ["a"] }] }))] },
    { chunks: [toolCall(0, "e1", "edit", JSON.stringify({ path: "AGENTS.md", old: "Build with make.", new: "Build with make; test with make test." }))] },
    reply("done"),
    reply("ok"),
    reply("fine"),
  ])
  const app = createApp({ cwd: dir, asker: once, mode: "edit", store: false, snapshots: false })
  app.engine.o.today = () => "2026-11-05"
  // The model reads AGENTS.md before it may edit it: read-before-edit is the tool's rule.
  app.engine.o.toolCtx.readFiles.add(join(dir, "AGENTS.md"))
  await app.engine.prompt("plan and fix")
  // Its own plan and its own edit: their results told it.
  await app.engine.prompt("thanks")
  expect(lastUser(3)).toBe("thanks")
  // Between turns the person changes the mode, the plan, an instruction file, and the personality.
  app.engine.mode = "manual"
  app.engine.setPlan(null)
  writeFileSync(join(dir, "AGENTS.md"), "# Demo\nBuild with ninja.\n")
  app.settings.set("personality", "concise", "session")
  await app.engine.prompt("again")
  const note = lastUser(4).slice("again\n".length)
  expect(isNote(note)).toBe(true)
  const order = ["The permission mode is now manual:\nPermission mode: manual.", "The person changed the plan; it is now:\n(none)", `${join(dir, "AGENTS.md")} changed; it now reads:\n# Demo\nBuild with ninja.`, "The person chose a different personality:\nBe brief."]
  for (const line of order) expect(note).toContain(line)
  expect(order.map((l) => note.indexOf(l))).toEqual([...order.map((l) => note.indexOf(l))].sort((a, b) => a - b))
  expect(system(4)).toBe(system(0))
})

test("plan_submit is in the list in every mode, and answers its unavailable text outside plan mode", async () => {
  const dir = setup([{ chunks: [toolCall(0, "x1", "plan_submit", "{}")] }, reply("carrying on")])
  const app = createApp({ cwd: dir, asker: once, mode: "manual", store: false, snapshots: false })
  await app.engine.prompt("submit it")
  expect(names(0)).toContain("plan_submit")
  expect(fake!.requests[1].messages.at(-1).content).toBe(`[#0001]\n${TOOL_SPECS.plan_submit!.unavailable}`)
  // A terminal session can never show a file: show is not in its list at all.
  expect(names(0)).not.toContain("show")
})

test("compaction: the same system and tools, every message, then the compaction text; a call in the reply is not run, and the request is no turn", async () => {
  const dir = setup([
    reply("The answer is 42."),
    { chunks: [delta({ content: "## What we are doing\nFinding the answer." }), toolCall(0, "c1", "bash", '{"command":"rm -rf x","description":"x"}'), usage(900, 40)] },
    reply("ok"),
  ])
  const store = new Store(":memory:")
  const app = createApp({ cwd: dir, asker: { ask: async () => { throw new Error("nothing may ask") } }, store, snapshots: false })
  await app.engine.prompt("what is the answer")
  const sid = app.engine.sessionId!
  const summary = await app.engine.compact()
  const [first, compaction] = [fake!.requests[0], fake!.requests[1]]
  expect(compaction.messages[0]).toEqual(first.messages[0])
  expect(compaction.tools).toEqual(first.tools)
  expect(compaction.messages.slice(1, -1).map((m: { content: string }) => m.content)).toEqual([first.messages[1].content, "The answer is 42."])
  expect(compaction.messages.at(-1).content).toStartWith("Summarise the conversation")
  expect(compaction.messages.at(-1).content).not.toContain("User: what is the answer")
  // The text before the call is the summary; the call was not run.
  expect(summary).toStartWith("## What we are doing\nFinding the answer.")
  expect(store.messages(sid).map((m) => (m.role === "tool" ? "tool" : m.parts.map((p) => (p.type === "text" ? p.text : p.type)).join("|")))).not.toContainEqual(expect.stringContaining("Summarise"))
  expect(store.messages(sid).some((m) => m.role === "tool")).toBe(false)
  // Its usage is kept, as the compaction's.
  expect(store.requests(sid).map((r) => r.kind)).toEqual(["step", "compaction"])
  // After it the prompt is made again, and the next user message says the date again.
  await app.engine.prompt("go on")
  expect(lastUser(2)).toMatch(/^go on\n<session-note>\nToday is \d{4}-\d{2}-\d{2}\.\n<\/session-note>$/)
})

test("a resumed session sends the prompt it kept, byte for byte; what changed meanwhile is a note", async () => {
  const dir = setup([reply("one"), reply("two")])
  const store = new Store(":memory:")
  const a = createApp({ cwd: dir, asker: once, store, snapshots: false })
  await a.engine.prompt("first")
  const sid = a.engine.sessionId!
  const kept = store.meta<Kept>(sid, PREFIX_META)!
  expect(kept.system).toBe(system(0))
  await a.close()
  writeFileSync(join(dir, "AGENTS.md"), "# Demo\nBuild with ninja.\n")
  const b = createApp({ cwd: dir, asker: once, store, snapshots: false, resuming: sid })
  b.resume(sid)
  await b.engine.prompt("second")
  expect(system(1)).toBe(system(0))
  expect(system(1)).toContain("Build with make.")
  expect(lastUser(1)).toContain(`${join(dir, "AGENTS.md")} changed; it now reads:\n# Demo\nBuild with ninja.`)
  // Shown as typed: the note is not the person's words.
  expect(b.engine.messages.filter((m) => m.role === "user").length).toBe(2)
  await b.close()
})

test("a model switch makes the prompt again for the new model; the date already said holds", async () => {
  const dir = setup([reply("one"), reply("two")])
  const app = createApp({ cwd: dir, asker: once, store: false, snapshots: false })
  await app.engine.prompt("first")
  app.switchModel("fake/n")
  await app.engine.prompt("second")
  expect(system(0)).toContain("Model: fake/m")
  expect(system(1)).toContain("Model: fake/n")
  expect(lastUser(1)).toBe("second")
})

test("cached input tokens are kept with every request's usage and shown by /context", async () => {
  const dir = setup([
    { chunks: [delta({ content: "one" }), { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } } }] },
    // llama.cpp says it in its timings when the usage does not.
    { chunks: [delta({ content: "two" }), usage(1100, 5), { choices: [], timings: { cache_n: 1000, prompt_n: 100, predicted_n: 5 } }] },
  ])
  const store = new Store(":memory:")
  const app = createApp({ cwd: dir, asker: once, store, snapshots: false })
  await app.engine.prompt("first")
  await app.engine.prompt("second")
  expect(store.requests(app.engine.sessionId!).map((r) => [r.kind, r.input, r.cached])).toEqual([
    ["step", 1000, 0],
    ["step", 1100, 1000],
  ])
  const { contextBreakdown, renderBreakdown } = await import("../src/session/context.ts")
  expect(renderBreakdown(contextBreakdown(app.engine, app.engine.systemPrompt(), [], undefined, app.engine.o.tools))).toContain("last request: 1.1k in, 1.0k of it cached (91%)")
  await app.close()
})

test("noteFor: nothing changed says nothing; an MCP server that connected later is said by its own instructions", () => {
  const now = { date: "2026-11-05", mode: "manual" as const, plan: "", memory: "", personality: "", files: {}, mcp: { docs: "Search the docs." } }
  const told = { ...toldAt(now), date: "2026-11-05" }
  expect(noteFor(told, now, () => "").note).toBe("")
  const later = { ...now, mcp: { ...now.mcp, tickets: "Name the ticket." } }
  expect(noteFor(told, later, () => "").note).toBe(`${NOTE.open}\nInstructions from an MCP server that connected since the session began:\n<server name="tickets">\nName the ticket.\n</server>\n${NOTE.close}`)
  expect(summaryOf([{ type: "reasoning", text: "x" }, { type: "text", text: " S " }, { type: "tool_call" }, { type: "text", text: "after" }])).toBe("S")
})

test("the first request waits for the configured MCP servers (up to loop.json's mcp_wait_ms): their tools and instructions are in the first list and prompt", async () => {
  const BUN = process.execPath
  const SERVER = join(import.meta.dir, "fixtures", "mcp", "server.ts")
  const dir = setup([reply("one")], `mcp:\n  fix:\n    command: ["${BUN}", "${SERVER}"]\n`)
  const app = createApp({ cwd: dir, asker: once, store: false, snapshots: false })
  // Not waiting for app.mcpReady here: the engine does, before it makes the prompt.
  await app.engine.prompt("first")
  expect(names(0)).toContain("mcp__fix__echo")
  expect(system(0)).toContain("<mcp_instructions>")
  await app.close()
  writeFileSync(join(paths.config, "config.yaml"), "")
})

test("an empty value in a note reads loop.json's context.note.empty", () => {
  const now = { date: "2026-11-05", mode: "manual" as const, plan: "", memory: "", personality: "", files: {}, mcp: {} }
  const told = { ...toldAt({ ...now, memory: "Prefers tabs." }), date: "2026-11-05" }
  expect(noteFor(told, now, () => "").note).toBe(`${NOTE.open}\nThe person changed what is remembered; it is now:\n${NOTE.empty}\n${NOTE.close}`)
})

test("compaction's ask has no previous summary and no transcript heading", async () => {
  const { compactAsk } = await import("../src/session/prefix.ts")
  const ask = compactAsk()
  expect(ask).not.toContain("## Transcript")
  expect(ask).not.toContain("Summary of even earlier turns")
  expect(ask).not.toMatch(/\n{3,}/)
  expect(ask).toEndWith("stay under 600 words.")
})
