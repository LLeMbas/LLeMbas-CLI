import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ResponsesClient, toResponsesInput } from "../src/provider/responses.ts"
import type { Message, ResolvedModel, StreamEvent } from "../src/provider/types.ts"
import { fakeProvider, type Fake } from "./fake-provider.ts"

let fake: Fake | undefined
afterEach(() => fake?.stop())

const model = (url: string, spec: ResolvedModel["spec"] = {}): ResolvedModel => ({ ref: "r/m", connectionName: "r", id: "m", spec, connection: { dialect: "responses", base_url: url, models: {} } })
const sse = (events: Record<string, unknown>[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")
async function run(c: ResponsesClient, messages: Message[] = [{ role: "user", parts: [{ type: "text", text: "hi" }] }], effort: any = null) {
  const ev: StreamEvent[] = []
  for await (const e of c.stream({ system: "sys", messages, tools: [{ name: "list", description: "d", parameters: { type: "object" } }], effort })) ev.push(e)
  return ev
}

describe("responses dialect", () => {
  test("a real vLLM stream: reasoning text, then a function call, with usage", async () => {
    fake = fakeProvider([{ chunks: [], raw: readFileSync(join(import.meta.dir, "fixtures/sse/vllm-responses-reasoning-tool.sse"), "utf8") }])
    const ev = await run(new ResponsesClient(model(fake.url)))
    const fin = ev.find((e) => e.type === "finish")!
    if (fin.type !== "finish") throw new Error()
    expect(fin.reason).toBe("tool_calls")
    expect(fin.message.parts[0]).toMatchObject({ type: "reasoning" })
    expect(fin.message.parts[1]).toMatchObject({ type: "tool_call", name: "list" })
    expect(ev.find((e) => e.type === "usage")).toMatchObject({ usage: { input: 4788, output: 111, reasoning: 21 } })
  })

  test("request shape; an encrypted reasoning item goes back verbatim on the next turn", async () => {
    const reasoningItem = { id: "rs_1", type: "reasoning", summary: [{ type: "summary_text", text: "plan" }], encrypted_content: "ENC" }
    fake = fakeProvider([
      {
        chunks: [],
        raw: sse([
          { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "plan" },
          { type: "response.output_item.done", item: reasoningItem },
          { type: "response.output_item.added", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "list" } },
          { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "{}" },
          { type: "response.output_item.done", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "list", arguments: "{}" } },
          { type: "response.completed", response: { status: "completed", usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 4 } } } },
        ]),
      },
      { chunks: [], raw: sse([{ type: "response.output_text.delta", delta: "done" }, { type: "response.completed", response: { status: "completed" } }]) },
    ])
    const c = new ResponsesClient(model(fake.url, { max_output: 999 }))
    const first = await run(c, undefined, "high")
    const fin = first.find((e) => e.type === "finish")!
    if (fin.type !== "finish") throw new Error()
    expect(first.find((e) => e.type === "usage")).toEqual({ type: "usage", usage: { input: 10, output: 5, reasoning: undefined, cached: 4 } })
    expect(fake.requests[0]).toMatchObject({ model: "m", store: false, instructions: "sys", max_output_tokens: 999, reasoning: { effort: "high", summary: "auto" }, include: ["reasoning.encrypted_content"] })
    expect(fake.requests[0].tools[0]).toMatchObject({ type: "function", name: "list" })
    await run(c, [{ role: "user", parts: [{ type: "text", text: "hi" }] }, fin.message, { role: "tool", callId: "call_1", name: "list", content: "a.txt" }], "high")
    expect(fake.requests[1].input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
      reasoningItem,
      { type: "function_call", call_id: "call_1", name: "list", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "a.txt" },
    ])
  })

  test("a server that does not know `include` gets one retry without it", async () => {
    fake = fakeProvider([{ status: 400, body: '{"error":{"message":"Unknown parameter: include"}}' }, { chunks: [], raw: sse([{ type: "response.output_text.delta", delta: "ok" }]) }])
    await run(new ResponsesClient(model(fake.url)), undefined, "low")
    expect(fake.requests[1].include).toBeUndefined()
    expect(fake.requests[1].reasoning).toEqual({ effort: "low", summary: "auto" })
  })

  test("history from another dialect: reasoning without an item is not sent; images only with vision", () => {
    const input = toResponsesInput(
      [
        { role: "user", parts: [{ type: "text", text: "see" }, { type: "image", mime: "image/png", data: "AAA" }] },
        { role: "assistant", parts: [{ type: "reasoning", text: "thought elsewhere" }, { type: "text", text: "ok" }] },
      ],
      true,
    )
    expect(input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "see" }, { type: "input_image", image_url: "data:image/png;base64,AAA" }] },
      { role: "assistant", content: [{ type: "output_text", text: "ok" }] },
    ])
  })
})
