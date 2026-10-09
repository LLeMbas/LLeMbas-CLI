// A command corrected on its approval card (after LLeMbas): what the user wrote is judged again —
// the hardline and a written deny hold for it — and the model is told that the line it wrote is
// not the one that ran.
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../src/app.ts"
import type { AskReply } from "../src/bus/index.ts"
import { paths } from "../src/config/paths.ts"
import { delta, fakeProvider, toolCall, type Fake } from "./fake-provider.ts"

let fake: Fake | undefined
afterEach(() => fake?.stop())

function app(edit: string, config = "") {
  fake = fakeProvider([{ chunks: [toolCall(0, "b1", "bash", '{"command":"echo one"}')] }, { chunks: [delta({ content: "ok" }, "stop")] }])
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  f:\n    dialect: openai-chat\n    base_url: ${fake.url}\n    models: { m: {} }\n`, { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), `model: f/m\ntitles: prompt\n${config}`)
  return createApp({ cwd: mkdtempSync(join(tmpdir(), "ph-approve-")), mode: "manual", store: false, snapshots: false, asker: { ask: async (): Promise<AskReply> => ({ kind: "once", command: edit }) } })
}
const result = () => fake!.requests[1].messages.at(-1).content as string

test("the edited command runs, and the result says so first", async () => {
  const a = app("echo two")
  await a.engine.prompt("go")
  expect(result()).toStartWith("The user changed the command before allowing it. What ran: echo two")
  expect(result()).toContain("two")
  expect(result()).not.toContain("one\n")
})

test("an edit onto the hardline is refused, and nothing runs", async () => {
  const a = app("rm -rf /")
  await a.engine.prompt("go")
  expect(result()).toContain("The user changed the command to `rm -rf /`, and that is refused")
})

test("an edit onto a written deny is refused, also behind a wrapper", async () => {
  const a = app("sudo -u x git push origin main", 'permission:\n  bash: { "git push *": deny }\n')
  await a.engine.prompt("go")
  expect(result()).toContain("and that is refused: denied by permission rules")
})

test("allowing the command as it was written is an ordinary allow", async () => {
  const a = app("echo one")
  await a.engine.prompt("go")
  expect(result()).not.toContain("The user changed the command")
})
