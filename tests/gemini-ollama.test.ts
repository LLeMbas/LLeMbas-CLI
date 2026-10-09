// Gemini and Ollama are UNTESTED against real servers (the wiki says so). These fixtures follow the
// documented shapes and what Hermes Agent and OpenCode handle.
import { afterEach, describe, expect, test } from "bun:test"
import { DEFAULT_MAX_OUTPUT, GeminiClient, geminiJsonSchema, geminiSchema, SKIP_SIGNATURE, thinkingConfig, toGeminiContents } from "../src/provider/gemini.ts"
import { OllamaClient, parseShow } from "../src/provider/ollama.ts"
import type { Message, ResolvedModel, StreamEvent } from "../src/provider/types.ts"
import { BUILTIN_TOOLS } from "../src/tool/registry.ts"
import { toSpec } from "../src/tool/tool.ts"
import { fakeProvider, type Fake } from "./fake-provider.ts"

let fake: Fake | undefined
afterEach(() => fake?.stop())

const m = (dialect: "gemini" | "ollama", url: string, id: string, spec: ResolvedModel["spec"] = {}): ResolvedModel => ({
  ref: `x/${id}`,
  connectionName: "x",
  id,
  spec,
  connection: { dialect, base_url: url, api_key: "KEY", models: {} },
})
async function run(c: GeminiClient | OllamaClient, messages: Message[] = [{ role: "user", parts: [{ type: "text", text: "hi" }] }], effort: any = null) {
  const ev: StreamEvent[] = []
  for await (const e of c.stream({ system: "sys", messages, tools: BUILTIN_TOOLS.map(toSpec).slice(0, 2), effort })) ev.push(e)
  return ev
}
const finishOf = (ev: StreamEvent[]) => {
  const f = ev.find((e) => e.type === "finish")
  if (!f || f.type !== "finish") throw new Error("no finish")
  return f
}

describe("gemini", () => {
  test("every built-in tool's schema is reduced to what Gemini accepts", () => {
    const allowed = new Set(["type", "format", "title", "description", "nullable", "enum", "maxItems", "minItems", "properties", "required", "minProperties", "maxProperties", "minLength", "maxLength", "pattern", "example", "anyOf", "propertyOrdering", "default", "items", "minimum", "maximum"])
    const walk = (s: any, path: string) => {
      if (!s || typeof s !== "object") return
      for (const [k, v] of Object.entries(s)) {
        if (k === "properties") for (const [p, sub] of Object.entries(v as object)) walk(sub, `${path}.${p}`)
        else {
          expect(allowed.has(k) ? k : `${path}: ${k}`).toBe(k)
          if (k === "items" || k === "anyOf") walk(v, path)
        }
      }
    }
    for (const t of BUILTIN_TOOLS.map(toSpec)) walk(geminiSchema(t.parameters), t.name)
    expect(geminiSchema({ type: ["string", "null"], additionalProperties: false })).toEqual({ type: "string", nullable: true })
  })

  test("subset schema: unions keep every branch, enums become strings, required only names what exists", () => {
    expect(geminiSchema({ type: ["array", "string", "null"], items: { type: "string", $comment: "x" }, minItems: 1 })).toEqual({
      anyOf: [{ type: "array", items: { type: "string" }, minItems: 1 }, { type: "string" }],
      nullable: true,
    })
    expect(geminiSchema({ type: "integer", enum: [1, 2, 2, null] })).toEqual({ type: "integer", enum: ["1", "2"] })
    expect(geminiSchema({ type: "object", properties: { a: { type: "string" } }, required: ["a", "b"] })).toEqual({ type: "object", properties: { a: { type: "string" } }, required: ["a"] })
    expect(geminiSchema({ type: "object", required: ["b"] })).toEqual({ type: "object" })
  })

  test("JSON Schema (v1beta): local $refs inlined with their siblings, $defs and $schema gone; a circular one goes as it is", () => {
    const s = { $schema: "x", type: "object", $defs: { P: { type: "string", description: "p" } }, properties: { a: { $ref: "#/$defs/P", description: "mine" } } }
    expect(geminiJsonSchema(s)).toEqual({ type: "object", properties: { a: { type: "string", description: "mine" } } })
    const loop = { type: "object", $defs: { N: { type: "object", properties: { next: { $ref: "#/$defs/N" } } } }, properties: { n: { $ref: "#/$defs/N" } } }
    expect(geminiJsonSchema(loop)).toEqual(loop)
    expect(geminiJsonSchema({ type: "object" })).toEqual({ type: "object", properties: {} })
    expect(geminiJsonSchema(undefined)).toEqual({ type: "object", properties: {} })
  })

  test("thinking: budgets for 2.x (2.5 Pro to 32k), levels for 3 fitted to what each model has", () => {
    expect(thinkingConfig("gemini-2.5-pro", "max")).toEqual({ thinkingBudget: 32768, includeThoughts: true })
    expect(thinkingConfig("models/gemini-2.5-flash", "max")).toEqual({ thinkingBudget: 24576, includeThoughts: true })
    expect(thinkingConfig("gemini-2.5-flash", "low", { low: 500 })).toEqual({ thinkingBudget: 500, includeThoughts: true })
    const level = (id: string, e: any) => thinkingConfig(id, e).thinkingLevel
    expect(level("gemini-3-pro", "minimal")).toBe("low")
    expect(level("gemini-3-pro", "medium")).toBe("medium")
    expect(level("gemini-3-flash", "minimal")).toBe("minimal")
    expect(level("gemini-3.1-pro", "xhigh")).toBe("high")
    expect(level("gemma-4-31b-it", "medium")).toBe("high")
  })

  test("request: URL, key header, system, thinking budget (2.5) or level (3); stream: thoughts, text, a call with its signature", async () => {
    const frames = [
      { candidates: [{ content: { role: "model", parts: [{ text: "Let me look.", thought: true }] } }] },
      { candidates: [{ content: { role: "model", parts: [{ text: "Reading the file." }] } }] },
      { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "read", args: { path: "a.ts" } }, thoughtSignature: "SIG" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10, thoughtsTokenCount: 5, cachedContentTokenCount: 20 } },
    ]
    fake = fakeProvider([{ chunks: frames }, { chunks: frames }])
    const base = fake.url.replace(/\/v1$/, "/v1beta")
    const ev = await run(new GeminiClient(m("gemini", base, "gemini-2.5-pro", { max_output: 1000 })), undefined, "medium")
    expect(fake.calls[0]!.path).toBe("/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse")
    expect(fake.calls[0]!.headers["x-goog-api-key"]).toBe("KEY")
    expect(fake.calls[0]!.headers.authorization).toBeUndefined()
    const r = fake.requests[0]
    expect(r.systemInstruction).toEqual({ parts: [{ text: "sys" }] })
    expect(r.generationConfig).toEqual({ maxOutputTokens: 1000, thinkingConfig: { thinkingBudget: 8192, includeThoughts: true } })
    expect(r.tools[0].functionDeclarations[0].name).toBe("read")
    expect(r.tools[0].functionDeclarations[0].parametersJsonSchema.type).toBe("object")
    expect(r.tools[0].functionDeclarations[0].parameters).toBeUndefined()
    const fin = finishOf(ev)
    expect(fin.reason).toBe("tool_calls")
    expect(fin.message.parts).toEqual([
      { type: "reasoning", text: "Let me look." },
      { type: "text", text: "Reading the file." },
      { type: "tool_call", id: "gemini_call_0", name: "read", args: '{"path":"a.ts"}', signature: "SIG" },
    ])
    expect(ev.find((e) => e.type === "usage")).toEqual({ type: "usage", usage: { input: 50, output: 15, reasoning: 5, cached: 20 } })
    await run(new GeminiClient(m("gemini", base, "gemini-3-pro")), undefined, "high")
    expect(fake.requests[1].generationConfig).toEqual({ maxOutputTokens: DEFAULT_MAX_OUTPUT, thinkingConfig: { thinkingLevel: "high", includeThoughts: true } })
  })

  test("another API version gets the OpenAPI subset as `parameters`", async () => {
    fake = fakeProvider([{ chunks: [{ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] }] }])
    await run(new GeminiClient(m("gemini", fake.url, "gemini-2.0-flash")))
    const d = fake.requests[0].tools[0].functionDeclarations[0]
    expect(d.parametersJsonSchema).toBeUndefined()
    expect(d.parameters.type).toBe("object")
  })

  test("stream: a call sent again stays one call; a different one is a new call; Gemini 3 ids are kept", async () => {
    const call = (args: unknown, extra: Record<string, unknown> = {}) => ({ candidates: [{ content: { parts: [{ functionCall: { name: "read", args, ...extra } }] } }] })
    fake = fakeProvider([
      { chunks: [call({ path: "a", limit: 5 }), call({ limit: 5, path: "a" }), call({ path: "b" }), { candidates: [{ finishReason: "STOP" }] }] },
      { chunks: [call({ path: "c" }, { id: "fc_1" }), { candidates: [{ finishReason: "SAFETY" }] }] },
    ])
    const base = fake.url.replace(/\/v1$/, "/v1beta")
    const fin = finishOf(await run(new GeminiClient(m("gemini", base, "gemini-2.5-flash"))))
    expect(fin.message.parts).toEqual([
      { type: "tool_call", id: "gemini_call_0", name: "read", args: '{"limit":5,"path":"a"}' },
      { type: "tool_call", id: "gemini_call_1", name: "read", args: '{"path":"b"}' },
    ])
    const fin3 = finishOf(await run(new GeminiClient(m("gemini", base, "gemini-3-pro"))))
    expect(fin3.message.parts).toEqual([{ type: "tool_call", id: "fc_1", name: "read", args: '{"path":"c"}' }])
    expect(fin3.reason).toBe("tool_calls")
  })

  test("history: the signature rides back on its call; results answer by name; roles merge", () => {
    const c = toGeminiContents(
      [
        { role: "user", parts: [{ type: "text", text: "go" }] },
        { role: "assistant", parts: [{ type: "reasoning", text: "x" }, { type: "tool_call", id: "gemini_call_0", name: "read", args: '{"path":"a"}', signature: "SIG" }] },
        { role: "tool", callId: "gemini_call_0", name: "read", content: "A" },
        { role: "user", parts: [{ type: "text", text: "and?" }] },
      ],
      false,
    )
    expect(c).toEqual([
      { role: "user", parts: [{ text: "go" }] },
      { role: "model", parts: [{ functionCall: { name: "read", args: { path: "a" } }, thoughtSignature: "SIG" }] },
      { role: "user", parts: [{ functionResponse: { name: "read", response: { output: "A" } } }] },
      // never folded into the tool result: Gemini 3 would read it as part of it
      { role: "model", parts: [{ text: "[The previous response was interrupted before it completed.]" }] },
      { role: "user", parts: [{ text: "and?" }] },
    ])
  })

  test("history for Gemini 3: ids on both sides, the sentinel for an unsigned call, JSON results structured unless they hold a $ref", () => {
    const c = toGeminiContents(
      [
        { role: "user", parts: [{ type: "text", text: "go" }] },
        { role: "assistant", parts: [{ type: "tool_call", id: "c1", name: "read", args: "{}" }, { type: "tool_call", id: "c2", name: "grep", args: "{}" }] },
        { role: "tool", callId: "c1", name: "read", content: '{"lines": 3}' },
        { role: "tool", callId: "c2", name: "grep", content: '{"$ref": "#/$defs/X"}', isError: false },
      ],
      false,
      true,
    )
    expect(c[1]!.parts[0]).toEqual({ functionCall: { name: "read", args: {}, id: "c1" }, thoughtSignature: SKIP_SIGNATURE })
    expect(c[2]).toEqual({
      role: "user",
      parts: [{ functionResponse: { name: "read", response: { lines: 3 }, id: "c1" } }, { functionResponse: { name: "grep", response: { output: '{"$ref": "#/$defs/X"}' }, id: "c2" } }],
    })
  })
})

describe("ollama", () => {
  const nd = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n"

  test("NDJSON: thinking, text, whole tool calls, counts; num_ctx and think in the request", async () => {
    fake = fakeProvider([
      {
        chunks: [],
        raw: nd([
          { message: { role: "assistant", content: "", thinking: "Hmm." }, done: false },
          { message: { role: "assistant", content: "Reading." }, done: false },
          { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "read", arguments: { path: "a.ts" } } }] }, done: false },
          { message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 30, eval_count: 7 },
        ]),
      },
    ])
    const ev = await run(new OllamaClient(m("ollama", fake.url.replace(/\/v1$/, ""), "gpt-oss:20b", { context: 32768, max_output: 2000 })), undefined, "high")
    expect(fake.calls[0]!.path).toBe("/api/chat")
    expect(fake.requests[0]).toMatchObject({ model: "gpt-oss:20b", stream: true, think: "high", options: { num_ctx: 32768, num_predict: 2000 } })
    expect(fake.requests[0].messages[0]).toEqual({ role: "system", content: "sys" })
    const fin = finishOf(ev)
    expect(fin.message.parts).toEqual([
      { type: "reasoning", text: "Hmm." },
      { type: "text", text: "Reading." },
      { type: "tool_call", id: "ollama_call_0", name: "read", args: '{"path":"a.ts"}' },
    ])
    expect(fin.reason).toBe("tool_calls")
    expect(ev.find((e) => e.type === "usage")).toEqual({ type: "usage", usage: { input: 30, output: 7 } })
  })

  test("think: a switch for other models, off when efforts exist but none is chosen; an error line is retried once", async () => {
    fake = fakeProvider([{ chunks: [], raw: nd([{ error: "model runner has unexpectedly stopped" }]) }, { chunks: [], raw: nd([{ message: { content: "ok" }, done: true }]) }, { chunks: [], raw: nd([{ message: { content: "ok" }, done: true }]) }])
    const base = fake.url.replace(/\/v1$/, "")
    const ev = await run(new OllamaClient(m("ollama", base, "qwen3:8b", { efforts: ["low", "high"] })), undefined, "low")
    expect(fake.requests[0].think).toBe(true)
    expect(ev.some((e) => e.type === "notice" && e.message.includes("unexpectedly stopped"))).toBe(true)
    await run(new OllamaClient(m("ollama", base, "qwen3:8b", { efforts: ["low", "high"] })))
    expect(fake.requests[2].think).toBe(false)
  })

  test("/api/show: no `think` for a model that cannot think; num_ctx from the Modelfile, else the trained maximum", async () => {
    const show = { capabilities: ["completion", "tools"], parameters: "stop \"<|im_end|>\"\nnum_ctx                        16384", model_info: { "qwen3.context_length": 40960 } }
    expect(parseShow(show)).toEqual({ capabilities: ["completion", "tools"], numCtx: 16384, trained: 40960 })
    fake = fakeProvider([{ chunks: [], raw: nd([{ message: { content: "ok" }, done: true }]) }], { show })
    const base = fake.url.replace(/\/v1$/, "")
    const c = new OllamaClient(m("ollama", base, "llama3:8b", { efforts: ["low", "high"] }))
    await run(c, undefined, "high")
    expect(fake.requests[0].think).toBeUndefined()
    expect(fake.requests[0].options.num_ctx).toBe(16384)
    expect(await c.contextOf("llama3:8b")).toBe(16384)
    expect(parseShow({ model_info: { "llama.context_length": 8192 } })).toEqual({ trained: 8192 })
  })
})
