// Images for vision models: read, size-checked, downscaled when ImageMagick is there.
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { extname, join } from "node:path"
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

/** What a pasted or clipboard image may be, in the order asked for. */
export const CLIPBOARD_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const
const EXT_OF: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif" }
/** The most a pasted image may be before it is saved (loadImage shrinks, or refuses, when it is sent). */
export const MAX_PASTE_BYTES = 20_000_000

/** What kind of image these bytes are, by their signature — never by what they were called. */
export function sniffImage(b: Uint8Array): (typeof CLIPBOARD_TYPES)[number] | undefined {
  if (b.length < 12) return undefined
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png"
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg"
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif"
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp"
  return undefined
}

let saved = 0
/** Save pasted image bytes under `dir` (made if missing), named by time and kind. */
export function savePastedImage(dir: string, bytes: Uint8Array, mime: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, `paste-${Date.now()}-${++saved}${EXT_OF[mime] ?? ".png"}`)
  writeFileSync(path, bytes, { mode: 0o600 })
  return path
}

/** Pasted text that is an image: a `data:image/(png|jpeg|webp|gif);base64,…` URL, or bare base64
 *  that decodes to an image's signature — the way an image gets through a terminal that cannot
 *  hand over a clipboard image (over SSH). The bytes, a reason it is refused, or undefined when
 *  the text is not an image at all. */
export function imageFromText(text: string): { mime: string; bytes: Uint8Array } | { error: string } | undefined {
  let t = text.trim()
  if (t.length < 24) return undefined
  const url = /^data:image\/(?:png|jpeg|webp|gif);base64,/i.exec(t.slice(0, 40))
  if (url) t = t.slice(url[0].length)
  // Bare base64 is looked at only when it starts as an image would: PNG, JPEG, GIF, WebP.
  else if (!/^(?:iVBORw0KGgo|\/9j\/|R0lGOD|UklGR)/.test(t)) return undefined
  // Line breaks are a terminal's or a mail program's; anything else is not base64.
  if (/[^A-Za-z0-9+/=\s]/.test(t)) return undefined
  t = t.replace(/\s+/g, "")
  if (Math.floor((t.length * 3) / 4) > MAX_PASTE_BYTES) return { error: `the pasted image is over ${MAX_PASTE_BYTES / 1e6} MB — copy the file over and use @path` }
  const bytes = new Uint8Array(Buffer.from(t, "base64"))
  const mime = sniffImage(bytes)
  if (!mime) return url ? { error: "the pasted data URL is not a PNG, JPEG, WebP or GIF image" } : undefined
  return { mime, bytes }
}

export type ClipboardImage = { status: "read"; mime: string; bytes: Uint8Array } | { status: "empty" | "unsupported" | "too-large" }

type Env = Record<string, string | undefined>

/** The clipboard programs that can hand over an image here, in order: Wayland's, then X11's (the
 *  local display, or the one `ssh -X` forwards). */
export function clipboardCommands(env: Env = process.env, which: (cmd: string) => string | null = Bun.which): ((type: string) => string[])[] {
  const out: ((type: string) => string[])[] = []
  if (env.WAYLAND_DISPLAY && which("wl-paste")) out.push((type) => ["wl-paste", "--no-newline", "--type", type])
  if (env.DISPLAY && which("xclip")) out.push((type) => ["xclip", "-selection", "clipboard", "-t", type, "-o"])
  return out
}

async function runFor(cmd: string[], timeoutMs: number): Promise<Uint8Array | undefined> {
  try {
    const p = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: process.env })
    const timer = setTimeout(() => p.kill(), timeoutMs)
    try {
      const out = new Uint8Array(await new Response(p.stdout).arrayBuffer())
      return (await p.exited) === 0 ? out : undefined
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return undefined
  }
}

/** The fallback: ask wl-paste or xclip for each kind of image in turn. */
async function clipboardImageByProgram(o: { env?: Env; which?: (cmd: string) => string | null; timeoutMs: number }): Promise<ClipboardImage> {
  const commands = clipboardCommands(o.env, o.which)
  if (!commands.length) return { status: "unsupported" }
  for (const command of commands) {
    for (const type of CLIPBOARD_TYPES) {
      const out = await runFor(command(type), o.timeoutMs)
      if (!out || !sniffImage(out)) continue
      if (out.length > MAX_PASTE_BYTES) return { status: "too-large" }
      return { status: "read", mime: sniffImage(out)!, bytes: out }
    }
  }
  return { status: "empty" }
}

export interface HostClipboardLike {
  read(o: { preferredTypes: readonly [string, ...string[]] }): Promise<{ status: string; representation?: { mimeType: string; bytes: Uint8Array } }>
  dispose(): Promise<void>
}

/** An image on this machine's clipboard — PNG, JPEG, WebP or GIF; Linux (Wayland, X11), macOS and
 *  Windows through OpenTUI's host clipboard, with wl-paste / xclip where that is not available.
 *  Never blocks: everything is awaited. `host`: the clipboard to ask (tests); by default OpenTUI's. */
export async function clipboardImage(o: { env?: Env; which?: (cmd: string) => string | null; timeoutMs?: number; host?: () => HostClipboardLike | Promise<HostClipboardLike> } = {}): Promise<ClipboardImage> {
  const timeoutMs = o.timeoutMs ?? 3000
  let host: HostClipboardLike | undefined
  let hostEmpty = false
  try {
    host = await (o.host ?? (async () => (await import("@opentui/core")).createHostClipboard({ timeoutMs, maxReadBytes: MAX_PASTE_BYTES }) as unknown as HostClipboardLike))()
    const r = await host.read({ preferredTypes: CLIPBOARD_TYPES })
    if (r.status === "read" && r.representation) {
      // Believed by its bytes: a clipboard may call anything image/png.
      const mime = sniffImage(r.representation.bytes)
      if (mime) return { status: "read", mime, bytes: r.representation.bytes }
    }
    if (r.status === "limit-exceeded") return { status: "too-large" }
    // Something that is not an image (text called image/png) is no image on the clipboard.
    hostEmpty = r.status === "empty" || r.status === "read"
  } catch {
    // No host clipboard in this build or on this machine: the programs below.
  } finally {
    void host?.dispose().catch(() => {})
  }
  // The programs are asked as well when the host clipboard found nothing: over `ssh -X` the
  // clipboard that matters is the forwarded X display's.
  const byProgram = await clipboardImageByProgram({ env: o.env, which: o.which, timeoutMs })
  return byProgram.status === "unsupported" && hostEmpty ? { status: "empty" } : byProgram
}

/** Pasted images are copies: those older than `days` go when the TUI starts. */
export function cleanPastedImages(dir: string, days = 7, now = Date.now()): number {
  let gone = 0
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  for (const name of names) {
    if (!/^paste-[\w-]+\.(png|jpe?g|webp|gif)$/.test(name)) continue
    const path = join(dir, name)
    try {
      if (now - statSync(path).mtimeMs > days * 86_400_000) {
        rmSync(path)
        gone++
      }
    } catch {}
  }
  return gone
}
