// Persistent memory, after Hermes Agent (tools/memory_tool.py, tools/memory_tool_store.py, MIT,
// © Nous Research): two small files in ~/.config/lembas/memory/, MEMORY.md (the agent's notes)
// and USER.md (who the user is), entries separated by a line holding only "§". Both go into the
// system prompt as a snapshot taken when a session starts; writes during the session reach the
// file but not the prompt, so the prompt stays the same (and cacheable) all session.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { paths } from "../config/paths.ts"
import { threatMessage } from "./threats.ts"

export type Target = "memory" | "user"
export const DELIMITER = "\n§\n"
export const DEFAULT_LIMITS: Record<Target, number> = { memory: 2200, user: 1375 }
/** One fact per entry, and a short one (LLeMbas's MAX_MEMORY_CHARS): a long entry is several facts,
 *  or a note that belongs in a skill or the project's records. */
export const MAX_ENTRY = 400
const FILES: Record<Target, string> = { memory: "MEMORY.md", user: "USER.md" }
const HEADERS: Record<Target, string> = { memory: "MEMORY (your personal notes)", user: "USER PROFILE (who the user is)" }

export interface Op {
  action: "add" | "replace" | "remove"
  content?: string
  old_text?: string
}

export interface Outcome {
  ok: boolean
  message: string
  /** On a failure the model can fix by consolidating: what is there now. */
  entries?: string[]
  usage: string
}

export const memoryDir = () => join(paths.config, "memory")

export function parseEntries(raw: string): string[] {
  const seen = new Set<string>()
  return raw
    .replace(/^﻿/, "")
    .replace(/\r\n/g, "\n")
    .split(/\n[ \t]*§[ \t]*\n/)
    .map((e) => e.trim())
    .filter((e) => e && e !== "§" && !seen.has(e) && seen.add(e))
}

/** An entry `old` identifies: an exact match first, else the one entry containing it. */
export function findEntry(entries: string[], old: string): { index?: number; ambiguous?: boolean } {
  const exact = entries.findIndex((e) => e === old)
  if (exact >= 0) return { index: exact }
  const hits = entries.map((e, i) => (e.includes(old) ? i : -1)).filter((i) => i >= 0)
  if (hits.length > 1) return { ambiguous: true }
  return hits.length ? { index: hits[0] } : {}
}

export class MemoryStore {
  constructor(
    private limits: Record<Target, number> = DEFAULT_LIMITS,
    private dir = memoryDir(),
    /** Headings in the system prompt, where they are not the global files' (a project's memory). */
    private headers: Partial<Record<Target, string>> = {},
  ) {}

  file(t: Target) {
    return join(this.dir, FILES[t])
  }

  entries(t: Target): string[] {
    const f = this.file(t)
    return existsSync(f) ? parseEntries(readFileSync(f, "utf8")) : []
  }

  private size = (entries: string[]) => entries.join(DELIMITER).length

  usage(t: Target, entries = this.entries(t)): string {
    const n = this.size(entries)
    const limit = this.limits[t]
    return `${limit > 0 ? Math.min(100, Math.floor((n / limit) * 100)) : 0}% — ${n.toLocaleString("en")}/${limit.toLocaleString("en")} chars`
  }

  private save(t: Target, entries: string[]) {
    const f = this.file(t)
    const tmp = `${f}.${process.pid}.tmp`
    writeFileSync(tmp, entries.length ? entries.join(DELIMITER) + "\n" : "")
    renameSync(tmp, f)
  }

  /** Two sessions share these files: a change is read, made and written under a lock file, so one
   *  cannot write over the other's. A lock older than 10 s is somebody who died holding it. */
  private locked<T>(t: Target, fn: () => T): T {
    mkdirSync(this.dir, { recursive: true })
    const lock = `${this.file(t)}.lock`
    const until = Date.now() + 5000
    let fd: number | undefined
    while (fd === undefined) {
      try {
        fd = openSync(lock, "wx")
      } catch {
        try {
          if (Date.now() - statSync(lock).mtimeMs > 10_000) rmSync(lock, { force: true })
        } catch {}
        if (Date.now() > until) break
        Bun.sleepSync(20)
      }
    }
    try {
      return fn()
    } finally {
      if (fd !== undefined) {
        closeSync(fd)
        rmSync(lock, { force: true })
      }
    }
  }

  /** Apply operations all together; the size limit is checked on the result only, so one call can
   *  make room and add. Nothing is written unless every operation succeeds. */
  apply(t: Target, ops: Op[]): Outcome {
    return this.locked(t, () => this.applyNow(t, ops))
  }

  private applyNow(t: Target, ops: Op[]): Outcome {
    const before = this.entries(t)
    const work = [...before]
    const fail = (message: string, show = false): Outcome => ({ ok: false, message: ops.length > 1 ? `${message} Nothing was changed (the operations go together or not at all).` : message, usage: this.usage(t, before), ...(show ? { entries: before } : {}) })
    for (const [i, op] of ops.entries()) {
      const at = ops.length > 1 ? `operation ${i + 1}: ` : ""
      const content = op.content?.trim() ?? ""
      if (op.action !== "remove") {
        if (!content) return fail(`${at}${op.action} needs content${op.action === "replace" ? " — the complete new entry" : ""}.`)
        const threat = threatMessage(content, "The entry")
        if (threat) return fail(`${at}${threat}`)
        if (/(^|\n)[ \t]*§[ \t]*(\n|$)/.test(content)) return fail(`${at}a line holding only "§" separates entries; it cannot be inside one.`)
        if (content.length > MAX_ENTRY) return fail(`${at}an entry is one fact, under ${MAX_ENTRY} characters; this one is ${content.length}. Split it into facts, or keep only what will still matter.`)
      }
      if (op.action === "add") {
        if (!work.includes(content)) work.push(content)
        continue
      }
      if (!op.old_text?.trim())
        return fail(`${at}${op.action} needs old_text: a short unique part of the entry to ${op.action}.${op.action === "replace" ? " content is the COMPLETE new entry; the whole matched entry is overwritten." : ""}`, true)
      const hit = findEntry(work, op.old_text.trim())
      if (hit.ambiguous) return fail(`${at}"${op.old_text}" matches more than one entry — use a longer, unique part.`, true)
      if (hit.index === undefined) return fail(`${at}no entry contains "${op.old_text}".`, true)
      if (op.action === "remove") work.splice(hit.index, 1)
      else work[hit.index] = content
    }
    const limit = this.limits[t]
    // Over the limit already (it was lowered, or the file edited)? Anything that does not grow it
    // still goes through, so "forget X" always works.
    if (this.size(work) > limit && this.size(work) > this.size(before))
      return fail(
        `${t === "user" ? "The user profile" : "Memory"} would be ${this.size(work).toLocaleString("en")}/${limit.toLocaleString("en")} chars. Consolidate in the same call: replace overlapping entries with one shorter entry, or remove stale ones, together with the add.`,
        true,
      )
    const unique = [...new Set(work)]
    if (unique.join("\u0000") !== before.join("\u0000")) this.save(t, unique)
    return { ok: true, message: ops.length > 1 ? `Applied ${ops.length} operations.` : ops[0]!.action === "add" && before.includes(ops[0]!.content!.trim()) ? "That entry already exists; nothing added." : `Entry ${ops[0]!.action === "add" ? "added" : ops[0]!.action === "replace" ? "replaced" : "removed"}.`, usage: this.usage(t, unique) }
  }

  /** The system-prompt block for one target, or "" when it is empty. */
  block(t: Target): string {
    const entries = this.entries(t)
    if (!entries.length) return ""
    const bar = "═".repeat(46)
    return `${bar}\n${this.headers[t] ?? HEADERS[t]} [${this.usage(t, entries)}]\n${bar}\n${entries.join(DELIMITER)}`
  }

  /** Both blocks, as they stand now: taken once per session. */
  snapshot(): string {
    return [this.block("user"), this.block("memory")].filter(Boolean).join("\n\n")
  }
}
