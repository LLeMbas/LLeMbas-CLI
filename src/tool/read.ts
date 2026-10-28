import { existsSync, readFileSync, realpathSync } from "node:fs"
import { unsafeProjectFile } from "../project/safe.ts"
import { readdir, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { z } from "zod"
import { absPath, defineTool, showPath, ToolError } from "./tool.ts"
import { described } from "../harness.ts"
import { byListing } from "./search.ts"
import { sha256 } from "../session/results.ts"

const MAX_LINES = 2000
const MAX_LINE = 2000

export const readTool = defineTool({
  ...described("read"),
  access: "read",
  schema: z.object({
    path: z.string(),
    offset: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).optional(),
  }),
  permission: (a, ctx) => {
    const abs = absPath(a.path, ctx)
    return { permission: "read", class: "read", patterns: [showPath(abs, ctx)], paths: [abs] }
  },
  async run(a, ctx) {
    const abs = absPath(a.path, ctx)
    const st = await stat(abs).catch(() => undefined)
    if (!st) throw new ToolError(`No such file or directory: ${abs}`)
    if (st.isDirectory()) {
      const entries = await readdir(abs, { withFileTypes: true })
      const lines = entries
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort(byListing)
      return { output: lines.join("\n") || "(empty directory)", title: `${showPath(abs, ctx)}/ · ${lines.length} entries` }
    }
    const file = Bun.file(abs)
    const bytes = new Uint8Array(await file.slice(0, 8192).arrayBuffer())
    if (bytes.includes(0)) throw new ToolError(`${a.path} is a binary file (${st.size} bytes)`)
    // Read whole, so only up to a size that fits in memory comfortably; past it, grep or bash.
    if (st.size > 50_000_000) throw new ToolError(`${a.path} is ${Math.round(st.size / 1e6)} MB — too large to read whole; search it with grep, or look at a part with bash (head, tail, sed -n)`)
    const raw = await file.bytes()
    const text = new TextDecoder().decode(raw)
    const { body, from, to, of } = readBody(text, a.offset, a.limit)
    ctx.readFiles.add(abs)
    ctx.fileStamps.set(abs, st.mtimeMs)
    // For its insertion (session/results.ts): the lines shown and the content's hash, by which an
    // unchanged re-read becomes a stub.
    const context = { kind: "read" as const, path: a.path, key: abs, sha: sha256(raw), from, to, of }
    return { output: body + nearbyInstructions(abs, ctx), title: `${showPath(abs, ctx)} · ${from}–${to} of ${of}`, meta: { path: showPath(abs, ctx), from, to, of }, context }
  },
})

/** The read tool's body for a file's text: numbered lines from `offset` (1-indexed), at most
 *  `limit` (2000), a line longer than 2000 characters cut, and the note when lines remain; "(empty
 *  file)" for an empty one. `from`-`to` of `of`: the lines shown (conformance `context`). */
export function readBody(text: string, offset?: number, limit?: number): { body: string; from: number; to: number; of: number } {
  const all = text.split("\n")
  if (all.length > 1 && all[all.length - 1] === "") all.pop()
  if (all.length === 1 && all[0] === "") all.pop()
  const start = (offset ?? 1) - 1
  const end = Math.min(all.length, start + (limit ?? MAX_LINES))
  const lines = all
    .slice(start, end)
    .map((l, i) => `${start + i + 1}: ${l.length > MAX_LINE ? l.slice(0, MAX_LINE) + " […cut]" : l}`)
    .join("\n")
  const more = end < all.length ? `\n\n(${all.length - end} more lines — read again with offset ${end + 1})` : ""
  return { body: (all.length === 0 ? "(empty file)" : lines) + more, from: start + 1, to: end, of: all.length }
}

/** OpenCode's "nearby instructions": reading a file under a directory with its own AGENTS.md or
 *  CLAUDE.md hands the model that file, once per session. The root's is already in the prompt. */
function nearbyInstructions(file: string, ctx: import("./tool.ts").ToolContext): string {
  if (!ctx.instructionsSeen || !file.startsWith(ctx.root + "/")) return ""
  const out: string[] = []
  for (let dir = dirname(file); dir.startsWith(ctx.root) && dir !== ctx.root; dir = dirname(dir)) {
    const hit = ["AGENTS.md", "CLAUDE.md"].map((f) => join(dir, f)).find((f) => existsSync(f))
    if (!hit || ctx.instructionsSeen.has(hit)) continue
    ctx.instructionsSeen.add(hit)
    // Only a file really inside the project: one committed as a link could point at anything.
    if (unsafeProjectFile(hit, ctx.root)) continue
    let text: string
    try {
      const real = realpathSync(hit)
      const root = realpathSync(ctx.root)
      if (!real.startsWith(`${root}/`)) continue
      text = readFileSync(real, "utf8").trim().slice(0, 20_000)
    } catch {
      continue
    }
    out.push(`\n\n<instructions from="${showPath(hit, ctx)}">\nThis directory has its own instructions; they apply to work under it.\n${text}\n</instructions>`)
  }
  return out.reverse().join("")
}
