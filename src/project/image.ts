// Images for vision models: read, size-checked, downscaled when ImageMagick is there.
import { readFileSync, statSync } from "node:fs"
import { extname } from "node:path"
import type { ImagePart } from "../provider/types.ts"

export const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" }
const MAX_BYTES = 3_500_000
const magick = Bun.which("magick") ?? Bun.which("convert")

export function isImage(path: string): boolean {
  return extname(path).toLowerCase() in IMAGE_TYPES
}

/** The image as a part, or a reason it cannot be one. Large ones are shrunk to 1600 px if possible. */
export function loadImage(path: string): ImagePart | string {
  const mime = IMAGE_TYPES[extname(path).toLowerCase()]
  if (!mime) return `${path} is not a supported image (png, jpg, gif, webp)`
  let size: number
  try {
    size = statSync(path).size
  } catch {
    return `${path} does not exist`
  }
  if (size <= MAX_BYTES) return { type: "image", mime, data: readFileSync(path).toString("base64") }
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
