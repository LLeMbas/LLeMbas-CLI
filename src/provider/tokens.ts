// Rough token estimate for endpoints that report no usage (LLeMbas services/tokens.py).
export const CHARS_PER_TOKEN = 4

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/** An image whose size cannot be read counts as this many tokens (a 1600 px screenshot, roughly). */
export const IMAGE_FALLBACK_TOKENS = 1600
/** Pixels per token edge: Qwen-VL's 28 px patches; OpenAI's and Anthropic's tiles land near it. */
const PATCH = 28
/** No image costs more than this (vLLM's Qwen default max_pixels / 784). */
const IMAGE_MAX_TOKENS = 16_384
/** A string this long made only of base64 characters is an image's bytes, not text. */
const BASE64_MIN = 2_000
const BASE64 = /^[A-Za-z0-9+/=_-]+$/

/** The width and height in an image's first bytes (PNG, JPEG, GIF, WebP), or undefined. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  const at = (i: number) => bytes[i] ?? 0
  const be16 = (i: number) => (at(i) << 8) | at(i + 1)
  const le16 = (i: number) => at(i) | (at(i + 1) << 8)
  const be32 = (i: number) => ((at(i) << 24) | (at(i + 1) << 16) | (at(i + 2) << 8) | at(i + 3)) >>> 0
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return { width: be32(16), height: be32(20) }
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) return { width: le16(6), height: le16(8) }
  if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57 && at(9) === 0x45) {
    const chunk = String.fromCharCode(at(12), at(13), at(14), at(15))
    if (chunk === "VP8X") return { width: 1 + (at(24) | (at(25) << 8) | (at(26) << 16)), height: 1 + (at(27) | (at(28) << 8) | (at(29) << 16)) }
    if (chunk === "VP8 ") return { width: le16(26) & 0x3fff, height: le16(28) & 0x3fff }
    if (chunk === "VP8L") {
      const b = (at(21) | (at(22) << 8) | (at(23) << 16) | (at(24) << 24)) >>> 0
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }
    }
    return undefined
  }
  if (at(0) === 0xff && at(1) === 0xd8) {
    // Walk the segments to a start-of-frame marker (C0–CF, except C4, C8, CC).
    let i = 2
    while (i + 9 < bytes.length) {
      if (at(i) !== 0xff) return undefined
      const marker = at(i + 1)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: be16(i + 7), height: be16(i + 5) }
      }
      i += 2 + be16(i + 2)
    }
  }
  return undefined
}

/**
 * What an image costs a model, from its dimensions -- never from its encoding. Counting the
 * base64 as text made a 1.5 MB screenshot "512k tokens": the CLI then compacted after every
 * view_image, at "context 215%", while the provider charged a few thousand. Only the head is
 * decoded (enough for the header, and a JPEG's frame marker in all but odd files).
 */
export function imageTokens(base64: string): number {
  const head = base64.replace(/^data:[^,]*,/, "").slice(0, 87_384) // 64 KB of bytes
  let size: { width: number; height: number } | undefined
  try {
    size = imageSize(Buffer.from(head.slice(0, head.length - (head.length % 4)), "base64"))
  } catch {
    size = undefined
  }
  if (!size || !size.width || !size.height) return IMAGE_FALLBACK_TOKENS
  return Math.min(IMAGE_MAX_TOKENS, Math.ceil(size.width / PATCH) * Math.ceil(size.height / PATCH))
}

function isImageData(text: string): boolean {
  if (text.startsWith("data:image/")) return true
  return text.length >= BASE64_MIN && BASE64.test(text.slice(0, 4096))
}

/**
 * Tokens for any value about to be sent or kept in history -- a message, a request body in any
 * dialect: its JSON measured as text, except that an image is counted by `imageTokens`. Images
 * are found by shape, so the one rule covers every wire format (an `image_url` data URL, an
 * Anthropic or Gemini base64 `data`, Ollama's `images` list, the history's own `ImagePart`).
 */
export function estimateValue(value: unknown): number {
  let images = 0
  const text = JSON.stringify(value, (_key, v) => {
    if (typeof v === "string" && isImageData(v)) {
      images += imageTokens(v)
      return ""
    }
    return v
  })
  return estimateTokens(text ?? "") + images
}
