// Harness spec 3.2.0 through the whole app: effort levels as a request carries them, the model's
// reasoning sent back during its turn and not after it, and no absolute path in what the model is
// told — relative paths and the shell at the project root, wherever the session was started.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../src/app.ts"
import type { AskReply } from "../src/bus/index.ts"
import { paths } from "../src/config/paths.ts"
import { delta, fakeProvider, toolCall, usage, type Fake } from "./fake-provider.ts"

let fake: Fake | undefined
afterEach(() => fake?.stop())

function setup(script: Parameters<typeof fakeProvider>[0], spec = "{ context: 32768 }") {
  fake = fakeProvider(script)
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  fake:\n    type: webui\n    url: ${fake.url}\n    models:\n      fake/m: ${spec}\n`, { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), "model: fake/m\n")
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lembas-320-")))
  Bun.spawnSync(["git", "init", "-q", dir])
  mkdirSync(join(dir, "packages", "web"), { recursive: true })
  writeFileSync(join(dir, "top.txt"), "at the root\n")
  writeFileSync(join(dir, "packages", "web", "index.ts"), "export {}\n")
  return dir
}

const yes = { ask: async (): Promise<AskReply> => ({ kind: "once" }) }

describe("reasoning goes back during its turn (context.md §8)", () => {
  test("a step's reasoning is sent back within the turn, a step-boundary note does not end the turn, and the next turn sends none", async () => {
    const dir = setup([
      { chunks: [delta({ reasoning_content: "List first." }), toolCall(0, "l1", "list", "{}"), usage(100, 10)] },
      { chunks: [delta({ reasoning_content: "Now answer." }), delta({ content: "Two files." }, "stop"), usage(150, 10)] },
      { chunks: [delta({ content: "Still two." }, "stop"), usage(200, 5)] },
    ])
    const app = createApp({ cwd: dir, mode: "edit", asker: yes, store: false })
    // A job's note delivered at the first step boundary: it does not start a turn.
    app.engine.note("[A background job you started has finished:]\njob1 (true) exited with 0 after 0s.")
    await app.engine.prompt("what is here?")
    const second = fake!.requests[1].messages.filter((m: any) => m.role === "assistant")
    expect(second).toEqual([expect.objectContaining({ reasoning_content: "List first." })])
    await app.engine.prompt("and now?")
    // A new turn: the earlier replies go without their reasoning.
    const third = fake!.requests[2].messages.filter((m: any) => m.role === "assistant")
    expect(third.length).toBe(2)
    for (const m of third) expect(m.reasoning_content).toBeUndefined()
  })

  test("reasoning read from inline <think> tags goes back as reasoning_content, never as text", async () => {
    const dir = setup([
      { chunks: [delta({ content: "<think>Look at the list.</think>" }), toolCall(0, "l1", "list", "{}"), usage(100, 10)] },
      { chunks: [delta({ content: "Done." }, "stop"), usage(150, 10)] },
    ])
    const app = createApp({ cwd: dir, mode: "edit", asker: yes, store: false })
    await app.engine.prompt("look")
    const reply = fake!.requests[1].messages.find((m: any) => m.role === "assistant")
    expect(reply.reasoning_content).toBe("Look at the list.")
    expect(reply.content ?? "").not.toContain("think")
  })
})

describe("effort levels in a request (models/schema.json levels)", () => {
  test("off on a model with the switch: enable_thinking false and no effort; the start level otherwise", async () => {
    const dir = setup([{ chunks: [delta({ content: "a" }, "stop")] }, { chunks: [delta({ content: "b" }, "stop")] }], "{ thinking_switch: true, efforts: [medium] }")
    const app = createApp({ cwd: dir, mode: "edit", asker: yes, store: false, effort: "off" })
    expect(app.engine.effort).toBe("off")
    await app.engine.prompt("hi")
    expect(fake!.requests[0].chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(fake!.requests[0].reasoning_effort).toBeUndefined()
    app.settings.set("effort", "medium")
    await app.engine.prompt("again")
    expect(fake!.requests[1].reasoning_effort).toBe("medium")
    expect(fake!.requests[1].chat_template_kwargs).toEqual({ reasoning_effort: "medium" })
    expect(() => app.settings.set("effort", "high")).toThrow("offers the levels off, medium")
  })

  test("off asked of a model without the switch starts at its start level", async () => {
    const dir = setup([{ chunks: [delta({ content: "a" }, "stop")] }], "{ efforts: [low, high] }")
    const app = createApp({ cwd: dir, mode: "edit", asker: yes, store: false, effort: "off" })
    expect(app.engine.effort).toBe("low")
  })
})

describe("no absolute paths (context.md §11)", () => {
  test("started below the root: the prompt names the project and the directory relative to it; read and bash work from the root", async () => {
    const dir = setup([
      { chunks: [toolCall(0, "r1", "read", '{"path":"top.txt"}'), toolCall(1, "b1", "bash", '{"command":"pwd","description":"where"}'), usage(100, 10)] },
      { chunks: [delta({ content: "ok" }, "stop"), usage(150, 5)] },
    ])
    const app = createApp({ cwd: join(dir, "packages", "web"), mode: "auto", asker: yes, store: false })
    await app.engine.prompt("look")
    const system = fake!.requests[0].messages[0].content as string
    expect(system).toContain(`Project: ${dir.split("/").pop()} (paths are relative to its root)\nStarted in: packages/web (relative to the project root)`)
    expect(system).not.toContain(dir)
    const results = fake!.requests[1].messages.filter((m: any) => m.role === "tool").map((m: any) => m.content as string)
    expect(results[0]).toContain("1: at the root")
    expect(results[1]).toContain(dir)
    expect(results[1]).not.toContain("packages/web")
  })
})
