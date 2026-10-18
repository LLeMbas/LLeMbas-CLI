// Budgets for one prompt (harness spec loop.json, from LLeMbas's agent limits): past one, the
// tools are withdrawn and the model answers from what it has — checked between steps, never
// mid-reply, and with time spent waiting for the user not counted.
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../src/app.ts"
import type { AskReply, Event } from "../src/bus/index.ts"
import { paths } from "../src/config/paths.ts"
import { delta, fakeProvider, toolCall, usage, type Fake } from "./fake-provider.ts"

let fake: Fake | undefined
afterEach(() => fake?.stop())

function app(limits: string, script: Parameters<typeof fakeProvider>[0], ask: () => Promise<AskReply> = async () => ({ kind: "once" })) {
  fake = fakeProvider(script)
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  f:\n    dialect: openai-chat\n    base_url: ${fake.url}\n    models: { m: {} }\n`, { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), `model: f/m\ntitles: prompt\nlimits: { ${limits} }\n`)
  const cwd = mkdtempSync(join(tmpdir(), "ph-budget-"))
  writeFileSync(join(cwd, "big.txt"), "x".repeat(5000) + "\n")
  return createApp({ cwd, mode: "edit", store: false, snapshots: false, asker: { ask } })
}

const tools = (r: any) => (r.tools ?? []).map((t: any) => t.function.name)

test("past the output budget the tools are withdrawn, the model is told, and it answers", async () => {
  const a = app("output_bytes: 1000", [
    { chunks: [toolCall(0, "r1", "read", '{"path":"big.txt"}')] },
    { chunks: [delta({ content: "It is a file of x." }, "stop")] },
  ])
  const notices: string[] = []
  a.bus.on((e: Event) => e.type === "notice" && notices.push(e.message))
  expect(await a.engine.prompt("what is in big.txt?")).toBe("budget")
  expect(tools(fake!.requests[0])).toContain("read")
  expect(tools(fake!.requests[1])).toEqual([])
  expect(JSON.stringify(fake!.requests[1].messages.at(-1))).toContain("The tool output budget for this prompt has been reached")
  expect(notices.join("\n")).toContain("with too much tool output to read")
})

test("the token budget counts what the model wrote this prompt", async () => {
  const a = app("completion_tokens: 50", [
    { chunks: [toolCall(0, "r1", "read", '{"path":"big.txt"}'), usage(10, 80)] },
    { chunks: [delta({ content: "done" }, "stop")] },
  ])
  await a.engine.prompt("go")
  expect(tools(fake!.requests[1])).toEqual([])
})

test("time spent waiting for an approval is not spent from the wall-clock budget", async () => {
  // bash asks in edit mode; the user takes 1.5 s, the budget is 1 s, and the model still gets its tools.
  const a = app(
    "wall_seconds: 1",
    [{ chunks: [toolCall(0, "b1", "bash", '{"command":"echo hi"}')] }, { chunks: [toolCall(0, "r1", "read", '{"path":"big.txt"}')] }, { chunks: [delta({ content: "ok" }, "stop")] }],
    async () => (await Bun.sleep(1500), { kind: "once" }),
  )
  await a.engine.prompt("go")
  expect(tools(fake!.requests[1])).toContain("read")
  expect(tools(fake!.requests[2])).toContain("read")
})

test("no budget set: nothing is withdrawn", async () => {
  const a = app("steps: 200", [{ chunks: [toolCall(0, "r1", "read", '{"path":"big.txt"}')] }, { chunks: [delta({ content: "ok" }, "stop")] }])
  await a.engine.prompt("go")
  expect(tools(fake!.requests[1])).toContain("read")
})
