// apply_patch: the "*** Begin Patch" format (OpenCode tool/apply_patch.txt, parser in patch.ts),
// which GPT-family models are trained on, or a unified diff (unidiff.ts, from LLeMbas's file_edit),
// which every model has seen. Context lines locate each change, so unlike edit it does not demand
// the file was read first — a wrong context is refused instead.
import { mkdir, rm, stat } from "node:fs/promises"
import { dirname } from "node:path"
import { createTwoFilesPatch } from "diff"
import { z } from "zod"
import { derive, joinBom, parse, type Hunk } from "./patch.ts"
import { applyUnified, isUnified, parseUnified, UnidiffError, type UniFile } from "./unidiff.ts"
import { straySkillNote } from "../skill/index.ts"
import { absPath, defineTool, readText, showPath, ToolError, type ToolContext } from "./tool.ts"
import { diffStat } from "./write.ts"
import { described } from "../harness.ts"
import { hunks, lineCount, sha256, type EditedFile } from "../session/results.ts"

function hunksOf(text: string): Hunk[] {
  try {
    return [...parse(text)]
  } catch {
    return []
  }
}

function uniFiles(text: string): UniFile[] {
  try {
    return parseUnified(text)
  } catch {
    return []
  }
}

/** The files a patch names, as given: for the permission request, before anything is read. */
function namedFiles(a: { patch: string; path?: string }): string[] {
  if (isUnified(a.patch)) return [...new Set(uniFiles(a.patch).map((f) => f.path ?? a.path).filter((p): p is string => p !== undefined))]
  return hunksOf(a.patch).flatMap((h) => (h.type === "update" && h.movePath ? [h.path, h.movePath] : [h.path]))
}

type Op = { kind: "write"; path: string; content: string; before: string; created?: boolean } | { kind: "delete"; path: string; before: string }

function opsOf(original: Map<string, string | null>, current: Map<string, string | null>): Op[] {
  const ops: Op[] = []
  for (const [path, now] of current) {
    const before = original.get(path) ?? null
    if (now === before) continue
    if (now === null) ops.push({ kind: "delete", path, before: before! })
    else ops.push({ kind: "write", path, content: now, before: before ?? "", ...(before === null ? { created: true } : {}) })
  }
  return ops
}

/** A unified diff: each file's hunks applied to it in memory, all or nothing. */
async function planUnified(a: { patch: string; path?: string }, ctx: ToolContext): Promise<Op[]> {
  let files: UniFile[]
  try {
    files = parseUnified(a.patch)
  } catch (e) {
    throw new ToolError(`${(e as Error).message} Nothing was applied.`)
  }
  const original = new Map<string, string | null>()
  const current = new Map<string, string | null>()
  for (const f of files) {
    const path = f.path ?? a.path
    if (!path) throw new ToolError("The diff names no file: give `path`, or start it with --- a/<file> and +++ b/<file> lines. Nothing was applied.")
    const abs = absPath(path, ctx)
    if (!current.has(abs)) {
      const text = await stat(abs).then(() => readText(abs), () => null)
      original.set(abs, text)
      current.set(abs, text)
    }
    const text = current.get(abs)!
    if (f.remove) {
      if (text === null) throw new ToolError(`${path} does not exist. Nothing was applied.`)
      current.set(abs, null)
      continue
    }
    if (text === null && !f.create) throw new ToolError(`${path} does not exist; a diff that creates it starts with --- /dev/null. Nothing was applied.`)
    if (text !== null && f.create) throw new ToolError(`${path} already exists; diff it against its current content instead. Nothing was applied.`)
    // A byte-order mark is not part of the first line the hunk's context names.
    const bom = text?.startsWith("\uFEFF") ?? false
    try {
      current.set(abs, joinBom(applyUnified(bom ? text!.slice(1) : (text ?? ""), f.hunks), bom))
    } catch (e) {
      if (e instanceof UnidiffError) throw new ToolError(`${path}: ${e.message}`)
      throw e
    }
  }
  return opsOf(original, current)
}

async function planPatch(a: { patch: string; path?: string }, ctx: ToolContext): Promise<Op[]> {
  if (isUnified(a.patch)) return planUnified(a, ctx)
  let hunks: Hunk[]
  try {
    hunks = [...parse(a.patch)]
  } catch (e) {
    throw new ToolError(`The patch could not be parsed: ${(e as Error).message}`)
  }
  // Work everything out first; write nothing until every hunk is known to apply. Each file's
  // content is followed through the patch, so a file named twice gets both changes, in order.
  const original = new Map<string, string | null>() // on disk before; null: did not exist
  const current = new Map<string, string | null>()
  const load = async (abs: string) => {
    if (!current.has(abs)) {
      const text = await stat(abs).then(() => readText(abs), () => null)
      original.set(abs, text)
      current.set(abs, text)
    }
    return current.get(abs)!
  }
  for (const h of hunks) {
    const abs = absPath(h.path, ctx)
    const text = await load(abs)
    if (h.type === "add") {
      if (text !== null) throw new ToolError(`${h.path} already exists; use Update File to change it. Nothing was applied.`)
      current.set(abs, h.contents.endsWith("\n") ? h.contents : h.contents + "\n")
    } else if (h.type === "delete") {
      if (text === null) throw new ToolError(`${h.path} does not exist. Nothing was applied.`)
      current.set(abs, null)
    } else {
      if (text === null) throw new ToolError(`${h.path} does not exist. Nothing was applied.`)
      let next
      try {
        next = derive(h.path, h.chunks, text)
      } catch (e) {
        throw new ToolError(`${(e as Error).message}\nRead the file again and write the hunk from what is there. Nothing was applied.`)
      }
      const to = h.movePath ? absPath(h.movePath, ctx) : abs
      if (to !== abs) {
        if ((await load(to)) !== null) throw new ToolError(`${h.movePath} already exists; a move does not overwrite a file. Nothing was applied.`)
        current.set(abs, null)
      }
      current.set(to, joinBom(next.content, next.bom))
    }
  }
  return opsOf(original, current)
}

export const applyPatchTool = defineTool({
  ...described("apply_patch"),
  access: "edit",
  schema: z.object({ patch: z.string().min(1), path: z.string().optional() }),
  permission: (a, ctx) => {
    const files = namedFiles(a).map((p) => absPath(p, ctx))
    return { permission: "edit", class: "write", patterns: files.length ? files.map((f) => showPath(f, ctx)) : ["*"], paths: files }
  },
  async preview(a, ctx) {
    return (await planPatch(a, ctx))
      .map((op) => {
        const shown = showPath(op.path, ctx)
        return createTwoFilesPatch(shown, op.kind === "delete" ? "/dev/null" : shown, op.before, op.kind === "delete" ? "" : op.content, "", "", { context: 3 })
      })
      .join("\n")
  },
  async run(a, ctx) {
    const ops = await planPatch(a, ctx)
    const patches: string[] = []
    for (const op of ops) {
      const shown = showPath(op.path, ctx)
      if (op.kind === "delete") {
        await rm(op.path)
        patches.push(createTwoFilesPatch(shown, "/dev/null", op.before, "", "", "", { context: 3 }))
        continue
      }
      await mkdir(dirname(op.path), { recursive: true })
      await Bun.write(op.path, op.content)
      ctx.readFiles.add(op.path)
      ctx.fileStamps.set(op.path, (await stat(op.path)).mtimeMs)
      patches.push(createTwoFilesPatch(shown, shown, op.before, op.content, "", "", { context: 3 }))
    }
    const all = patches.join("\n")
    const { added, removed } = diffStat(all)
    const names = ops.map((o) => showPath(o.path, ctx)).join(", ")
    const note = straySkillNote(ops.filter((o) => o.kind === "write").map((o) => o.path), ctx)
    const files: EditedFile[] = ops.map((op) => {
      const path = showPath(op.path, ctx)
      if (op.kind === "delete") return { path, deleted: true }
      return op.created ? { path, sha: sha256(op.content), created: lineCount(op.content) } : { path, sha: sha256(op.content), hunks: hunks(op.before, op.content) }
    })
    return { output: `Applied to ${names} (+${added} −${removed}).${note}`, title: `${names} +${added} −${removed}`, meta: { diff: all }, context: { kind: "edit", files, ...(note ? { note } : {}) } }
  },
})
