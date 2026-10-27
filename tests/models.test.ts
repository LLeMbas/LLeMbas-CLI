// Other models: the list the model is given (with notes), a subagent on another model, and a
// fallback when a model's server cannot be reached at all.
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../src/app.ts"
import type { Event } from "../src/bus/index.ts"
import { paths } from "../src/config/paths.ts"
import { delta, fakeProvider, toolCall, type Fake } from "./fake-provider.ts"

let fake: Fake | undefined
afterEach(() => fake?.stop())

function setup(script: Parameters<typeof fakeProvider>[0], connections: (url: string) => string) {
  fake = fakeProvider(script)
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(join(paths.config, "connections.yaml"), connections(fake.url), { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), "model: f/main\ntitles: prompt\n")
  const app = createApp({ cwd: mkdtempSync(join(tmpdir(), "ph-models-")), store: false, snapshots: false, asker: { ask: async () => ({ kind: "once" }) } })
  const events: Event[] = []
  app.bus.on((e) => events.push(e))
  return { app, events }
}

const two = (url: string) =>
  `connections:\n  f:\n    type: webui\n    url: ${url}\n    models:\n      f/main: {}\n      f/big: { name: Big One, notes: slow but careful; best at reviews }\n`

test("the model is told which other models there are, with their notes", async () => {
  const { app } = setup([{ chunks: [delta({ content: "ok" }, "stop")] }], two)
  await app.engine.prompt("hi")
  const system = fake!.requests[0]!.messages[0].content as string
  expect(system).toContain("- f/big (Big One) — slow but careful; best at reviews")
  expect(system).not.toContain("- f/main")
})

test("task runs a subagent on the model asked for", async () => {
  const { app } = setup(
    [
      { chunks: [toolCall(0, "t1", "task", JSON.stringify({ description: "second opinion", prompt: "Is 2+2 4?", model: "f/big" }))] },
      { chunks: [delta({ content: "Yes." }, "stop")] },
      { chunks: [delta({ content: "Big says yes." }, "stop")] },
    ],
    two,
  )
  expect(await app.engine.prompt("ask the big one")).toBe("stop")
  expect(fake!.requests.map((r) => r.model)).toEqual(["f/main", "f/big", "f/main"])
  const result = app.engine.messages.find((m) => m.role === "tool")
  expect(result && result.role === "tool" && result.content).toContain("Yes.")
})

