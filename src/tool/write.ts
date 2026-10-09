import { mkdir, stat } from "node:fs/promises"
import { dirname } from "node:path"
import { createTwoFilesPatch } from "diff"
import { z } from "zod"
import { straySkillNote } from "../skill/index.ts"
import { absPath, defineTool, showPath, ToolError, type ToolContext } from "./tool.ts"
import { described } from "../harness.ts"

/** Refuse to overwrite a file the model has not read, or one changed on disk since it was read. */
export async function guardExisting(abs: string, display: string, ctx: ToolContext): Promise<boolean> {
  const st = await stat(abs).catch(() => undefined)
  if (!st) return false
  if (!st.isFile()) throw new ToolError(`${display} is not a regular file`)
  if (!ctx.readFiles.has(abs)) throw new ToolError(`${display} exists and has not been read in this session. Read it first.`)
  const seen = ctx.fileStamps.get(abs)
  if (seen !== undefined && st.mtimeMs > seen + 1)
    throw new ToolError(`${display} changed on disk since you last read it. Read it again before changing it.`)
  return true
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
    const before = (await guardExisting(abs, display, ctx)) ? await Bun.file(abs).text() : ""
    return createTwoFilesPatch(display, display, before, a.content, "", "", { context: 3 })
  },
  async run(a, ctx) {
    const abs = absPath(a.path, ctx)
    const display = showPath(abs, ctx)
    const existed = await guardExisting(abs, display, ctx)
    const before = existed ? await Bun.file(abs).text() : ""
    await mkdir(dirname(abs), { recursive: true })
    await Bun.write(abs, a.content)
    const st = await stat(abs)
    ctx.readFiles.add(abs)
    ctx.fileStamps.set(abs, st.mtimeMs)
    const patch = createTwoFilesPatch(display, display, before, a.content, "", "", { context: 3 })
    const { added, removed } = diffStat(patch)
    return {
      output: (existed ? `Replaced ${display} (+${added} −${removed}).` : `Created ${display} (${a.content.split("\n").length} lines).`) + straySkillNote([abs], ctx),
      title: `${display} +${added} −${removed}`,
      meta: { diff: patch },
    }
  },
})
