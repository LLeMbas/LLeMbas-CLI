import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../src/app.ts"
import type { AskReply, Event } from "../src/bus/index.ts"
import { paths } from "../src/config/paths.ts"
import { estimateValue, IMAGE_FALLBACK_TOKENS, imageSize, imageTokens } from "../src/provider/tokens.ts"
import { delta, fakeProvider, toolCall, usage, type Fake } from "./fake-provider.ts"

/** A PNG-shaped file of `bytes` bytes that says it is `w`×`h` (header only; the rest is filler). */
function png(w: number, h: number, bytes: number): Buffer {
  const out = Buffer.alloc(bytes, 0x41)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(out, 0)
  out.writeUInt32BE(w, 16)
  out.writeUInt32BE(h, 20)
  return out
}

let fake: Fake | undefined
afterEach(() => fake?.stop())

describe("an image counts by its dimensions, never its encoding", () => {
  test("sizes are read from PNG, GIF and JPEG headers", () => {
    expect(imageSize(png(2560, 1440, 64))).toEqual({ width: 2560, height: 1440 })
    const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xf0, 0x00])
    expect(imageSize(gif)).toEqual({ width: 320, height: 240 })
    // SOI, an APP0 segment of 16 bytes, then SOF0 with height 600 and width 800.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...Array(14).fill(0), 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03])
    expect(imageSize(jpeg)).toEqual({ width: 800, height: 600 })
  })

  test("a 1.5 MB 2560×1440 screenshot is thousands of tokens, not half a million", () => {
    const data = png(2560, 1440, 1_500_000).toString("base64")
    expect(imageTokens(data)).toBe(Math.ceil(2560 / 28) * Math.ceil(1440 / 28))
    const message = { role: "user", parts: [{ type: "text", text: "look" }, { type: "image", mime: "image/png", data }] }
    expect(estimateValue(message)).toBeLessThan(5_000)
    // The same image in each dialect's wire shape.
    expect(estimateValue([{ content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${data}` } }] }])).toBeLessThan(5_000)
    expect(estimateValue([{ content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }] }])).toBeLessThan(5_000)
    expect(estimateValue([{ role: "user", content: "look", images: [data] }])).toBeLessThan(5_000)
  })

  test("an image whose size cannot be read has a flat cost", () => {
    expect(imageTokens(Buffer.alloc(300_000, 7).toString("base64"))).toBe(IMAGE_FALLBACK_TOKENS)
  })

  test("view_image of a 1.5 MB screenshot at 20% of the window does not compact", async () => {
    fake = fakeProvider([
      { chunks: [toolCall(0, "c1", "view_image", '{"path":"shot.png"}'), usage(52_000, 50)] },
      { chunks: [delta({ content: "a screenshot" }), usage(56_000, 5)] },
    ])
    mkdirSync(paths.config, { recursive: true })
    writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  f:\n    dialect: openai-chat\n    base_url: ${fake.url}\n    models:\n      m: { vision: true, context: 262144 }\n`, { mode: 0o600 })
    writeFileSync(join(paths.config, "config.yaml"), "model: f/m\n")
    const root = mkdtempSync(join(tmpdir(), "ph-img-"))
    writeFileSync(join(root, "shot.png"), png(2560, 1440, 1_500_000))
    const app = createApp({ cwd: root, mode: "edit", store: false, asker: { ask: async (): Promise<AskReply> => ({ kind: "once" }) } })
    const notices: string[] = []
    app.bus.on((e: Event) => {
      if (e.type === "notice") notices.push(e.message)
    })
    await app.engine.prompt("look at shot.png")
    expect(notices.filter((n) => n.includes("compacting") || n.includes("pruned"))).toEqual([])
    expect(fake.requests.length).toBe(2)
  })
})
