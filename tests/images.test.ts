import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../src/app.ts"
import type { AskReply } from "../src/bus/index.ts"
import { paths } from "../src/config/paths.ts"
import { attachmentsFor } from "../src/project/attach.ts"
import { delta, fakeProvider, toolCall, type Fake } from "./fake-provider.ts"

// A 1×1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64")
let fake: Fake | undefined
afterEach(() => fake?.stop())

function project() {
  const root = mkdtempSync(join(tmpdir(), "ph-img-"))
  writeFileSync(join(root, "shot.png"), PNG)
  return root
}

describe("images", () => {
  test("@image: attached as an image with vision; without, the model is told why not", () => {
    const root = project()
    const ctx = { root, cwd: root, readFiles: new Set<string>(), fileStamps: new Map() }
    const [withVision] = attachmentsFor("look at @shot.png", ctx, true)
    expect(withVision!.image).toEqual({ type: "image", mime: "image/png", data: PNG.toString("base64") })
    const [without] = attachmentsFor("look at @shot.png", ctx, false)
    expect(without!.image).toBeUndefined()
    expect(without!.text).toContain("not attached: this model has no vision")
  })

  function setup(vision: boolean, script: Parameters<typeof fakeProvider>[0]) {
    fake = fakeProvider(script)
    mkdirSync(paths.config, { recursive: true })
    writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  f:\n    type: webui\n    url: ${fake.url}\n    models:\n      f/m: { vision: ${vision} }\n`, { mode: 0o600 })
    writeFileSync(join(paths.config, "config.yaml"), "model: f/m\n")
    return createApp({ cwd: project(), mode: "edit", store: false, asker: { ask: async (): Promise<AskReply> => ({ kind: "once" }) } })
  }

  test("view_image: offered only with vision; the image follows the tool results as a user turn", async () => {
    const blind = setup(false, [{ chunks: [delta({ content: "ok" })] }])
    await blind.engine.prompt("hi")
    expect(fake!.requests[0].tools.map((t: any) => t.function.name)).not.toContain("view_image")
    fake!.stop()

    const app = setup(true, [{ chunks: [toolCall(0, "c1", "view_image", '{"path":"shot.png"}')] }, { chunks: [delta({ content: "A single pixel." })] }])
    await app.engine.prompt("what is in shot.png?")
    expect(fake!.requests[0].tools.map((t: any) => t.function.name)).toContain("view_image")
    const msgs = fake!.requests[1].messages
    expect(msgs.at(-2)).toMatchObject({ role: "tool", tool_call_id: "c1" })
    expect(msgs.at(-1).role).toBe("user")
    expect(msgs.at(-1).content[1]).toEqual({ type: "image_url", image_url: { url: `data:image/png;base64,${PNG.toString("base64")}` } })
  })

  test("a prompt with @image reaches an openai-chat vision model as image_url", async () => {
    const app = setup(true, [{ chunks: [delta({ content: "ok" })] }])
    const { attachmentsFor: att } = await import("../src/project/attach.ts")
    const atts = att("see @shot.png", app.engine.o.toolCtx, true)
    await app.engine.prompt("see @shot.png", atts.flatMap((a) => (a.image ? [a.text, a.image] : [a.text])))
    const content = fake!.requests[0].messages.at(-1).content
    expect(content.map((p: any) => p.type)).toEqual(["text", "text", "image_url"])
  })
})
