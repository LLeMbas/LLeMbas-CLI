// The model last used in a directory (harness acp.md, spec 3.9.0): one model per directory,
// remembered on this machine and nowhere else — not in the project, not in a session, not on the
// server — so that a new session in a directory starts on what was last used there, wherever it
// is started from. The rules are three small functions (conformance/last_model.json); the rest is
// one file in the state directory.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { paths } from "../config/paths.ts"
import { realPath } from "../permission/evaluate.ts"

export type StartSource = "asked" | "project" | "directory" | "global" | "default"

/** Which model a session of this device's own starts on: the first source that names one. Only
 *  the directory's is checked against what the login serves now — a model that has gone is
 *  skipped, silently; the others are taken as written, and a wrong one is theirs to report. */
export function startModel(o: { asked?: string; project?: string; directory?: string; global?: string; served: readonly string[]; default?: string }): { model: string | undefined; from: StartSource } {
  if (o.asked) return { model: o.asked, from: "asked" }
  if (o.project) return { model: o.project, from: "project" }
  if (o.directory && o.served.includes(o.directory)) return { model: o.directory, from: "directory" }
  if (o.global) return { model: o.global, from: "global" }
  return { model: o.default, from: "default" }
}

export type SessionKind = "terminal" | "link" | "stdio" | "run" | "scheduled"

/** Whether something makes the session's model the directory's: a turn a person started, or the
 *  person changing the model — of the main agent, and never in a one-shot run or a session a
 *  schedule opened. `machine`: it happens in a turn the harness started (the turn itself, or a
 *  change made inside it — a model's own settings call is not the person's choice there). */
export function records(o: { session: SessionKind; agent: "main" | "subagent"; what: "turn" | "change" | "command"; machine?: boolean }): boolean {
  if (o.agent !== "main" || o.session === "run" || o.session === "scheduled") return false
  if (o.what === "command") return false
  return o.machine !== true
}

/** The client's rule (LLeMbas applies it; kept here so both suites answer the same cases): the
 *  model a new agent chat on a device and directory, or a schedule's run there, starts on. */
export function clientModel(o: { named?: string; directory?: string; has: readonly string[]; default?: string; scheduled?: boolean; interactive_only?: readonly string[] }): { model: string | undefined; from: "named" | "directory" | "default" } {
  if (o.named) return { model: o.named, from: "named" }
  // A schedule's run never starts on an interactive-only model the directory remembers (interactive.md §2).
  const usable = o.scheduled ? o.has.filter((m) => !(o.interactive_only ?? []).includes(m)) : o.has
  if (o.directory && usable.includes(o.directory)) return { model: o.directory, from: "directory" }
  return { model: o.default, from: "default" }
}

/** At most this many directories are kept; the ones used longest ago go first. */
export const MAX_DIRECTORIES = 500

/** A directory's model is written again — its time refreshed — when it was last used longer ago
 *  than this, so "used longest ago" is true to about an hour without a write every turn. */
export const REFRESH_MS = 60 * 60 * 1000
/** Directories that are gone are looked for at most this often, and never on a turn's path. */
export const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000
/** How long one directory's stat may take before it is left alone (a hung mount). */
const STAT_TIMEOUT_MS = 300

interface Entry {
  model: string
  /** When it was last used, ms since the epoch (to REFRESH_MS). */
  at: number
}
interface File {
  version: 1
  directories: Record<string, Entry>
  /** When gone directories were last looked for. */
  pruned?: number
}

/** `models.json` in the state directory (local mode: the local root's). */
export const lastModelFile = (): string => join(paths.state, "models.json")

/** A directory as the memory names it: absolute, symlinks followed, no trailing slash. */
export function directoryKey(dir: string): string {
  return realPath(resolve(dir))
}

function read(): File {
  try {
    const v = JSON.parse(readFileSync(lastModelFile(), "utf8")) as File
    if (v && typeof v === "object" && v.directories && typeof v.directories === "object") return { version: 1, directories: v.directories, ...(typeof v.pruned === "number" ? { pruned: v.pruned } : {}) }
  } catch {}
  return { version: 1, directories: {} }
}

/** The model last used in exactly `dir`, or undefined. Never a parent's, never a child's. */
export function lastModel(dir: string): string | undefined {
  const e = read().directories[directoryKey(dir)]
  return e && typeof e.model === "string" && e.model ? e.model : undefined
}

/** Every remembered directory's model, for many lookups at once (a listing). */
export function lastModels(): (dir: string) => string | undefined {
  const all = read().directories
  return (dir) => {
    const e = all[directoryKey(dir)]
    return e && typeof e.model === "string" && e.model ? e.model : undefined
  }
}

function write(file: File) {
  const path = lastModelFile()
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
}

/** Make `ref` the model of `dir`, or mark it used again. The file is read, changed and renamed
 *  into place: a reader never sees half a file, and nothing is locked — of two sessions writing
 *  in the same instant the later rename wins and the other's entry is written again at its next
 *  turn. Nothing here looks at the file system beyond the one file (no stat of the remembered
 *  directories: `pruneGone` does that, off the turn's path); over the cap, the ones used longest
 *  ago go. A failure is nobody's problem: the memory is a convenience, never in a turn's way. */
export function rememberModel(dir: string, ref: string, now = Date.now()): void {
  if (!ref) return
  try {
    const key = directoryKey(dir)
    const file = read()
    const had = file.directories[key]
    if (had?.model === ref && now - (had.at ?? 0) < REFRESH_MS) return
    file.directories[key] = { model: ref, at: now }
    const kept = Object.entries(file.directories)
      .filter(([, e]) => e && typeof e.model === "string")
      .sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0))
      .slice(0, MAX_DIRECTORIES)
    write({ version: 1, directories: Object.fromEntries(kept), ...(file.pruned ? { pruned: file.pruned } : {}) })
    if (now - (file.pruned ?? 0) >= PRUNE_EVERY_MS) void pruneGone(now)
  } catch {}
}

/** Drop the directories that no longer exist. Asynchronous and unhurried: each is asked for with
 *  a short wait, and one that does not answer in time (a hung network mount) or fails for any
 *  reason but "not there" is kept. The file is read again before it is written, so what was
 *  remembered meanwhile stays. */
export async function pruneGone(now = Date.now()): Promise<string[]> {
  const gone: string[] = []
  try {
    for (const dir of Object.keys(read().directories)) {
      const there = await Promise.race([
        stat(dir).then((s) => s.isDirectory(), (e: NodeJS.ErrnoException) => (e?.code === "ENOENT" || e?.code === "ENOTDIR" ? false : true)),
        new Promise<true>((done) => setTimeout(() => done(true), STAT_TIMEOUT_MS).unref?.()),
      ])
      if (!there) gone.push(dir)
    }
    const file = read()
    for (const dir of gone) delete file.directories[dir]
    write({ version: 1, directories: file.directories, pruned: now })
  } catch {}
  return gone
}
