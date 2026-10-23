// Images for vision models: read, size-checked, downscaled when ImageMagick is there.
import { readFileSync, statSync } from "node:fs"
import { extname } from "node:path"
import { imageSize } from "../provider/tokens.ts"
import type { ImagePart } from "../provider/types.ts"

export const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" }
const MAX_BYTES = 3_500_000
const SHRINK_ABOVE_BYTES = 500_000
const MAX_EDGE = 1600
const magick = Bun.which("magick") ?? Bun.which("convert")

export function isImage(path: string): boolean {
  return extname(path).toLowerCase() in IMAGE_TYPES
}

/** The image as a part, or a reason it cannot be one. Anything over 1600 px or 500 KB is shrunk to
 *  1600 px when ImageMagick is there. */
export function loadImage(path: string): ImagePart | string {
  const mime = IMAGE_TYPES[extname(path).toLowerCase()]
  if (!mime) return `${path} is not a supported image (png, jpg, gif, webp)`
  let size: number
  try {
    size = statSync(path).size
  } catch {
    return `${path} does not exist`
  }
  const bytes = readFileSync(path)
  const dims = imageSize(bytes)
  // A screenshot of a large monitor is sent at 1600 px on its longer edge, as the LLeMbas server
  // scales uploads: a model sees no more detail in 2560 px than it is billed tokens for, and a
  // half-megabyte PNG is a slow request for nothing. Without ImageMagick it goes as it is.
  const big = size > SHRINK_ABOVE_BYTES || (dims !== undefined && Math.max(dims.width, dims.height) > MAX_EDGE)
  if (size <= MAX_BYTES && (!big || !magick)) return { type: "image", mime, data: bytes.toString("base64") }
  if (!magick) return `${path} is ${(size / 1e6).toFixed(1)} MB — too large to send, and ImageMagick is not installed to shrink it`
  // The coder named from the extension: ImageMagick otherwise decides by content, and a file named
  // .png that is really SVG or MVG can make it read other files or fetch URLs.
  const coder = { ".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg", ".gif": "gif", ".webp": "webp", ".bmp": "bmp" }[extname(path).toLowerCase()]
  if (!coder) return `${path}: not shrunk — not a PNG, JPEG, GIF, WebP or BMP file`
  const r = Bun.spawnSync([magick, `${coder}:${path}`, "-resize", "1600x1600>", "-quality", "85", "jpeg:-"], { stdout: "pipe", stderr: "pipe" })
  if (r.exitCode !== 0 || r.stdout.length === 0) return `${path} is too large, and shrinking it failed: ${r.stderr.toString().trim()}`
  if (r.stdout.length > MAX_BYTES) return `${path} is still too large after shrinking`
  return { type: "image", mime: "image/jpeg", data: Buffer.from(r.stdout).toString("base64") }
}

/** An image on the clipboard (Wayland or X11), saved to `dest`; undefined when there is none. */
export function clipboardImage(dest: string): string | undefined {
  const tries: string[][] = []
  if (Bun.which("wl-paste")) tries.push(["wl-paste", "--no-newline", "--type", "image/png"])
  if (Bun.which("xclip")) tries.push(["xclip", "-selection", "clipboard", "-t", "image/png", "-o"])
  for (const cmd of tries) {
    const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "ignore" })
    const out = r.stdout
    // A PNG starts with \x89PNG; anything else is text or nothing.
    if (r.exitCode === 0 && out.length > 8 && out[0] === 0x89 && out[1] === 0x50) {
      Bun.write(dest, out)
      return dest
    }
  }
  return undefined
}
