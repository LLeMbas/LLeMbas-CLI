import { afterEach, describe, expect, test } from "bun:test"
import type { Connection } from "../src/config/schema.ts"
import { learned, resetLearned } from "../src/provider/learned.ts"
import { OpenAIChatClient, contextFrom } from "../src/provider/openai-chat.ts"
import type { ResolvedModel, StreamEvent } from "../src/provider/types.ts"
import { delta, fakeProvider, toolCall, usage, type Fake } from "./fake-provider.ts"

let fake: Fake | undefined
afterEach(() => {
  fake?.stop()
  fake = undefined
  resetLearned()
})

function model(url: string, spec: ResolvedModel["spec"] = {}, conn: Partial<Connection> = {}): ResolvedModel {
  const connection: Connection = { base_url: url, models: { m: spec }, ...conn }
  return { ref: `c${Math.random().toString(36).slice(2, 7)}/m`, connectionName: "c", connection, id: "m", spec }
}

async function collect(client: OpenAIChatClient, effort: any = null) {
  const events: StreamEvent[] = []
  for await (const e of client.stream({ system: "sys", messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }], tools: [], effort }))
    events.push(e)
  return events
}

describe("openai-chat streaming", () => {
  test("text, reasoning_content, usage", async () => {
    fake = fakeProvider([{ chunks: [delta({ reasoning_content: "hmm" }), delta({ content: "Hel" }), delta({ content: "lo" }, "stop"), usage(10, 3)] }])
    const ev = await collect(new OpenAIChatClient(model(fake.url)))
    const fin = ev.find((e) => e.type === "finish")!
    expect(fin.type === "finish" && fin.message.parts).toEqual([
      { type: "reasoning", text: "hmm" },
      { type: "text", text: "Hello" },
    ])
    expect(ev.find((e) => e.type === "usage")).toEqual({ type: "usage", usage: { input: 10, output: 3, reasoning: undefined, cached: undefined } })
    expect(fake.requests[0].stream_options).toEqual({ include_usage: true })
    expect(fake.requests[0].messages[0]).toEqual({ role: "system", content: "sys" })
  })

  test("inline <think> tags split across chunks", async () => {
    fake = fakeProvider([{ chunks: [delta({ content: "<thi" }), delta({ content: "nk>plan</th" }), delta({ content: "ink>answer" })] }])
    const ev = await collect(new OpenAIChatClient(model(fake.url)))
    const fin = ev.find((e) => e.type === "finish")!
    expect(fin.type === "finish" && fin.message.parts).toEqual([
      { type: "reasoning", text: "plan" },
      { type: "text", text: "answer" },
    ])
  })

  test("tool calls: no index, id only on first fragment, object arguments, finish says stop", async () => {
    fake = fakeProvider([
      {
        chunks: [
          toolCall(undefined, "a", "read", '{"pa'),
          toolCall(undefined, undefined, undefined, 'th":"x"}'),
          toolCall(1, "b", "glob", { pattern: "*.ts" }),
          delta({}, "stop"),
        ],
      },
    ])
    const ev = await collect(new OpenAIChatClient(model(fake.url)))
    const fin = ev.find((e) => e.type === "finish")!
    expect(fin.type === "finish" && fin.reason).toBe("tool_calls")
    expect(fin.type === "finish" && fin.message.parts).toEqual([
      { type: "tool_call", id: "a", name: "read", args: '{"path":"x"}' },
      { type: "tool_call", id: "b", name: "glob", args: '{"pattern":"*.ts"}' },
    ])
  })

  test("no usage reported → estimated", async () => {
    fake = fakeProvider([{ chunks: [delta({ content: "abcdefgh" })] }])
    const ev = await collect(new OpenAIChatClient(model(fake.url)))
    const u = ev.find((e) => e.type === "usage")
    expect(u?.type === "usage" && u.usage.estimated).toBe(true)
    expect(u?.type === "usage" && u.usage.output).toBe(2)
  })

  test("stream_options refused with 400 → retried without, and remembered", async () => {
    fake = fakeProvider([{ status: 400, body: '{"error":{"message":"unknown field stream_options"}}' }, { chunks: [delta({ content: "ok" })] }, { chunks: [delta({ content: "ok" })] }])
    const m = model(fake.url)
    await collect(new OpenAIChatClient(m))
    expect(fake.requests[0].stream_options).toBeDefined()
    expect(fake.requests[1].stream_options).toBeUndefined()
    expect(learned().noStreamOptions).toContain(fake.url)
    await collect(new OpenAIChatClient(m))
    expect(fake.requests[2].stream_options).toBeUndefined()
  })

  test("prompt progress: asked for, and llama.cpp's prompt_progress chunks come out as progress events", async () => {
    const pp = (total: number, cache: number, processed: number, time_ms: number) => ({ choices: [{ index: 0, delta: { role: "assistant", content: null }, finish_reason: null }], prompt_progress: { total, cache, processed, time_ms } })
    fake = fakeProvider([{ chunks: [pp(8000, 3000, 0, 0), pp(8000, 3000, 2048, 3600), pp(8000, 3000, 5000, 8000), delta({ content: "ok" }), usage(8000, 1)] }])
    const ev = await collect(new OpenAIChatClient(model(fake.url)))
    expect(fake.requests[0].return_progress).toBe(true)
    expect(ev.filter((e) => e.type === "progress")).toEqual([
      { type: "progress", total: 8000, cache: 3000, processed: 0, ms: 0 },
      { type: "progress", total: 8000, cache: 3000, processed: 2048, ms: 3600 },
      { type: "progress", total: 8000, cache: 3000, processed: 5000, ms: 8000 },
    ])
    const fin = ev.find((e) => e.type === "finish")!
    expect(fin.type === "finish" && fin.message.parts).toEqual([{ type: "text", text: "ok" }])
  })

  test("a server that ignores return_progress, or sends something else under that name: nothing breaks", async () => {
    fake = fakeProvider([{ chunks: [{ choices: [{ index: 0, delta: {}, finish_reason: null }], prompt_progress: "soon" }, { choices: [], prompt_progress: { total: 0 } }, delta({ content: "ok" })] }])
    const ev = await collect(new OpenAIChatClient(model(fake.url)))
    expect(ev.filter((e) => e.type === "progress")).toEqual([])
    expect(ev.find((e) => e.type === "finish")).toBeDefined()
  })

  test("return_progress refused with a 400 naming it → retried without, and remembered", async () => {
    fake = fakeProvider([{ status: 400, body: '{"error":{"message":"Unrecognized request argument supplied: return_progress"}}' }, { chunks: [delta({ content: "ok" })] }, { chunks: [delta({ content: "ok" })] }])
    const m = model(fake.url)
    await collect(new OpenAIChatClient(m))
    expect(fake.requests[0].return_progress).toBe(true)
    expect(fake.requests[1].return_progress).toBeUndefined()
    expect(fake.requests[1].stream_options).toBeDefined()
    expect(learned().noProgress).toContain(fake.url)
    await collect(new OpenAIChatClient(m))
    expect(fake.requests[2].return_progress).toBeUndefined()
  })

  test("a 400 that is not about it: progress dropped for that one request, not remembered", async () => {
    fake = fakeProvider([{ status: 400, body: '{"error":{"message":"the prompt is too long"}}' }, { status: 400, body: '{"error":{"message":"the prompt is too long"}}' }, { status: 400, body: '{"error":{"message":"the prompt is too long"}}' }])
    await expect(collect(new OpenAIChatClient(model(fake.url)))).rejects.toThrow("too long")
    expect(learned().noProgress).not.toContain(fake.url)
  })

  test("quirks.prompt_progress: off never asks", async () => {
    fake = fakeProvider([{ chunks: [delta({ content: "ok" })] }])
    await collect(new OpenAIChatClient(model(fake.url, {}, { quirks: { prompt_progress: "off" } })))
    expect(fake.requests[0].return_progress).toBeUndefined()
  })

  test("effort sent top-level and in chat_template_kwargs", async () => {
    fake = fakeProvider([{ chunks: [delta({ content: "ok" })] }])
    await collect(new OpenAIChatClient(model(fake.url, { efforts: ["low", "high"] })), "high")
    expect(fake.requests[0].reasoning_effort).toBe("high")
    expect(fake.requests[0].chat_template_kwargs).toEqual({ reasoning_effort: "high" })
  })

  test("effort outside the vocabulary is not sent", async () => {
    fake = fakeProvider([{ chunks: [delta({ content: "ok" })] }])
    await collect(new OpenAIChatClient(model(fake.url, { efforts: ["low"] })), "high")
    expect(fake.requests[0].reasoning_effort).toBeUndefined()
    expect(fake.requests[0].chat_template_kwargs).toBeUndefined()
  })

  test("template refuses an effort → retried without it, vocabulary learned from the message", async () => {
    fake = fakeProvider([
      { status: 500, body: '{"error":{"message":"Unexpected reasoning effort high. Supported types are xhigh (default), medium, and low."}}' },
      { chunks: [delta({ content: "ok" })] },
    ])
    const m = model(fake.url, { efforts: ["low", "medium", "high"] })
    const ev = await collect(new OpenAIChatClient(m), "high")
    expect(fake.requests[1].reasoning_effort).toBeUndefined()
    expect(learned().efforts[m.ref]).toEqual(["low", "medium", "xhigh"])
    expect(ev.some((e) => e.type === "notice")).toBe(true)
  })

  test("max_tokens field, model body merged, vision off strips images", async () => {
    fake = fakeProvider([{ chunks: [delta({ content: "ok" })] }])
    const m = model(fake.url, { max_output: 1234, body: { chat_template_kwargs: { enable_thinking: false } } }, { quirks: { max_tokens_field: "max_completion_tokens" } })
    const c = new OpenAIChatClient(m)
    for await (const _ of c.stream({ system: "", messages: [{ role: "user", parts: [{ type: "text", text: "see" }, { type: "image", mime: "image/png", data: "AAAA" }] }], tools: [] })) void _
    expect(fake.requests[0].max_completion_tokens).toBe(1234)
    expect(fake.requests[0].chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(fake.requests[0].messages[0].content).toContain("[image omitted")
  })

  test("in-stream error frame is raised", async () => {
    fake = fakeProvider([{ chunks: [{ error: { message: "context overflow" } }] }])
    await expect(collect(new OpenAIChatClient(model(fake.url)))).rejects.toThrow("context overflow")
  })

  test("discovery reads context from every known key", async () => {
    fake = fakeProvider([])
    const found = await new OpenAIChatClient(model(fake.url)).listModels()
    expect(found).toEqual([
      { id: "m1", context: 32768 },
      { id: "m2", context: 8192 },
    ])
    expect(contextFrom({ context_length: "4096" })).toBe(4096)
  })
})
