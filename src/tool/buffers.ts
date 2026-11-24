// A file's text as the client's editor has it (harness/acp.md, *Unsaved text*, spec 3.11.0).
// Where the client of the session offers ACP's fs/read_text_file and fs/write_text_file, the file
// tools start from its buffer and write through it; anywhere else — and whenever the client does
// not take a request — they use the disk, as before. Nothing here decides whether a call may run:
// permissions were judged before a tool reads or writes anything.
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { sha256 } from "../session/results.ts"
import { readText, type FileChange, type ToolContext } from "./tool.ts"

type Ctx = Pick<ToolContext, "editor" | "editorSeen">

/** Note what a call that ran changed, where a client wants to draw it (ToolContext.changed). */
export function noteChanges(ctx: Pick<ToolContext, "changed" | "callId">, files: FileChange[]): void {
  if (ctx.changed && ctx.callId) ctx.changed.set(ctx.callId, files)
}

/** The text of `abs` as the client has it, or undefined when it is the disk's to give. What was
 *  read is remembered, so a later overwrite can tell whether the text has changed since. */
export async function editorText(abs: string, ctx: Ctx): Promise<string | undefined> {
  const text = await ctx.editor?.read?.(abs).catch(() => undefined)
  if (text === undefined) return undefined
  ctx.editorSeen?.set(abs, sha256(text))
  return text
}

/** A file's text: the client's buffer where it has one, else the disk — byte-order mark kept. */
export async function fileText(abs: string, ctx: Ctx): Promise<string> {
  return (await editorText(abs, ctx)) ?? (await readText(abs))
}

/** Whether the text of `abs` in the client's editor is no longer what this session last read
 *  there. False where the session never read it through the client, or the client cannot say. */
export async function changedInEditor(abs: string, ctx: Ctx): Promise<boolean> {
  const seen = ctx.editorSeen?.get(abs)
  if (seen === undefined || !ctx.editor?.read) return false
  const now = await ctx.editor.read(abs).catch(() => undefined)
  return now !== undefined && sha256(now) !== seen
}

/** Write a file's text: through the client where it takes it, else to the disk. */
export async function putText(abs: string, content: string, ctx: Ctx): Promise<void> {
  const taken = ctx.editor?.write ? await ctx.editor.write(abs, content).catch(() => false) : false
  if (!taken) {
    await mkdir(dirname(abs), { recursive: true })
    await Bun.write(abs, content)
  }
  if (ctx.editor?.read) ctx.editorSeen?.set(abs, sha256(content))
}
