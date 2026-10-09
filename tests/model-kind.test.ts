import { expect, test } from "bun:test"
import { isChatModel } from "../src/lembas/webui.ts"

test("a model's kind: only embedding, stt, tts and image are not chat", () => {
  for (const kind of [undefined, null, "chat", "openai", "anthropic"]) expect(isChatModel({ id: "m", kind } as any)).toBe(true)
  for (const kind of ["embedding", "stt", "tts", "image"]) expect(isChatModel({ id: "m", kind } as any)).toBe(false)
})
