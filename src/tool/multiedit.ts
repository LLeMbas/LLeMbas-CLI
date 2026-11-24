import { createTwoFilesPatch } from "diff"
import { z } from "zod"
import { replace } from "./replace-text.ts"
import { absPath, defineTool, showPath, ToolError, type ToolContext } from "./tool.ts"
import { diffStat, guardExisting, stampOf } from "./write.ts"
import { fileText, noteChanges, putText } from "./buffers.ts"
import { described } from "../harness.ts"
import { hunks, sha256 } from "../session/results.ts"

async function planEdits(a: { path: string; edits: { old: string; new: string; all?: boolean }[] }, ctx: ToolContext) {
  const abs = absPath(a.path, ctx)
  const display = showPath(abs, ctx)
  if (!(await guardExisting(abs, ctx))) throw new ToolError(`No such file or directory: ${abs}`)
  const raw = await fileText(abs, ctx)
  const crlf = raw.includes("\r\n")
  const before = crlf ? raw.replaceAll("\r\n", "\n") : raw
  let after = before
  for (const [i, e] of a.edits.entries()) {
    try {
      after = replace(after, e.old.replaceAll("\r\n", "\n"), e.new.replaceAll("\r\n", "\n"), e.all ?? false)
    } catch (err) {
      throw new ToolError(`${display}: step ${i + 1} of ${a.edits.length} failed — ${(err as Error).message} Nothing was changed.`)
    }
  }
  return { abs, display, before, after, crlf }
}

export const multieditTool = defineTool({
  ...described("multiedit"),
  access: "edit",
  schema: z.object({
    path: z.string(),
    edits: z.array(z.object({ old: z.string(), new: z.string(), all: z.boolean().optional() })).min(1).max(50),
  }),
  permission: (a, ctx) => {
    const abs = absPath(a.path, ctx)
    return { permission: "edit", class: "write", patterns: [showPath(abs, ctx)], paths: [abs] }
  },
  async preview(a, ctx) {
    const { abs, display, before, after, crlf } = await planEdits(a, ctx)
    const nl = (t: string) => (crlf ? t.replaceAll("\n", "\r\n") : t)
    return { diff: createTwoFilesPatch(display, display, before, after, "", "", { context: 3 }), files: [{ path: abs, oldText: nl(before), newText: nl(after) }] }
  },
  async run(a, ctx) {
    const { abs, display, before, after, crlf } = await planEdits(a, ctx)
    const written = crlf ? after.replaceAll("\n", "\r\n") : after
    await putText(abs, written, ctx)
    ctx.fileStamps.set(abs, await stampOf(abs))
    const patch = createTwoFilesPatch(display, display, before, after, "", "", { context: 3 })
    const { added, removed } = diffStat(patch)
    noteChanges(ctx, [{ path: abs, oldText: crlf ? before.replaceAll("\n", "\r\n") : before, newText: written }])
    return { output: `Edited ${display}: ${a.edits.length} changes (+${added} −${removed}).`, title: `${display} +${added} −${removed}`, meta: { diff: patch }, context: { kind: "edit", files: [{ path: a.path, sha: sha256(written), hunks: hunks(before, after) }] } }
  },
})
