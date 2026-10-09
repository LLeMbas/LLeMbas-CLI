import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { AnthropicClient, toAnthropicMessages } from "../src/provider/anthropic.ts"
import type { Message, ResolvedModel, StreamEvent } from "../src/provider/types.ts"
import { fakeProvider, type Fake } from "./fake-provider.ts"

let fake: Fake | undefined
afterEach(() => fake?.stop())

const model = (url: string, spec: ResolvedModel["spec"] = {}): ResolvedModel => ({
  ref: "a/m",
  connectionName: "a",
  id: "m",
  spec,
  connection: { dialect: "anthropic", base_url: url, api_key: "k", models: {} },
})
const sse = (events: Record<string, unknown>[]) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("")
async function run(c: AnthropicClient, messages: Message[] = [{ role: "user", parts: [{ type: "text", text: "hi" }] }], effort: any = null) {
  const ev: StreamEvent[] = []
  for await (const e of c.stream({ system: "sys", messages, tools: [{ name: "read", description: "read", parameters: { type: "object" } }], effort })) ev.push(e)
  return ev
}

describe("anthropic dialect", () => {
  test("a real vLLM stream: thinking with its signature, then a tool call", async () => {
    fake = fakeProvider([{ chunks: [], raw: readFileSync(join(import.meta.dir, "fixtures/sse/vllm-anthropic-thinking-tool.sse"), "utf8") }])
    const ev = await run(new AnthropicClient(model(fake.url.replace(/\/v1$/, ""))))
    const fin = ev.find((e) => e.type === "finish")!
    if (fin.type !== "finish") throw new Error()
    expect(fin.reason).toBe("tool_calls")
    const thinking = fin.message.parts.find((p) => p.type === "reasoning")
    expect(thinking?.type === "reasoning" && thinking.signature).toBeTruthy()
    expect(fin.message.parts.some((p) => p.type === "tool_call")).toBe(true)
    expect(ev.some((e) => e.type === "reasoning")).toBe(true)
  })

  test("request: headers, max_tokens above the thinking budget, no sampling with thinking, cache breakpoints", async () => {
    fake = fakeProvider([{ chunks: [], raw: sse([{ type: "message_start", message: { usage: { input_tokens: 5 } } }, { type: "message_stop" }]) }])
    const c = new AnthropicClient(model(fake.url, { max_output: 4000, temperature: 0.5, cache: true, effort_map: { high: 10000 } }))
    await run(c, undefined, "high")
    const r = fake.requests[0]
    expect(r.thinking).toEqual({ type: "enabled", budget_tokens: 10000 })
    expect(r.max_tokens).toBeGreaterThan(10000)
    expect(r.temperature).toBeUndefined()
    expect(r.system[0].cache_control).toEqual({ type: "ephemeral" })
    expect(r.tools.at(-1).cache_control).toEqual({ type: "ephemeral" })
    expect(r.messages.at(-1).content.at(-1).cache_control).toEqual({ type: "ephemeral" })
  })

  test("stream: text, redacted thinking, tool input in pieces, cache usage, stop reasons", async () => {
    fake = fakeProvider([
      {
        chunks: [],
        raw: sse([
          { type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 1 } } },
          { type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "OPAQUE" } },
          { type: "content_block_stop", index: 0 },
          { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Reading." } },
          { type: "content_block_stop", index: 1 },
          { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "read", input: {} } },
          { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"pa' } },
          { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: 'th":"a"}' } },
          { type: "content_block_stop", index: 2 },
          { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 42 } },
          { type: "message_stop" },
        ]),
      },
    ])
    const ev = await run(new AnthropicClient(model(fake.url)))
    const fin = ev.find((e) => e.type === "finish")
    expect(fin?.type === "finish" && fin.message.parts).toEqual([
      { type: "reasoning", text: "", opaque: { redacted: "OPAQUE" } },
      { type: "text", text: "Reading." },
      { type: "tool_call", id: "toolu_1", name: "read", args: '{"path":"a"}' },
    ])
    expect(ev.find((e) => e.type === "usage")).toEqual({ type: "usage", usage: { input: 100, output: 42, cached: 90 } })
    expect(fake.requests[0]).toMatchObject({ model: "m", stream: true })
  })

  test("overloaded before any output is retried once", async () => {
    fake = fakeProvider([
      { chunks: [], raw: sse([{ type: "message_start", message: { usage: { input_tokens: 1 } } }, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }]) },
      { chunks: [], raw: sse([{ type: "content_block_start", index: 0, content_block: { type: "text", text: "ok" } }, { type: "content_block_stop", index: 0 }, { type: "message_stop" }]) },
    ])
    const ev = await run(new AnthropicClient(model(fake.url)))
    expect(ev.some((e) => e.type === "notice" && e.message.includes("Overloaded"))).toBe(true)
    const fin = ev.find((e) => e.type === "finish")
    expect(fin?.type === "finish" && fin.message.parts).toEqual([{ type: "text", text: "ok" }])
  })

  test("history: tool results grouped as a user turn, ids made safe, thinking only with a signature and only while thinking", () => {
    const msgs: Message[] = [
      { role: "user", parts: [{ type: "text", text: "go" }] },
      { role: "assistant", parts: [{ type: "reasoning", text: "unsigned (from another provider)" }, { type: "reasoning", text: "signed", signature: "SIG" }, { type: "tool_call", id: "call:1", name: "read", args: '{"path":"a"}' }, { type: "tool_call", id: "call:2", name: "read", args: "{}" }] },
      { role: "tool", callId: "call:1", name: "read", content: "A" },
      { role: "tool", callId: "call:2", name: "read", content: "", isError: true },
      { role: "user", parts: [{ type: "text", text: "and?" }] },
    ]
    const on = toAnthropicMessages(msgs, false, true)
    expect(on.map((m) => m.role)).toEqual(["user", "assistant", "user"])
    expect(on[1]!.content).toEqual([
      { type: "thinking", thinking: "signed", signature: "SIG" },
      { type: "tool_use", id: "call_1", name: "read", input: { path: "a" } },
      { type: "tool_use", id: "call_2", name: "read", input: {} },
    ])
    expect(on[2]!.content).toEqual([
      { type: "tool_result", tool_use_id: "call_1", content: "A" },
      { type: "tool_result", tool_use_id: "call_2", content: "(empty)", is_error: true },
      { type: "text", text: "and?" },
    ])
    expect(toAnthropicMessages(msgs, false, false)[1]!.content.some((b) => b.type === "thinking")).toBe(false)
  })
})
