// `lembas run`: after the prompt the run waits for the jobs it started — their notes are turns of
// their own — then stops what is left; --no-wait stops them at once (the spec's lifecycle: nobody
// to ask). The terminal asker takes one question at a time.
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../src/app.ts"
import type { AskReply } from "../src/bus/index.ts"
import { paths } from "../src/config/paths.ts"
import { settleJobs, terminalAsker } from "../src/headless.ts"
import { MARKS } from "../src/jobs/note.ts"
import { delta, fakeProvider, toolCall, type Fake } from "./fake-provider.ts"

let fake: Fake | undefined
afterEach(() => fake?.stop())

function app(script: Parameters<typeof fakeProvider>[0]) {
  fake = fakeProvider(script)
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  f:\n    dialect: openai-chat\n    base_url: ${fake.url}\n    models: { m: {} }\n`, { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), "model: f/m\n")
  return createApp({ cwd: mkdtempSync(join(tmpdir(), "ph-hl-")), mode: "auto", store: false, snapshots: false, asker: { ask: async (): Promise<AskReply> => ({ kind: "once" }) } })
}

test("the run waits for the prompt's jobs and gets their notes as turns", async () => {
  const a = app([
    { chunks: [toolCall(0, "t1", "bash", JSON.stringify({ command: "sleep 0.4; echo late", background: true, description: "later" }))] },
    { chunks: [delta({ content: "Running." })] },
    { chunks: [delta({ content: "Seen late." })] },
  ])
  await a.turns.prompt("go")
  expect(fake!.requests.length).toBe(2)
  await settleJobs(a, true)
  expect(fake!.requests.length).toBe(3)
  expect(fake!.requests[2].messages.at(-1).content).toStartWith(MARKS.command)
  expect(a.registry.running(a.jobsSessionId())).toEqual([])
})

test("--no-wait stops what runs instead", async () => {
  const a = app([{ chunks: [toolCall(0, "t1", "bash", JSON.stringify({ command: "sleep 30", background: true, description: "server" }))] }, { chunks: [delta({ content: "Running." })] }])
  await a.turns.prompt("go")
  expect(a.registry.running(a.jobsSessionId())).toHaveLength(1)
  await settleJobs(a, false)
  const until = Date.now() + 3000
  while (Date.now() < until && a.registry.running(a.jobsSessionId()).length) await Bun.sleep(20)
  expect(a.registry.running(a.jobsSessionId())).toEqual([])
  expect(fake!.requests.length).toBe(2)
})

test("the terminal asker answers one question at a time", async () => {
  // --yes answers at once; the order of answers is the order of asks, not of whoever finished first.
  const asker = terminalAsker({ yes: true })
  const req = (n: string) => ({ tool: "bash", args: {}, request: { permission: "bash", class: "execute" as const, patterns: [n], command: n }, decision: { action: "ask" as const, reason: n, always: [] } })
  const order: string[] = []
  const a = asker.ask(req("one")).then((r) => (order.push("one"), r))
  const b = asker.ask(req("two")).then((r) => (order.push("two"), r))
  expect(await a).toEqual({ kind: "once" })
  expect(await b).toEqual({ kind: "once" })
  expect(order).toEqual(["one", "two"])
})
