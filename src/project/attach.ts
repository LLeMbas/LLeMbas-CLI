// @references in a prompt: `@src/a.ts`, `@src/a.ts#10-20`, `@docs/`. Each one that exists is
// attached to the message the model gets — files line-numbered exactly as the read tool shows
// them, and counted as read so the model may edit them at once. The prompt text is unchanged.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import type { ImagePart } from "../provider/types.ts"
import type { ToolContext } from "../tool/tool.ts"
import { isImage, loadImage } from "./image.ts"

// A space or a # in a name is written with a backslash before it (`@my\ notes.md`,
// `@a\#b.md`): an unescaped # starts a line range.
const REF = /(?:^|\s)@((?:\\[ #]|[^\s#])+)(?:#(\d+)(?:-(\d+))?)?/g

/** A path as an @ mention writes it: spaces and # escaped, so it reads back as the same path. */
export function escapeMention(path: string): string {
  return path.replace(/([ #])/g, "\\$1")
}
const MAX_LINES = 2000
const MAX_BYTES = 200_000

export interface Attachment {
  path: string
  /** Text for the model — a file, a listing, or why an image was not attached. */
  text: string
  image?: ImagePart
}

/** `allow`: which paths may be read at all (over ACP: inside the session and the device's
 *  roots, nothing protected); a mention it refuses stays plain text, as one that does not exist. */
export function attachmentsFor(text: string, ctx: Pick<ToolContext, "root" | "cwd" | "readFiles" | "fileStamps">, vision = false, allow?: (abs: string) => boolean): Attachment[] {
  const out: Attachment[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(REF)) {
    const rel = m[1]!.replace(/\\([ #])/g, "$1").replace(/[.,;:!?)]+$/, "")
    const abs = resolve(ctx.cwd, rel)
    if (allow && !allow(abs)) continue
    const key = `${abs}#${m[2] ?? ""}-${m[3] ?? ""}`
    if (seen.has(key)) continue
    seen.add(key)
    let st
    try {
      st = statSync(abs)
    } catch {
      continue // not a path: an email address, a handle — leave it as text
    }
    if (st.isDirectory()) {
      const entries = readdirSync(abs, { withFileTypes: true })
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort()
      out.push({ path: rel, text: `<directory path="${rel}">\n${entries.join("\n")}\n</directory>` })
      continue
    }
    if (isImage(abs)) {
      if (!vision) {
        out.push({ path: rel, text: `<image path="${rel}">(not attached: this model has no vision)</image>` })
        continue
      }
      const img = loadImage(abs)
      out.push(typeof img === "string" ? { path: rel, text: `<image path="${rel}">(not attached: ${img})</image>` } : { path: rel, text: `<image path="${rel}"/>`, image: img })
      continue
    }
    if (st.size > MAX_BYTES && !m[2]) {
      out.push({ path: rel, text: `<file path="${rel}">\n(${st.size} bytes — too large to attach whole; read it in parts, or reference a range like @${rel}#1-200)\n</file>` })
      continue
    }
    const raw = readFileSync(abs)
    if (raw.subarray(0, 8192).includes(0)) {
      out.push({ path: rel, text: `<file path="${rel}">\n(binary file, ${st.size} bytes)\n</file>` })
      continue
    }
    const lines = raw.toString("utf8").split("\n")
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop()
    const from = Math.max(1, Number(m[2] ?? 1))
    const to = Math.min(lines.length, Number(m[3] ?? (m[2] ? m[2] : from + MAX_LINES - 1)))
    const body = lines.slice(from - 1, to).map((l, i) => `${from + i}: ${l}`).join("\n")
    const range = m[2] ? ` lines="${from}-${to}"` : ""
    const more = !m[2] && lines.length > to ? `\n(${lines.length - to} more lines — read with offset ${to + 1})` : ""
    out.push({ path: rel, text: `<file path="${rel}"${range}>\n${body}${more}\n</file>` })
    if (!m[2]) {
      ctx.readFiles.add(abs)
      ctx.fileStamps.set(abs, st.mtimeMs)
    }
  }
  return out
}

/** Absolute paths for attachments, for frecency. */
export function attachedPaths(atts: Attachment[], root: string): string[] {
  return atts.map((a) => a.path.replace(/\/$/, "")).map((p) => (p.startsWith("/") ? p : join(root, p)))
}
