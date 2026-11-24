// show (harness spec 3.0.0): a file opened in the user's viewer beside the conversation. A terminal
// has no such viewer, so the tool is offered only in a session a client opened over the link and
// only when that client said it can show files (`show: true`, harness/acp.md `_lembas/show`): the
// device reads the file and sends it, since the client cannot reach this disk.
import { closeSync, openSync, readSync, statSync } from "node:fs"
import { basename, extname, relative } from "node:path"
import { z } from "zod"
import { described, LOOP, TOOL_SPECS } from "../harness.ts"
import { absPath, defineTool, readText, showPath, ToolError } from "./tool.ts"

/** The most a text file may be to be sent (acp.md: at most 1 MB; a larger one is refused before sending). */
export const SHOW_MAX_BYTES = LOOP.files.show.text_max_bytes
/** The most a file that is not text may be (spec 3.11.0, capability `media`). */
export const SHOW_MEDIA_MAX_BYTES = LOOP.files.show.media_max_bytes

/** The answer when nothing can be shown (spec `unavailable`), word for word. */
export const SHOW_UNAVAILABLE = TOOL_SPECS.show!.unavailable!

export type TextKind = "markdown" | "code" | "text" | "html" | "table" | "svg" | "notebook"
export type MediaKind = "image" | "pdf" | "audio" | "video" | "model3d" | "archive" | "binary"

/** What `_lembas/show` carries for one file: a text file with its content, or (spec 3.11.0) a file
 *  that is not text, which the client fetches — `file` is where it is here, for whoever sends the
 *  request to make a handle from; it never leaves this process. */
export type ShowRequest =
  | { path: string; kind: TextKind; language?: string; line?: number; text: string }
  | { path: string; kind: MediaKind; mimeType: string; size: number; file: string }

export type ShowReply = { shown: true } | { shown: false; reason: string }

// A known source extension is code, with its language; the list is the viewer's highlighters.
const LANGUAGES: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx", json: "json", py: "python", rs: "rust", go: "go",
  rb: "ruby", php: "php", java: "java", kt: "kotlin", swift: "swift", c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp",
  sh: "bash", bash: "bash", zsh: "bash", fish: "fish", css: "css", scss: "scss", sql: "sql", yaml: "yaml", yml: "yaml", toml: "toml",
  xml: "xml", svg: "xml", lua: "lua", zig: "zig", dart: "dart", vue: "vue", svelte: "svelte",
}

// Files that are not text, by extension: the kind a client that shows media is told, and the type.
const MEDIA: Record<string, [MediaKind, string]> = {
  png: ["image", "image/png"], jpg: ["image", "image/jpeg"], jpeg: ["image", "image/jpeg"], gif: ["image", "image/gif"], webp: ["image", "image/webp"], avif: ["image", "image/avif"],
  pdf: ["pdf", "application/pdf"],
  mp3: ["audio", "audio/mpeg"], wav: ["audio", "audio/wav"], ogg: ["audio", "audio/ogg"], oga: ["audio", "audio/ogg"], flac: ["audio", "audio/flac"], m4a: ["audio", "audio/mp4"], aac: ["audio", "audio/aac"], opus: ["audio", "audio/opus"],
  mp4: ["video", "video/mp4"], m4v: ["video", "video/mp4"], webm: ["video", "video/webm"], mkv: ["video", "video/x-matroska"], mov: ["video", "video/quicktime"], avi: ["video", "video/x-msvideo"],
  glb: ["model3d", "model/gltf-binary"], gltf: ["model3d", "model/gltf+json"], obj: ["model3d", "model/obj"], stl: ["model3d", "model/stl"],
  zip: ["archive", "application/zip"], tar: ["archive", "application/x-tar"], gz: ["archive", "application/gzip"], tgz: ["archive", "application/gzip"], bz2: ["archive", "application/x-bzip2"], xz: ["archive", "application/x-xz"], "7z": ["archive", "application/x-7z-compressed"],
}
// Text kinds a client that shows media is told by name; any other client gets them as text or code.
const NAMED_TEXT: Record<string, TextKind> = { csv: "table", tsv: "table", svg: "svg", ipynb: "notebook" }

/** The viewer's kind for a file, by its name (acp.md): `.md` markdown, `.html`/`.htm` html, a known
 *  source extension code, anything else text. */
export function showKind(path: string): { kind: "markdown" | "code" | "text" | "html"; language?: string } {
  const ext = extname(path).slice(1).toLowerCase()
  if (ext === "md" || ext === "markdown") return { kind: "markdown" }
  if (ext === "html" || ext === "htm") return { kind: "html" }
  const language = LANGUAGES[ext] ?? (basename(path) === "Dockerfile" ? "dockerfile" : basename(path) === "Makefile" ? "makefile" : undefined)
  return language ? { kind: "code", language } : { kind: "text" }
}

export type ShowPlan =
  | { kind: TextKind; language?: string; via: "text" }
  | { kind: MediaKind; mimeType: string; via: "handle" }
  | { refused: "not_text" | "too_large" }

/** What the show tool sends for a file (conformance `show`): by its name, whether its bytes are
 *  text, its size, and whether the client said it shows media. The kind is a reading of the name —
 *  a hint; the client decides from the bytes. */
export function showPlan(o: { name: string; media: boolean; text: boolean; size: number }): ShowPlan {
  const ext = extname(o.name).slice(1).toLowerCase()
  if (!o.media) {
    if (!o.text) return { refused: "not_text" }
    if (o.size > SHOW_MAX_BYTES) return { refused: "too_large" }
    return { ...showKind(o.name), via: "text" }
  }
  const media = MEDIA[ext]
  if (o.text && !media) {
    if (o.size > SHOW_MAX_BYTES) return { refused: "too_large" }
    const named = NAMED_TEXT[ext]
    return named ? { kind: named, via: "text" } : { ...showKind(o.name), via: "text" }
  }
  if (o.size > SHOW_MEDIA_MAX_BYTES) return { refused: "too_large" }
  return { kind: media?.[0] ?? "binary", mimeType: media?.[1] ?? "application/octet-stream", via: "handle" }
}

/** Whether a file's first bytes are text (no NUL among them), as the read tool judges it. */
function looksText(abs: string): boolean {
  const buf = Buffer.alloc(8192)
  const fd = openSync(abs, "r")
  try {
    return !buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).includes(0)
  } finally {
    closeSync(fd)
  }
}

const sizeWords = (n: number) => (n >= 1024 * 1024 ? `${Math.round(n / 1024 / 1024)} MB` : `${Math.round(n / 1024)} KB`)

export const showTool = defineTool({
  ...described("show"),
  access: "show",
  requires: "display",
  schema: z.object({ path: z.string(), line: z.number().int().min(1).optional() }),
  permission: (a, ctx) => {
    const abs = absPath(a.path, ctx)
    return { permission: "show", class: "interact", patterns: [showPath(abs, ctx)], paths: [abs] }
  },
  async run(a, ctx) {
    // Offered with a display; one that went away since answers the spec's sentence.
    if (!ctx.show) return { output: SHOW_UNAVAILABLE, isError: true }
    const abs = absPath(a.path, ctx)
    let size: number
    try {
      const st = statSync(abs)
      if (!st.isFile()) throw new ToolError(st.isDirectory() ? `Is a directory: ${abs}` : `${showPath(abs, ctx)} is not a file.`)
      size = st.size
    } catch (e) {
      if (e instanceof ToolError) throw e
      throw new ToolError(`No such file or directory: ${abs}`)
    }
    const media = ctx.showsMedia === true
    let text = looksText(abs)
    const shown = showPath(abs, ctx)
    const rel = relative(ctx.root, abs) || basename(abs)
    let plan = showPlan({ name: abs, media, text, size })
    let content: string | undefined
    if ("via" in plan && plan.via === "text") {
      // The whole of it is looked at, not only its start: a NUL further in is not text either.
      content = await readText(abs)
      if (content.includes("\u0000")) (text = false), (plan = showPlan({ name: abs, media, text, size }))
    }
    if ("refused" in plan) {
      if (plan.refused === "not_text") throw new ToolError(`${shown} is not a text file; it cannot be shown. Give the user the path instead.`)
      throw new ToolError(`${shown} is ${sizeWords(size)}; at most ${sizeWords(text && !(extname(abs).slice(1).toLowerCase() in MEDIA) ? SHOW_MAX_BYTES : media ? SHOW_MEDIA_MAX_BYTES : SHOW_MAX_BYTES)} can be shown. Give the user the path instead.`)
    }
    const reply =
      plan.via === "text"
        ? await ctx.show({ path: rel, kind: plan.kind, ...(plan.language ? { language: plan.language } : {}), ...(a.line ? { line: a.line } : {}), text: content! }, ctx.callId)
        : await ctx.show({ path: rel, kind: plan.kind, mimeType: plan.mimeType, size, file: abs }, ctx.callId)
    if (!reply.shown) return { output: `Not shown: ${reply.reason}`, isError: true }
    return { output: `Shown to the user: ${shown}${a.line && plan.via === "text" ? ` at line ${a.line}` : ""}.`, title: shown }
  },
})
