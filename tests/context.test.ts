import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../src/app.ts"
import type { AskReply, Event } from "../src/bus/index.ts"
import { paths } from "../src/config/paths.ts"
import { discoverContext } from "../src/provider/discover.ts"
import { resetLearned } from "../src/provider/learned.ts"
import { OpenAIChatClient } from "../src/provider/openai-chat.ts"
import type { ResolvedModel } from "../src/provider/types.ts"
import { contextBreakdown, renderBreakdown } from "../src/session/context.ts"
import { delta, fakeProvider, toolCall, usage, type Fake } from "./fake-provider.ts"

let fake: Fake | undefined
afterEach(() => {
  fake?.stop()
  resetLearned()
})

const rm = (url: string, id: string): ResolvedModel => ({ ref: `c/${id}`, connectionName: "c", id, spec: {}, connection: { dialect: "openai-chat", base_url: url, models: {} } })

function app(yaml: string, script: Parameters<typeof fakeProvider>[0], config = "") {
  fake = fakeProvider(script)
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(join(paths.config, "connections.yaml"), yaml.replaceAll("URL", fake.url), { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), `model: f/m\n${config}`)
  const cwd = mkdtempSync(join(tmpdir(), "ph-ctx-"))
  writeFileSync(join(cwd, "big.txt"), "x".repeat(6000))
  return createApp({ cwd, mode: "edit", store: false, asker: { ask: async (): Promise<AskReply> => ({ kind: "once" }) } })
}

describe("context", () => {
  test("discovery: the model list first, then llama-server /props through llama-swap's passthrough", async () => {
    fake = fakeProvider([])
    expect(await discoverContext(rm(fake.url, "m1"), new OpenAIChatClient(rm(fake.url, "m1")))).toBe(32768)
    expect(await discoverContext(rm(fake.url, "swapped"), new OpenAIChatClient(rm(fake.url, "swapped")))).toBe(16384)
    expect(fake.calls.map((c) => c.path)).toContain("/upstream/swapped/props")
  })

  test("switching to another connection calls the old one's unload_url", async () => {
    const a = app(`connections:\n  f:\n    dialect: openai-chat\n    base_url: URL\n    unload_url: URL/../unload\n    unload_method: GET\n    models: { m: {} }\n  g:\n    dialect: openai-chat\n    base_url: URL\n    models: { n: {} }\n`, [])
    a.switchModel("g/n")
    await Bun.sleep(100)
    expect(fake!.calls.some((c) => c.path.endsWith("/unload"))).toBe(true)
  })

  test("past auto_at: the older of two large outputs is pruned, the recent one kept, no compaction", async () => {
    // window 16000, auto_at 0.6 → limit 9600; the most recent 30% (4800 tokens) is protected.
    const a = app(`connections:\n  f:\n    dialect: openai-chat\n    base_url: URL\n    models: { m: { context: 16000 } }\n`, [
      { chunks: [toolCall(0, "c1", "read", '{"path":"big.txt"}'), usage(1000, 10)] },
      { chunks: [toolCall(0, "c2", "read", '{"path":"big2.txt"}'), usage(6600, 10)] },
      { chunks: [delta({ content: "done" }), usage(7000, 5)] },
    ], "compaction: { auto_at: 0.6 }\n")
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i} of a long file`).join("\n")
    writeFileSync(join(a.project.root, "big.txt"), lines)
    writeFileSync(join(a.project.root, "big2.txt"), lines)
    const notices: string[] = []
    a.bus.on((e: Event) => e.type === "notice" && notices.push(e.message))
    await a.engine.prompt("go")
    expect(notices.some((n) => n.includes("pruned old tool outputs"))).toBe(true)
    expect(notices.some((n) => n.includes("compacting"))).toBe(false)
    const results = fake!.requests.at(-1).messages.filter((m: any) => m.role === "tool").map((m: any) => m.content as string)
    expect(results[0]).toContain("removed to save context")
    expect(results[1]).toContain("line 999 of a long file")
  })

  test("still too full after pruning: compacted mid-task, then told to carry on", async () => {
    const a = app(`connections:\n  f:\n    dialect: openai-chat\n    base_url: URL\n    models: { m: { context: 4000 } }\n`, [
      { chunks: [delta({ content: "y".repeat(8000) }), toolCall(0, "c1", "list", "{}"), usage(3900, 2000)] },
      { chunks: [delta({ content: "## What we are doing\nA long task." })] },
      { chunks: [delta({ content: "carried on" }), usage(500, 5)] },
    ], "compaction: { auto_at: 0.8 }\n")
    const notices: string[] = []
    a.bus.on((e: Event) => e.type === "notice" && notices.push(e.message))
    await a.engine.prompt("go")
    expect(notices.some((n) => n.includes("compacting the conversation"))).toBe(true)
    expect(fake!.requests[1].messages[0].content).toContain("## Transcript")
    const last = fake!.requests[2].messages
    expect(JSON.stringify(last[1])).toContain("A long task.")
    // the original request comes back verbatim, with the note
    expect(last.at(-1).content).toStartWith("go\n(The conversation was compacted")
    expect(last.at(-1).content).toContain("This was the request")
  })

  test("/context: parts of the system prompt, tools, the conversation, against the window", async () => {
    const a = app(`connections:\n  f:\n    dialect: openai-chat\n    base_url: URL\n    models: { m: { context: 32768 } }\n`, [{ chunks: [toolCall(0, "c1", "read", '{"path":"big.txt"}'), usage(1500, 20)] }, { chunks: [delta({ content: "ok" }), usage(3100, 5)] }])
    await a.engine.prompt("read it")
    const system = a.engine.o.system(a.engine.mode, a.engine.model)
    const text = renderBreakdown(contextBreakdown(a.engine, system, [], undefined, a.engine.o.tools))
    expect(text).toContain("window 32.8k")
    expect(text).toContain("system prompt")
    expect(text).toMatch(/tool definitions \(\d+\)/)
    expect(text).toMatch(/tool results\s+503/) // one 6000-character line, cut at 2000 by read
    expect(text).toMatch(/in use\s+3\.1k/)
  })
})
