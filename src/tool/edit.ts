import { stat } from "node:fs/promises"
import { createTwoFilesPatch } from "diff"
import { z } from "zod"
import { replace } from "./replace-text.ts"
import { absPath, defineTool, readText, showPath, ToolError, type ToolContext } from "./tool.ts"
import { diffStat, guardExisting } from "./write.ts"
import { described } from "../harness.ts"

async function planEdit(a: { path: string; old: string; new: string; all?: boolean }, ctx: ToolContext) {
  const abs = absPath(a.path, ctx)
  const display = showPath(abs, ctx)
  if (!(await guardExisting(abs, display, ctx))) throw new ToolError(`${display} does not exist. Use write to create it.`)
  const raw = await readText(abs)
  const crlf = raw.includes("\r\n")
  const before = crlf ? raw.replaceAll("\r\n", "\n") : raw
  try {
    return { abs, display, before, crlf, after: replace(before, a.old.replaceAll("\r\n", "\n"), a.new.replaceAll("\r\n", "\n"), a.all ?? false) }
  } catch (e) {
    throw new ToolError(`${display}: ${(e as Error).message}`)
  }
}

export const editTool = defineTool({
  ...described("edit"),
  access: "edit",
  schema: z.object({
    path: z.string(),
    old: z.string(),
    new: z.string(),
    all: z.boolean().optional(),
  }),
  permission: (a, ctx) => {
    const abs = absPath(a.path, ctx)
    return { permission: "edit", class: "write", patterns: [showPath(abs, ctx)], paths: [abs] }
  },
  async preview(a, ctx) {
    const { display, before, after } = await planEdit(a, ctx)
    return createTwoFilesPatch(display, display, before, after, "", "", { context: 3 })
  },
  async run(a, ctx) {
    const { abs, display, before, after, crlf } = await planEdit(a, ctx)
    await Bun.write(abs, crlf ? after.replaceAll("\n", "\r\n") : after)
    ctx.fileStamps.set(abs, (await stat(abs)).mtimeMs)
    const patch = createTwoFilesPatch(display, display, before, after, "", "", { context: 3 })
    const { added, removed } = diffStat(patch)
    return { output: `Edited ${display} (+${added} −${removed}).`, title: `${display} +${added} −${removed}`, meta: { diff: patch } }
  },
})
