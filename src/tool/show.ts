// show (harness spec 3.0.0): a file opened in the user's viewer beside the conversation. A terminal
// has no such viewer, so the tool is offered only in a session a client opened over the link and
// only when that client said it can show files (`show: true`, harness/acp.md `_lembas/show`): the
// device reads the file and sends it, since the client cannot reach this disk.
import { statSync } from "node:fs"
import { basename, extname, relative } from "node:path"
import { z } from "zod"
import { described, TOOL_SPECS } from "../harness.ts"
import { absPath, defineTool, readText, showPath, ToolError } from "./tool.ts"

/** The most a file may be to be sent (acp.md: at most 1 MB; a larger one is refused before sending). */
export const SHOW_MAX_BYTES = 1024 * 1024

/** The answer when nothing can be shown (spec `unavailable`), word for word. */
export const SHOW_UNAVAILABLE = TOOL_SPECS.show!.unavailable!

/** What `_lembas/show` carries for one file. */
export interface ShowRequest {
  path: string
  kind: "markdown" | "code" | "text" | "html"
  language?: string
  line?: number
  text: string
}

export type ShowReply = { shown: true } | { shown: false; reason: string }

// A known source extension is code, with its language; the list is the viewer's highlighters.
const LANGUAGES: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx", json: "json", py: "python", rs: "rust", go: "go",
  rb: "ruby", php: "php", java: "java", kt: "kotlin", swift: "swift", c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp",
  sh: "bash", bash: "bash", zsh: "bash", fish: "fish", css: "css", scss: "scss", sql: "sql", yaml: "yaml", yml: "yaml", toml: "toml",
  xml: "xml", svg: "xml", lua: "lua", zig: "zig", dart: "dart", vue: "vue", svelte: "svelte",
}

/** The viewer's kind for a file, by its name (acp.md): `.md` markdown, `.html`/`.htm` html, a known
 *  source extension code, anything else text. */
export function showKind(path: string): { kind: ShowRequest["kind"]; language?: string } {
  const ext = extname(path).slice(1).toLowerCase()
  if (ext === "md" || ext === "markdown") return { kind: "markdown" }
  if (ext === "html" || ext === "htm") return { kind: "html" }
  const language = LANGUAGES[ext] ?? (basename(path) === "Dockerfile" ? "dockerfile" : basename(path) === "Makefile" ? "makefile" : undefined)
  return language ? { kind: "code", language } : { kind: "text" }
}

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
      if (!st.isFile()) throw new ToolError(`${showPath(abs, ctx)} is not a file.`)
      size = st.size
    } catch (e) {
      if (e instanceof ToolError) throw e
      throw new ToolError(`${showPath(abs, ctx)} does not exist. Write it first.`)
    }
    if (size > SHOW_MAX_BYTES) throw new ToolError(`${showPath(abs, ctx)} is ${Math.round(size / 1024)} KB; at most 1 MB can be shown. Give the user the path instead.`)
    const text = await readText(abs)
    if (text.includes("\u0000")) throw new ToolError(`${showPath(abs, ctx)} is not a text file; it cannot be shown. Give the user the path instead.`)
    const rel = relative(ctx.cwd, abs) || basename(abs)
    const reply = await ctx.show({ path: rel, ...showKind(abs), ...(a.line ? { line: a.line } : {}), text }, ctx.callId)
    if (!reply.shown) return { output: `Not shown: ${reply.reason}`, isError: true }
    return { output: `Shown to the user: ${showPath(abs, ctx)}${a.line ? ` at line ${a.line}` : ""}.`, title: showPath(abs, ctx) }
  },
})
