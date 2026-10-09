import { stat } from "node:fs/promises"
import { createTwoFilesPatch } from "diff"
import { z } from "zod"
import { replace } from "./replace-text.ts"
import { absPath, defineTool, readText, showPath, ToolError, type ToolContext } from "./tool.ts"
import { diffStat, guardExisting } from "./write.ts"
import { described } from "../harness.ts"

async function planEdits(a: { path: string; edits: { old: string; new: string; all?: boolean }[] }, ctx: ToolContext) {
  const abs = absPath(a.path, ctx)
  const display = showPath(abs, ctx)
  if (!(await guardExisting(abs, display, ctx))) throw new ToolError(`${display} does not exist. Use write to create it.`)
  const raw = await readText(abs)
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
    const { display, before, after } = await planEdits(a, ctx)
    return createTwoFilesPatch(display, display, before, after, "", "", { context: 3 })
  },
  async run(a, ctx) {
    const { abs, display, before, after, crlf } = await planEdits(a, ctx)
    await Bun.write(abs, crlf ? after.replaceAll("\n", "\r\n") : after)
    ctx.fileStamps.set(abs, (await stat(abs)).mtimeMs)
    const patch = createTwoFilesPatch(display, display, before, after, "", "", { context: 3 })
    const { added, removed } = diffStat(patch)
    return { output: `Edited ${display}: ${a.edits.length} changes (+${added} −${removed}).`, title: `${display} +${added} −${removed}`, meta: { diff: patch } }
  },
})
