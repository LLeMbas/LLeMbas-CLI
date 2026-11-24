import { stat } from "node:fs/promises"
import { createTwoFilesPatch } from "diff"
import { z } from "zod"
import { straySkillNote } from "../skill/index.ts"
import { absPath, defineTool, showPath, ToolError, type ToolContext } from "./tool.ts"
import { described } from "../harness.ts"
import { hunks, lineCount, sha256 } from "../session/results.ts"
import { changedInEditor, fileText, noteChanges, putText } from "./buffers.ts"

/** Refuse to overwrite a file the model has not read, or one changed on disk since it was read. The
 *  texts are the spec's (filesystem.md, *Errors*), with the absolute path. */
export async function guardExisting(abs: string, ctx: ToolContext): Promise<boolean> {
  const st = await stat(abs).catch(() => undefined)
  if (!st) return false
  if (st.isDirectory()) throw new ToolError(`Is a directory: ${abs}`)
  if (!st.isFile()) throw new ToolError(`${abs} is not a regular file`)
  if (!ctx.readFiles.has(abs)) throw new ToolError(`${abs} exists and has not been read in this session. Read it first.`)
  const seen = ctx.fileStamps.get(abs)
  // A file the session reads through the client's editor is judged by its text there (below): its
  // change time on disk moves whenever the editor saves, which is no change the model missed.
  if (!ctx.editorSeen?.has(abs) && seen !== undefined && st.mtimeMs > seen + 1) throw new ToolError(`${abs} changed since you last read it. Read it again before changing it.`)
  // The same for text the client's editor holds unsaved: "read it first" follows the text.
  if (await changedInEditor(abs, ctx)) throw new ToolError(`${abs} changed since you last read it. Read it again before changing it.`)
  return true
}

/** A file's change time now — or this moment, for one a client's editor holds and has not put on
 *  disk yet. */
export async function stampOf(abs: string): Promise<number> {
  return (await stat(abs).catch(() => undefined))?.mtimeMs ?? Date.now()
}

export function diffStat(patch: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const l of patch.split("\n")) {
    if (l.startsWith("+") && !l.startsWith("+++")) added++
    else if (l.startsWith("-") && !l.startsWith("---")) removed++
  }
  return { added, removed }
}

export const writeTool = defineTool({
  ...described("write"),
  access: "edit",
  schema: z.object({
    path: z.string(),
    content: z.string(),
  }),
  permission: (a, ctx) => {
    const abs = absPath(a.path, ctx)
    return { permission: "edit", class: "write", patterns: [showPath(abs, ctx)], paths: [abs] }
  },
  async preview(a, ctx) {
    const abs = absPath(a.path, ctx)
    const display = showPath(abs, ctx)
    const existed = await guardExisting(abs, ctx)
    const before = existed ? await fileText(abs, ctx) : ""
    return { diff: createTwoFilesPatch(display, display, before, a.content, "", "", { context: 3 }), files: [{ path: abs, oldText: existed ? before : null, newText: a.content }] }
  },
  async run(a, ctx) {
    const abs = absPath(a.path, ctx)
    const display = showPath(abs, ctx)
    const existed = await guardExisting(abs, ctx)
    const before = existed ? await fileText(abs, ctx) : ""
    await putText(abs, a.content, ctx)
    ctx.readFiles.add(abs)
    ctx.fileStamps.set(abs, await stampOf(abs))
    const patch = createTwoFilesPatch(display, display, before, a.content, "", "", { context: 3 })
    const { added, removed } = diffStat(patch)
    noteChanges(ctx, [{ path: abs, oldText: existed ? before : null, newText: a.content }])
    const note = straySkillNote([abs], ctx)
    const sha = sha256(a.content)
    return {
      output: (existed ? `Replaced ${display} (+${added} −${removed}).` : `Created ${display} (${a.content.split("\n").length} lines).`) + note,
      title: `${display} +${added} −${removed}`,
      meta: { diff: patch },
      // Over an existing file the diff; a new one is said in a line — the model wrote it and has it.
      context: { kind: "edit", files: [existed ? { path: a.path, sha, hunks: hunks(before, a.content) } : { path: a.path, sha, created: lineCount(a.content) }], ...(note ? { note } : {}) },
    }
  },
})
