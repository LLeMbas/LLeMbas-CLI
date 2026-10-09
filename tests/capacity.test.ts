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

const model = (conn: string, id: string, o: { one?: boolean; single?: boolean } = {}): ResolvedModel => ({
  ref: `${conn}/${id}`,
  connectionName: conn,
  connection: { dialect: "openai-chat", base_url: "http://x/v1", models: {}, ...(o.one ? { one_model_at_a_time: true } : {}) } as ResolvedModel["connection"],
  id,
  spec: o.single ? { single_session: true } : {},
})

test("one model at a time: another model of the same server is refused, the session's own is not", () => {
  const main = model("swap", "qwen", { one: true })
  expect(capacityRefusal(main, model("swap", "gemma", { one: true }))).toContain("holds one model at a time")
  expect(capacityRefusal(main, main)).toBe("")
  expect(capacityRefusal(main, model("cloud", "big"))).toBe("")
  // Without the flag, as before.
  expect(capacityRefusal(model("swap", "qwen"), model("swap", "gemma"))).toBe("")
})

test("a model's group: models one connection serves from several servers are told apart", () => {
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
    `connections:\n  f:\n    dialect: openai-chat\n    base_url: ${fake.url}\n    one_model_at_a_time: true\n    models: { m: {}, other: {} }\n`,
    { mode: 0o600 },
  )
  writeFileSync(join(paths.config, "config.yaml"), "model: f/m\n")
  const a = createApp({ cwd: mkdtempSync(join(tmpdir(), "ph-cap-")), mode: "edit", store: false, asker: { ask: async (): Promise<AskReply> => ({ kind: "once" }) } })
  await a.engine.prompt("get a second opinion")
  // Two requests: the session's, then its next step — never one for f/other.
  expect(fake.requests.map((r: any) => r.model)).toEqual(["m", "m"])
  const result = fake.requests[1].messages.at(-1).content as string
  expect(result).toContain("holds one model at a time")
  expect(result).toContain("Do this part yourself")
})
