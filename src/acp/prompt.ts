// A prompt that came over ACP, made into what the TUI would have sent for the same thing typed
//: `/name` expanded by the shared command set (session/commands.ts), `@path` mentions
// attached by the same expander as the TUI's (project/attach.ts, same limits), and the blocks a web
// composer adds — images and files — stored the way the TUI stores a pasted image or a dropped
// file: written under the session's attachment directory and attached by path, so a vision model
// sees the image, any other model is told it is there, and the model can read a file again later.
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { basename, extname, join, resolve } from "node:path"
import type { App } from "../app.ts"
import type { AttachmentInfo } from "../bus/index.ts"
import { paths } from "../config/paths.ts"
import type { Mode } from "../config/schema.ts"
import { attachmentsFor } from "../project/attach.ts"
import { realPath } from "../permission/evaluate.ts"
import { protectedPath } from "../permission/hardline.ts"
import { expandHome } from "../config/paths.ts"
import { IMAGE_TYPES } from "../project/image.ts"
import type { ImagePart } from "../provider/types.ts"
import { expandSlash } from "../session/commands.ts"
import { INVALID_PARAMS, RpcError } from "./rpc.ts"

/** Per block, and for the whole prompt, in bytes as decoded. */
export const BLOCK_LIMIT = 10 * 1024 * 1024
export const PROMPT_LIMIT = 25 * 1024 * 1024
const IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp", "image/gif"]

/** Where a session's attachments are kept. */
export const attachmentDir = (sessionId: string) => join(paths.state, "attachments", sessionId.replace(/[^\w.-]/g, "_"))

export function dropAttachments(sessionId: string) {
  rmSync(attachmentDir(sessionId), { recursive: true, force: true })
}

/** A prompt's blocks, read: the text typed, and the files that came with it (not written yet). */
export interface Blocks {
  text: string
  files: { name: string; mimeType: string; data: Buffer }[]
}

function decoded(b64: unknown, what: string): Buffer {
  if (typeof b64 !== "string") throw new RpcError(INVALID_PARAMS, `${what} has no data`)
  // The size is known before decoding: base64 is 4 characters for 3 bytes.
  if (b64.length * 0.75 > BLOCK_LIMIT + 3) throw new RpcError(INVALID_PARAMS, `${what} is larger than ${BLOCK_LIMIT / 1024 / 1024} MB; send a smaller one`)
  return Buffer.from(b64, "base64")
}

const EXT: Record<string, string> = Object.fromEntries(Object.entries(IMAGE_TYPES).map(([ext, mime]) => [mime, ext]))

function safeName(name: string, fallback: string): string {
  const n = basename(name || "").replace(/[^\w.+-]/g, "_").replace(/^\.+/, "").slice(0, 80)
  return n || fallback
}

function nameOfUri(uri: unknown): string {
  if (typeof uri !== "string" || !uri) return ""
  try {
    return decodeURIComponent(new URL(uri, "file:///").pathname.split("/").pop() ?? "")
  } catch {
    return uri.split("/").pop() ?? ""
  }
}

/** The blocks of `session/prompt`: text, image, resource (text or blob), resource_link. */
export function readBlocks(blocks: unknown): Blocks {
  if (!Array.isArray(blocks)) throw new RpcError(INVALID_PARAMS, "prompt must be an array of content blocks")
  const parts: string[] = []
  const files: Blocks["files"] = []
  let total = 0
  const add = (f: Blocks["files"][number]) => {
    if (f.data.length > BLOCK_LIMIT) throw new RpcError(INVALID_PARAMS, `${f.name} is larger than ${BLOCK_LIMIT / 1024 / 1024} MB; send a smaller one`)
    total += f.data.length
    if (total > PROMPT_LIMIT) throw new RpcError(INVALID_PARAMS, `the attachments come to more than ${PROMPT_LIMIT / 1024 / 1024} MB together; send fewer at a time`)
    files.push(f)
  }
  for (const b of blocks as any[]) {
    if (b?.type === "text" && typeof b.text === "string") parts.push(b.text)
    else if (b?.type === "image") {
      const mime = String(b.mimeType ?? "")
      if (!IMAGE_MIMES.includes(mime)) throw new RpcError(INVALID_PARAMS, `an image must be PNG, JPEG, WebP or GIF, not ${mime || "unnamed"}`)
      const n = files.length + 1
      const base = safeName(nameOfUri(b.uri), `image-${n}`)
      add({ name: extname(base) ? base : `${base}${EXT[mime] ?? ".png"}`, mimeType: mime, data: decoded(b.data, "an image") })
    } else if (b?.type === "resource" && b.resource && typeof b.resource === "object") {
      const r = b.resource
      const name = safeName(nameOfUri(r.uri), `file-${files.length + 1}${typeof r.text === "string" ? ".txt" : ""}`)
      if (typeof r.text === "string") add({ name, mimeType: String(r.mimeType ?? "text/plain"), data: Buffer.from(r.text, "utf8") })
      else if (r.blob !== undefined) add({ name, mimeType: String(r.mimeType ?? "application/octet-stream"), data: decoded(r.blob, name) })
    } else if (b?.type === "resource_link" && typeof b.uri === "string") parts.push(`(see ${b.uri})`)
  }
  return { text: parts.join("\n\n").trim(), files }
}

/** What a prompt becomes. */
export type Prepared =
  | { kind: "run"; prompt: string; shown: string; extra: (string | ImagePart)[]; attachments: AttachmentInfo[]; atPaths: string[]; model?: string; mode?: Mode; command?: string }
  | { kind: "action"; name: "compact" | "undo" | "plan"; arg: string }
  | { kind: "message"; name: string; text: string }

/** Whether an @path in a prompt from the web may be attached: where it really is — links
 *  followed — inside the session's project and inside the device's `remote.roots` (when given),
 *  and not a protected path. Anything else stays text: an @ is never a way out of the project. */
export function mayAttach(abs: string, root: string, roots?: string[]): boolean {
  const real = realPath(abs)
  const within = (p: string, dir: string) => {
    const d = realPath(dir)
    return p === d || p.startsWith(d.endsWith("/") ? d : d + "/")
  }
  if (!within(real, root)) return false
  if (roots && !roots.some((r) => within(real, expandHome(r)))) return false
  return !protectedPath(real) && !protectedPath(abs)
}

function mimeOf(path: string): string {
  return IMAGE_TYPES[extname(path).toLowerCase()] ?? (/\.(md|txt|ts|tsx|js|py|json|ya?ml|toml|sh|css|html|rs|go|c|h|java)$/i.test(path) ? "text/plain" : "application/octet-stream")
}

/** The prompt, for `app`'s session `sessionId`: files written, the command expanded, @files read.
 *  Throws INVALID_PARAMS with a sentence for a prompt that cannot be sent. */
export function preparePrompt(app: App, sessionId: string, blocks: unknown, o: { roots?: string[] } = {}): Prepared {
  const { text, files } = readBlocks(blocks)
  if (!text && !files.length) throw new RpcError(INVALID_PARAMS, "the prompt has no text")
  let cmd = expandSlash(app, text)
  // A command that sends no prompt has nowhere to put the files: then the text is only text.
  if (files.length && cmd && cmd.kind !== "prompt") cmd = undefined
  if (cmd?.kind === "action" || cmd?.kind === "message") return cmd
  const ctx = app.engine.o.toolCtx
  const vision = app.engine.model.spec.vision === true
  // The files written first, under names that stay apart from the ones before.
  const saved: { abs: string; info: AttachmentInfo }[] = []
  if (files.length) {
    const dir = attachmentDir(sessionId)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "")
    for (const f of files) {
      // A part of a uuid after the stamp: two uploads of one name (in one prompt, or one second) stay two.
      const abs = resolve(dir, `${stamp}-${crypto.randomUUID().slice(0, 8)}-${f.name}`)
      writeFileSync(abs, f.data, { mode: 0o600 })
      saved.push({ abs, info: { name: f.name, mimeType: f.mimeType, size: f.data.length } })
    }
  }
  const prompt = cmd?.kind === "prompt" ? cmd.prompt : text || `(attached: ${saved.map((s) => s.info.name).join(", ")})`
  const shown = cmd?.kind === "prompt" ? cmd.shown : prompt
  // @files only from what the person typed — never from a command's own text (Working-notes #18).
  // And only what may be read from here: the web is a remote keyboard, not one at this machine.
  const mentioned = attachmentsFor(cmd?.kind === "prompt" ? cmd.attachFrom : text, ctx, vision, (abs) => mayAttach(abs, app.project.root, o.roots))
  const uploaded = saved.flatMap((s) => attachmentsFor(`@${s.abs}`, ctx, vision))
  const extra = [...mentioned, ...uploaded].flatMap((a) => (a.image ? [a.text, a.image] : [a.text]))
  const attachments: AttachmentInfo[] = [...mentioned.map((a) => mentionInfo(a.path, ctx.cwd)), ...saved.map((s) => s.info)]
  return {
    kind: "run",
    prompt,
    shown,
    extra,
    attachments,
    atPaths: mentioned.map((a) => a.path),
    ...(cmd?.kind === "prompt" ? { command: cmd.name, ...(cmd.model ? { model: cmd.model } : {}), ...(cmd.mode ? { mode: cmd.mode } : {}) } : {}),
  }
}

/** An @file, @directory or @image of a prompt, as a chip. */
export function mentionInfo(path: string, cwd: string): AttachmentInfo {
  return { name: path, mimeType: path.endsWith("/") ? "inode/directory" : mimeOf(path), size: sizeOf(resolve(cwd, path)) }
}

function sizeOf(p: string): number {
  try {
    return statSync(p).size
  } catch {
    return 0
  }
}

/** The attachments of a stored user message, from the parts the expander wrote (`<file path=…>`,
 *  `<image path=…>`, `<directory path=…>`), for `_lembas/session/history`. */
export function storedAttachments(texts: string[], cwd: string): AttachmentInfo[] {
  const out: AttachmentInfo[] = []
  for (const t of texts) {
    const m = /^<(file|image|directory) path="([^"]*)"/.exec(t)
    if (!m) continue
    const path = m[2]!
    const abs = resolve(cwd, path)
    // An upload is stored under a name with its time in front; the chip shows the name it came with.
    const name = abs.startsWith(join(paths.state, "attachments") + "/") ? basename(path).replace(/^\d{8}T\d{6}-(?:[0-9a-f]{8}-)?/, "") : path
    out.push({ name, mimeType: m[1] === "directory" ? "inode/directory" : mimeOf(path), size: sizeOf(abs) })
  }
  return out
}
