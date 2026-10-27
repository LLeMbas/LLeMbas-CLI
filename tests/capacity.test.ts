// The capacity rule (harness spec, after LLeMbas services/helpers.py): a subagent is not started
// where its server would unload the session's model, or push the session's cached prompt out.
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../src/app.ts"
import type { AskReply } from "../src/bus/index.ts"
import { paths } from "../src/config/paths.ts"
import type { ResolvedModel } from "../src/provider/types.ts"
import { capacityRefusal } from "../src/session/capacity.ts"
import { delta, fakeProvider, toolCall, type Fake } from "./fake-provider.ts"

let fake: Fake | undefined
afterEach(() => fake?.stop())

const model = (conn: string, id: string, o: { single?: boolean } = {}): ResolvedModel => ({
  ref: `${conn}/${id}`,
  connectionName: "ai",
  connection: { base_url: "http://x/v1", models: {} },
  id: `${conn}/${id}`,
  spec: o.single ? { single_session: true } : {},
})

test("a model's group (the server's capacity.group): another model of the same GPU is refused, the session's own is not", () => {
  const grouped = (id: string, group?: string): ResolvedModel => ({ ...model("ai", id), spec: group ? { group } : {} })
  const main = grouped("qwen", "gpu")
  expect(capacityRefusal(main, grouped("gemma", "gpu"))).toContain("holds one model at a time")
  // Another server behind the same connection, or a model with no group: free to run beside it.
  expect(capacityRefusal(main, grouped("big", "cloud"))).toBe("")
  expect(capacityRefusal(main, grouped("api"))).toBe("")
  expect(capacityRefusal(main, main)).toBe("")
})

test("one request at a time: the model cannot be its own subagent; another can", () => {
  const main = model("srv", "m", { single: true })
  expect(capacityRefusal(main, main)).toContain("serves one request at a time")
  expect(capacityRefusal(main, model("other", "n"))).toBe("")
})

test("task on a model the server cannot hold beside the session's is refused, and nothing runs", async () => {
  fake = fakeProvider([
    { chunks: [toolCall(0, "t1", "task", JSON.stringify({ description: "second opinion", prompt: "look at it", model: "f/other" }))] },
    { chunks: [delta({ content: "I will do it myself." })] },
  ])
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(
    join(paths.config, "connections.yaml"),
    `connections:\n  f:\n    type: webui\n    url: ${fake.url}\n    models: { f/m: { group: gpu }, f/other: { group: gpu } }\n`,
    { mode: 0o600 },
  )
  writeFileSync(join(paths.config, "config.yaml"), "model: f/m\n")
  const a = createApp({ cwd: mkdtempSync(join(tmpdir(), "ph-cap-")), mode: "edit", store: false, asker: { ask: async (): Promise<AskReply> => ({ kind: "once" }) } })
  await a.engine.prompt("get a second opinion")
  // Two requests: the session's, then its next step — never one for f/other.
  expect(fake.requests.map((r: any) => r.model)).toEqual(["f/m", "f/m"])
  const result = fake.requests[1].messages.at(-1).content as string
  expect(result).toContain("holds one model at a time")
  expect(result).toContain("Do this part yourself")
})
