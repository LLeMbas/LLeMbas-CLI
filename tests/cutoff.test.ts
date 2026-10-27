// What a long session on a local model (Bonsai 1-bit) ran into: replies that spent the
// whole output limit thinking, a write call cut off mid-content, and that broken call sent back on
// every request after it (llama.cpp answers each with a 500).
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../src/app.ts"
import type { AskReply, Event } from "../src/bus/index.ts"
import { paths } from "../src/config/paths.ts"
import { historyArgs } from "../src/provider/common.ts"
import { delta, fakeProvider, toolCall, usage, type Fake } from "./fake-provider.ts"

let fake: Fake | undefined
afterEach(() => fake?.stop())

function setup(script: Parameters<typeof fakeProvider>[0]) {
  fake = fakeProvider(script)
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(
    join(paths.config, "connections.yaml"),
    `connections:\n  fake:\n    type: webui\n    url: ${fake.url}\n    models:\n      fake/m: { context: 32768, max_output: 1000 }\n`,
    { mode: 0o600 },
  )
  writeFileSync(join(paths.config, "config.yaml"), "model: fake/m\n")
  const dir = mkdtempSync(join(tmpdir(), "lembas-cut-"))
  Bun.spawnSync(["git", "init", "-q", dir])
  return dir
}

const noAsk = { ask: async (): Promise<AskReply> => { throw new Error("should not ask") } }
const thinkOnly = (finish: string | null = "length") => ({ chunks: [delta({ reasoning_content: "hmm ".repeat(50) }), delta({}, finish), usage(100, 1000)] })
const notices = (app: ReturnType<typeof createApp>) => {
  const out: string[] = []
  app.bus.on((e: Event) => e.type === "notice" && out.push(e.message))
  return out
}

describe("a reply cut off at the output limit", () => {
  test("a write cut short is not run, the model is told to split it, and the next request carries valid JSON", async () => {
    const broken = '{"path":"sim.js","content":"// Ambitious — pure simulation\\nfunction mulberry32(seed) {\\n'
    const dir = setup([
      { chunks: [toolCall(0, "w1", "write", broken), delta({}, "length"), usage(100, 1000)] },
      { chunks: [delta({ content: "Splitting it." }, "stop"), usage(200, 5)] },
    ])
    const app = createApp({ cwd: dir, mode: "edit", asker: noAsk, store: false })
    const seen = notices(app)
    expect(await app.engine.prompt("write the sim")).toBe("stop")
    const sent = fake!.requests[1].messages
    const call = sent.find((m: any) => m.tool_calls)?.tool_calls[0]
    expect(JSON.parse(call.function.arguments)).toEqual({})
    expect(sent.at(-1)).toMatchObject({ role: "tool", tool_call_id: "w1" })
    expect(sent.at(-1).content).toContain("output limit of 1000 tokens")
    expect(seen.some((n) => n.includes("output limit (1,000 tokens) while writing a tool call"))).toBe(true)
  })

  test("thinking the whole limit away is asked about again, twice in a row, then stopped with a reason", async () => {
    const dir = setup([thinkOnly(), thinkOnly(), thinkOnly()])
    const app = createApp({ cwd: dir, mode: "edit", asker: noAsk, store: false })
    const seen = notices(app)
    expect(await app.engine.prompt("go")).toBe("stop")
    expect(fake!.requests).toHaveLength(3)
    expect(fake!.requests[1].messages.at(-1).content).toContain("hit the output limit while you were still thinking")
    expect(seen.at(-1)).toContain("3 replies in a row ran into the output limit (1,000 tokens)")
  })

  test("the count starts again after a reply that did something", async () => {
    const dir = setup([
      thinkOnly(null),
      { chunks: [toolCall(0, "l1", "list", "{}")] },
      thinkOnly(null),
      thinkOnly(null),
      { chunks: [delta({ content: "done" }, "stop")] },
    ])
    const app = createApp({ cwd: dir, mode: "edit", asker: noAsk, store: false })
    expect(await app.engine.prompt("go")).toBe("stop")
    expect(fake!.requests).toHaveLength(5)
  })

  test("an answer cut short is asked to carry on", async () => {
    const dir = setup([{ chunks: [delta({ content: "The first half" }, "length")] }, { chunks: [delta({ content: " and the rest." }, "stop")] }])
    const app = createApp({ cwd: dir, mode: "edit", asker: noAsk, store: false })
    expect(await app.engine.prompt("go")).toBe("stop")
    expect(fake!.requests[1].messages.at(-1).content).toContain("Carry on from exactly where it stopped")
  })
})

describe("history", () => {
  test("arguments that are not a JSON object go back as {}", () => {
    expect(historyArgs('{"a":1}')).toBe('{"a":1}')
    for (const bad of ['{"a":"unterminated', "", "[1]", "null", "3"]) expect(historyArgs(bad)).toBe("{}")
  })
})

describe("the context meter", () => {
  test("counts the reply's thinking only until it is dropped from the next request", async () => {
    const dir = setup([
      { chunks: [delta({ reasoning_content: "x".repeat(4000) }), toolCall(0, "l1", "list", "{}"), usage(1000, 1100)] },
      { chunks: [delta({ content: "ok" }, "stop"), usage(1150, 5)] },
    ])
    const app = createApp({ cwd: dir, mode: "edit", asker: noAsk, store: false })
    const used: number[] = []
    app.bus.on((e: Event) => e.type === "usage" && e.used !== undefined && used.push(e.used))
    await app.engine.prompt("go")
    // 1000 in + 1100 out, of which ~1000 thinking that is not sent again: ~1100, not 2100.
    expect(used[0]).toBeLessThan(1200)
    expect(used[0]).toBeGreaterThan(1000)
  })
})

describe("the connection timeout", () => {
  const withTimeout = (script: Parameters<typeof fakeProvider>[0]) => {
    const dir = setup(script)
    writeFileSync(
      join(paths.config, "connections.yaml"),
      `connections:\n  fake:\n    type: webui\n    url: ${fake!.url}\n    timeout: 0.4\n    models:\n      fake/m: { context: 32768 }\n`,
      { mode: 0o600 },
    )
    return dir
  }

  test("is for silence, not length: a reply streaming longer than it still arrives whole", async () => {
    const chunks = Array.from({ length: 10 }, (_, i) => delta({ content: `${i}` }))
    const dir = withTimeout([{ gapMs: 120, chunks }]) // ~1.1 s in all, never 0.4 s quiet
    const app = createApp({ cwd: dir, mode: "edit", asker: noAsk, store: false })
    expect(await app.engine.prompt("go")).toBe("stop")
    const last = app.engine.messages.at(-1)!
    expect(last.role === "assistant" && last.parts.find((p) => p.type === "text")).toMatchObject({ text: "0123456789" })
  })

  test("a stream that goes quiet for longer ends with a timeout", async () => {
    const dir = withTimeout([{ gapMs: 700, chunks: [delta({ content: "a" }), delta({ content: "b" })] }])
    const app = createApp({ cwd: dir, mode: "edit", asker: noAsk, store: false })
    const errors: string[] = []
    app.bus.on((e: Event) => e.type === "error" && errors.push(e.message))
    expect(await app.engine.prompt("go")).toBe("error")
    expect(errors[0]).toContain("sent nothing for 0s")
  })
})
