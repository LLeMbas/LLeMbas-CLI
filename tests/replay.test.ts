// Streams recorded from real llama-swap models (LEMBAS_RECORD), host detail removed.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../src/app.ts"
import type { AskReply, Event } from "../src/bus/index.ts"
import { paths } from "../src/config/paths.ts"
import { SwapBanner } from "../src/provider/common.ts"
import { OpenAIChatClient } from "../src/provider/openai-chat.ts"
import type { ResolvedModel, StreamEvent } from "../src/provider/types.ts"
import { absPath, type ToolContext } from "../src/tool/tool.ts"
import { delta, fakeProvider, type Fake } from "./fake-provider.ts"

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures/sse", name), "utf8")
let fake: Fake | undefined
afterEach(() => fake?.stop())

async function replay(name: string) {
  fake = fakeProvider([{ chunks: [], raw: fixture(name) }])
  const m: ResolvedModel = { ref: "swap/x", connectionName: "swap", id: "x", spec: {}, connection: { dialect: "openai-chat", base_url: fake.url, models: {} } }
  const events: StreamEvent[] = []
  for await (const e of new OpenAIChatClient(m).stream({ system: "", messages: [{ role: "user", parts: [{ type: "text", text: "x" }] }], tools: [] }))
    events.push(e)
  return events
}

describe("recorded llama-swap streams", () => {
  test("qwen35: the loading banner becomes a notice, not reasoning; the tool call survives '{' + '}' fragments", async () => {
    const ev = await replay("qwen35-first-turn-with-swap-banner.sse")
    const notice = ev.find((e) => e.type === "notice")
    expect(notice?.type === "notice" && notice.message).toMatch(/^llama-swap loading model: qwen35 — done! \(\d+\.\d+s\)$/)
    const reasoning = ev.filter((e) => e.type === "reasoning").map((e) => (e.type === "reasoning" ? e.text : "")).join("")
    expect(reasoning).not.toContain("━")
    expect(reasoning).not.toContain("llama-swap")
    const fin = ev.find((e) => e.type === "finish")!
    expect(fin.type === "finish" && fin.message.parts.at(-1)).toMatchObject({ type: "tool_call", name: "list", args: "{}" })
  })

  test("gpt-oss: reasoning_content and real usage", async () => {
    const ev = await replay("gpt-oss-first-turn.sse")
    expect(ev.some((e) => e.type === "reasoning")).toBe(true)
    const u = ev.find((e) => e.type === "usage")
    expect(u?.type === "usage" && u.usage.estimated).toBeUndefined()
    expect(u?.type === "usage" && u.usage.input).toBeGreaterThan(1000)
  })

  test("qwen35: an answer given only inside reasoning is followed by one request for the answer", async () => {
    fake = fakeProvider([{ chunks: [], raw: fixture("qwen35-answer-only-in-reasoning.sse") }, { chunks: [delta({ content: "The divisor was off by one." })] }])
    mkdirSync(paths.config, { recursive: true })
    writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  f:\n    dialect: openai-chat\n    base_url: ${fake.url}\n    models: { m: {} }\n`, { mode: 0o600 })
    writeFileSync(join(paths.config, "config.yaml"), "model: f/m\n")
    const dir = mkdtempSync(join(tmpdir(), "lembas-replay-"))
    const app = createApp({ cwd: dir, mode: "edit", store: false, asker: { ask: async (): Promise<AskReply> => ({ kind: "deny" }) } })
    const texts: string[] = []
    app.bus.on((e: Event) => e.type === "text" && texts.push(e.text))
    expect(await app.engine.prompt("go")).toBe("stop")
    expect(fake.requests).toHaveLength(2)
    expect(fake.requests[1].messages.at(-1).content).toContain("only thinking and no answer")
    expect(texts.join("")).toBe("The divisor was off by one.")
  })
})

describe("SwapBanner", () => {
  test("text that does not start with the fence passes straight through", () => {
    const b = new SwapBanner()
    expect(b.feed("Let me think")).toEqual({ text: "Let me think" })
    expect(b.feed("━━━━━ later")).toEqual({ text: "━━━━━ later" })
  })
  test("a banner split across chunks", () => {
    const b = new SwapBanner()
    expect(b.feed("━━")).toEqual({ text: "" })
    expect(b.feed("━━━\nllama-swap loading model: m\n")).toEqual({ text: "" })
    expect(b.feed("Done! (1.00s)\n━━━━━\n \nthinking")).toEqual({ text: "thinking", notice: "llama-swap loading model: m — done! (1.00s)" })
  })
})

describe("paths", () => {
  test("a dropped leading slash is recovered inside the project only", () => {
    const root = mkdtempSync(join(tmpdir(), "lembas-abs-"))
    writeFileSync(join(root, "a.py"), "")
    const ctx = { root, cwd: root } as ToolContext
    expect(absPath(join(root, "a.py").slice(1), ctx)).toBe(join(root, "a.py"))
    expect(absPath("etc/hostname", ctx)).toBe(join(root, "etc/hostname"))
  })
})

describe("effort refused inside a 200 stream (llama-swap loading, then the template raises)", () => {
  test("the error: line is seen, the effort learned from it, and the request retried without it", async () => {
    const { learned, resetLearned } = await import("../src/provider/learned.ts")
    resetLearned()
    fake = fakeProvider([{ chunks: [], raw: fixture("bonsai-effort-refused-in-stream.sse") }, { chunks: [delta({ content: "ok" })] }])
    const m: ResolvedModel = {
      ref: "swap/bonsai-replay",
      connectionName: "swap",
      id: "bonsai",
      spec: { efforts: ["low", "medium", "high"] },
      connection: { dialect: "openai-chat", base_url: fake.url, models: {} },
    }
    const events: StreamEvent[] = []
    for await (const e of new OpenAIChatClient(m).stream({ system: "", messages: [{ role: "user", parts: [{ type: "text", text: "x" }] }], tools: [], effort: "high" }))
      events.push(e)
    const notices = events.filter((e) => e.type === "notice").map((e) => (e.type === "notice" ? e.message : ""))
    expect(notices[0]).toMatch(/^llama-swap loading model: bonsai/)
    expect(notices[1]).toContain('refused effort "high"')
    expect(fake.requests[1].reasoning_effort).toBeUndefined()
    expect(learned().efforts["swap/bonsai-replay"]).toEqual(["low", "medium", "xhigh"])
    const fin = events.find((e) => e.type === "finish")
    expect(fin?.type === "finish" && fin.message.parts).toEqual([{ type: "text", text: "ok" }])
  })

  test("an error after output has started is not retried", async () => {
    fake = fakeProvider([{ chunks: [], raw: 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\nerror: {"error":{"code":500,"message":"Unexpected reasoning effort high"}}\n\n' }])
    const m: ResolvedModel = { ref: "swap/late", connectionName: "swap", id: "x", spec: { efforts: ["high"] }, connection: { dialect: "openai-chat", base_url: fake.url, models: {} } }
    const run = async () => {
      for await (const _ of new OpenAIChatClient(m).stream({ system: "", messages: [], tools: [], effort: "high" })) void _
    }
    await expect(run()).rejects.toThrow("Unexpected reasoning effort")
    expect(fake.requests).toHaveLength(1)
  })
})

describe("llama-swap unloads the model under a running request", () => {
  test("'group: model unloaded' (a string code) is a server error: retried once, and the reply arrives", async () => {
    fake = fakeProvider([{ chunks: [], raw: fixture("llama-swap-model-unloaded.sse") }, { chunks: [delta({ content: "second try" })] }])
    const m: ResolvedModel = { ref: "swap/x", connectionName: "swap", id: "x", spec: {}, connection: { dialect: "openai-chat", base_url: fake.url, models: {} } }
    const events: StreamEvent[] = []
    for await (const e of new OpenAIChatClient(m).stream({ system: "", messages: [{ role: "user", parts: [{ type: "text", text: "x" }] }], tools: [] })) events.push(e)
    expect(events.some((e) => e.type === "notice" && e.message.includes("group: model unloaded"))).toBe(true)
    const fin = events.find((e) => e.type === "finish")
    expect(fin?.type === "finish" && fin.message.parts).toEqual([{ type: "text", text: "second try" }])
  })
})
