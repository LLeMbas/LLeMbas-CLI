// A file's text as the client's editor has it (harness/acp.md, *Unsaved text*, spec 3.11.0).
// Where the client of the session offers ACP's fs/read_text_file and fs/write_text_file, the file
// tools start from its buffer and write through it; anywhere else they use the disk, as before.
// Nothing here decides whether a call may run: permissions were judged before a tool reads or
// writes anything.
//
// One rule above the rest: **text the session read from the editor is never replaced from the
// disk.** Once a file was read through the client, a later read there that fails, or a write the
// client did not confirm, refuses the call and asks for a new read — the buffer may hold what
// the person has not saved.
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { sha256 } from "../session/results.ts"
import { readText, ToolError, type FileChange, type ToolContext } from "./tool.ts"

type Ctx = Pick<ToolContext, "editor" | "editorSeen">

/** What `editorSeen` holds for a file whose text in the editor is not known any more (a write the
 *  client never confirmed): no text has this hash, so every change is refused until a new read. */
const UNKNOWN = "unknown"

const readAgain = (abs: string) => new ToolError(`${abs} is open in the editor, and the editor did not give its text just now. Read it again before changing it.`)

/** Where a tool that changes a file takes its text from (conformance `editor`, `kind: buffer`):
 *  the editor's answer; the disk when the client gave none and the session never read the file
 *  there; a refusal when it did — its buffer may hold what is not saved. */
export function textFrom(o: { tracked: boolean; read: "text" | "fails" | "none" }): "editor" | "disk" | "refuse" {
  if (o.read === "text") return "editor"
  return o.tracked && o.read === "fails" ? "refuse" : "disk"
}

/** What becomes of a write (`kind: buffer`): `taken` by the client; `refused` by it — the disk,
 *  unless the session read the file in the editor; `unknown` — no answer: never the disk as well. */
export function writeTo(o: { tracked: boolean; write: "taken" | "refused" | "unknown" | "none" }): "editor" | "disk" | "refuse" {
  if (o.write === "taken") return "editor"
  if (o.write === "unknown") return "refuse"
  return o.tracked && o.write === "refused" ? "refuse" : "disk"
}

/** Note what a call that ran changed, where a client wants to draw it (ToolContext.changed). */
export function noteChanges(ctx: Pick<ToolContext, "changed" | "callId">, files: FileChange[]): void {
  if (ctx.changed && ctx.callId) ctx.changed.set(ctx.callId, files)
}

/** The read tool's: the text of `abs` as the client has it, or undefined when it is the disk's to
 *  give. What the model is shown here is what "read" means from now on. */
export async function editorText(abs: string, ctx: Ctx): Promise<string | undefined> {
  const text = await ctx.editor?.read?.(abs).catch(() => undefined)
  if (text === undefined) return undefined
  ctx.editorSeen?.set(abs, sha256(text))
  return text
}

/** Whether the session read `abs` through the client's editor (and has not been told since that
 *  the editor let go of it). */
const tracked = (abs: string, ctx: Ctx) => ctx.editorSeen?.has(abs) === true

/** A file's text for a tool that changes it or previews a change: the client's buffer where it
 *  gives one, else the disk — byte-order mark kept. Records nothing: looking at a file to work
 *  out a change is not the model reading it. For a file the session read through the editor, a
 *  client that does not answer is a refusal, never the disk. */
export async function fileText(abs: string, ctx: Ctx): Promise<string> {
  const text = ctx.editor?.read ? await ctx.editor.read(abs).catch(() => undefined) : undefined
  const from = textFrom({ tracked: tracked(abs, ctx), read: !ctx.editor?.read ? "none" : text !== undefined ? "text" : "fails" })
  if (from === "refuse") throw readAgain(abs)
  return from === "editor" ? text! : readText(abs)
}

/** Whether the text of `abs` in the client's editor is no longer what this session last read
 *  there. False where the session never read it through the client; a client that cannot say is
 *  a refusal. */
export async function changedInEditor(abs: string, ctx: Ctx): Promise<boolean> {
  const seen = ctx.editorSeen?.get(abs)
  if (seen === undefined || !ctx.editor?.read) return false
  const now = await ctx.editor.read(abs).catch(() => undefined)
  if (now === undefined) throw readAgain(abs)
  return sha256(now) !== seen
}

/** Write a file's text: through the client where it takes it, else to the disk. True: the client
 *  took it (the disk may follow a moment later — the file's change time proves nothing then).
 *  A write the client neither took nor refused (no answer in time) is not repeated on the disk:
 *  the client may still apply it, and two writers would cross. */
export async function putText(abs: string, content: string, ctx: Ctx): Promise<boolean> {
  const outcome = ctx.editor?.write ? await ctx.editor.write(abs, content).catch(() => false as const) : false
  if (outcome === "unknown") {
    ctx.editorSeen?.set(abs, UNKNOWN)
    throw new ToolError(`The editor did not confirm writing ${abs}; it may or may not have been written. Read it again to see what is there before going on.`)
  }
  if (outcome === true) {
    ctx.editorSeen?.set(abs, sha256(content))
    return true
  }
  // The client would not take it. Text it holds unsaved is not written over behind its back.
  if (tracked(abs, ctx)) throw new ToolError(`${abs} is open in the editor, which refused the write. Nothing was written; tell the user, or read it again.`)
  await mkdir(dirname(abs), { recursive: true })
  await Bun.write(abs, content)
  return false
}
