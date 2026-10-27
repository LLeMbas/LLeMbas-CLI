// A message sent while the agent works: it goes in at the next step boundary — after every tool
// result of the step that was running, before the next request — and if the model had already
// finished, it carries on with it in the same task. Esc gives it back; busy_input: queue holds it
// for the task's end.
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../src/app.ts"
import type { AskReply, Event } from "../src/bus/index.ts"
import { paths } from "../src/config/paths.ts"
import type { Message } from "../src/provider/types.ts"
import { setTrust } from "../src/project/root.ts"
import { mergeUsers, STEER_MARK } from "../src/session/engine.ts"
import { delta, fakeProvider, toolCall, usage, type Fake } from "./fake-provider.ts"

let fake: Fake | undefined
afterEach(() => fake?.stop())

function setup(script: Parameters<typeof fakeProvider>[0], config = "") {
  fake = fakeProvider(script)
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(
    join(paths.config, "connections.yaml"),
    `connections:\n  f:\n    type: webui\n    url: ${fake.url}\n    models:\n      f/main: { context: 32768 }\n      f/a: {}\n`,
    { mode: 0o600 },
  )
  writeFileSync(join(paths.config, "config.yaml"), `model: f/main\ntitles: prompt\n${config}`)
  const cwd = mkdtempSync(join(tmpdir(), "ph-steer-"))
  Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd })
  writeFileSync(join(cwd, "a.txt"), "one\n")
  setTrust(cwd, "trusted")
  const app = createApp({ cwd, mode: "edit", asker: { ask: async (): Promise<AskReply> => ({ kind: "once" }) } })
  const events: Event[] = []
  app.bus.on((e) => events.push(e))
  return { app, events }
}

/** Send `text` once the first step's reply has started streaming. */
function sendDuringFirstStep(app: ReturnType<typeof setup>["app"], text: string) {
  let sent = false
  app.bus.on((e) => {
    if (!sent && (e.type === "text" || e.type === "tool_call_delta")) {
      sent = true
      expect(app.turns.steer(text)).toBe(true)
    }
  })
}

const lastUser = (msgs: { role: string; content: unknown }[]) => JSON.stringify(msgs.filter((m) => m.role === "user").at(-1)?.content)

test("sent during a tool step: after that step's tool results, before the next request", async () => {
  const { app, events } = setup([
    { gapMs: 150, chunks: [delta({ content: "Listing." }), toolCall(0, "c1", "list", "{}"), usage(10, 5)] },
    { chunks: [delta({ content: "Using b.txt then." }, "stop")] },
  ])
  sendDuringFirstStep(app, "actually call it b.txt")
  expect(await app.turns.prompt("make a file")).toBe("stop")
  const second = fake!.requests[1].messages as { role: string; content: unknown }[]
  // …, assistant (the call), tool (its result), user (the message): the pairing is intact.
  expect(second.slice(-3).map((m) => m.role)).toEqual(["assistant", "tool", "user"])
  expect(lastUser(second)).toContain("actually call it b.txt")
  expect(lastUser(second)).toContain(STEER_MARK)
  expect(events.filter((e) => e.type === "steered")).toHaveLength(1)
  // The waiting list was shown, then emptied when it went in.
  const inbox = events.filter((e) => e.type === "inbox").map((e) => (e.type === "inbox" ? e.texts.length : -1))
  expect(inbox).toEqual([1, 0])
  expect(app.turns.takeInbox()).toEqual([])
})

test("sent while the final answer streams: the model carries on with it in the same task", async () => {
  const { app } = setup([
    { gapMs: 150, chunks: [delta({ content: "All " }), delta({ content: "done." }, "stop")] },
    { chunks: [delta({ content: "Added the tests too." }, "stop")] },
  ])
  sendDuringFirstStep(app, "and add tests")
  expect(await app.turns.prompt("fix it")).toBe("stop")
  expect(fake!.requests).toHaveLength(2)
  const second = fake!.requests[1].messages as { role: string; content: unknown }[]
  expect(second.slice(-2).map((m) => m.role)).toEqual(["assistant", "user"])
  expect(lastUser(second)).toContain("and add tests")
  expect(app.engine.messages.at(-1)).toMatchObject({ role: "assistant" })
})

test("stopped before it went in: Esc gives it back, nothing reached the model", async () => {
  const { app } = setup([{ gapMs: 300, chunks: [delta({ content: "Working" }), delta({ content: " on it" }), delta({ content: "." }, "stop")] }])
  let sent = false
  app.bus.on((e) => {
    if (!sent && e.type === "text") {
      sent = true
      app.turns.steer("wait, not that")
      setTimeout(() => app.cancel(), 50)
    }
  })
  expect(await app.turns.prompt("do the thing")).toBe("cancelled")
  expect(fake!.requests).toHaveLength(1)
  expect(app.turns.takeInbox()).toEqual(["wait, not that"])
})

test("busy_input: queue — held for the end of the task, never sent mid-turn", async () => {
  const { app } = setup(
    [
      { gapMs: 150, chunks: [delta({ content: "Listing." }), toolCall(0, "c1", "list", "{}")] },
      { chunks: [delta({ content: "Done." }, "stop")] },
    ],
    "busy_input: queue\n",
  )
  sendDuringFirstStep(app, "next: the docs")
  expect(await app.turns.prompt("first: the code")).toBe("stop")
  expect(fake!.requests).toHaveLength(2)
  expect(JSON.stringify(fake!.requests[1].messages)).not.toContain("next: the docs")
  expect(app.turns.takeInbox()).toEqual(["next: the docs"])
})

test("no task running: steer says no, the caller sends a prompt instead", () => {
  const { app } = setup([])
  expect(app.turns.steer("hello")).toBe(false)
})

test("neighbouring user messages go to the model as one", () => {
  const m: Message[] = [
    { role: "user", parts: [{ type: "text", text: "a" }] },
    { role: "assistant", parts: [{ type: "text", text: "b" }] },
    { role: "user", parts: [{ type: "text", text: "c" }] },
    { role: "user", parts: [{ type: "text", text: "d" }] },
  ]
  const merged = mergeUsers(m)
  expect(merged).toHaveLength(3)
  expect(merged[2]).toEqual({ role: "user", parts: [{ type: "text", text: "c" }, { type: "text", text: "d" }] })
  // The stored conversation is not touched.
  expect(m).toHaveLength(4)
})

test("compacted in a later step: the message is kept word for word, like the prompt", async () => {
  // A 2000-token window and a step that reports 1900 used: the next step compacts.
  fake = undefined
  const { app } = setup([
    { gapMs: 150, chunks: [delta({ content: "Listing." }), toolCall(0, "c1", "list", "{}"), usage(1500, 10)] },
    { chunks: [toolCall(0, "c2", "list", "{}"), usage(1900, 10)] },
    { chunks: [delta({ content: "Summary: listed twice." }, "stop")] },
    { chunks: [delta({ content: "Done." }, "stop")] },
  ])
  app.engine.model.spec.context = 2000
  sendDuringFirstStep(app, "KEEP-THIS-INSTRUCTION")
  expect(await app.turns.prompt("list things")).toBe("stop")
  const last = JSON.stringify(fake!.requests.at(-1).messages)
  expect(last).toContain("compacted")
  expect(last).toContain("KEEP-THIS-INSTRUCTION")
})
