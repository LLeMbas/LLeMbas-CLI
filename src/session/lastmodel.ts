// The model last used in a directory (harness acp.md, spec 3.9.0): one model per directory,
// remembered on this machine and nowhere else — not in the project, not in a session, not on the
// server — so that a new session in a directory starts on what was last used there, wherever it
// is started from. The rules are three small functions (conformance/last_model.json); the rest is
// one file in the state directory.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
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
 *  schedule opened. */
export function records(o: { session: SessionKind; agent: "main" | "subagent"; what: "turn" | "change" | "command"; machine?: boolean }): boolean {
  if (o.agent !== "main" || o.session === "run" || o.session === "scheduled") return false
  if (o.what === "command") return false
  return !(o.what === "turn" && o.machine === true)
}

/** The client's rule (LLeMbas applies it; kept here so both suites answer the same cases): the
 *  model a new agent chat on a device and directory, or a schedule's run there, starts on. */
export function clientModel(o: { named?: string; directory?: string; has: readonly string[]; default?: string }): { model: string | undefined; from: "named" | "directory" | "default" } {
  if (o.named) return { model: o.named, from: "named" }
  if (o.directory && o.has.includes(o.directory)) return { model: o.directory, from: "directory" }
  return { model: o.default, from: "default" }
}

/** At most this many directories are kept; the ones used longest ago go first. */
export const MAX_DIRECTORIES = 500

interface Entry {
  model: string
  /** When it was written, ms since the epoch. */
  at: number
}
interface File {
  version: 1
  directories: Record<string, Entry>
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
    if (v && typeof v === "object" && v.directories && typeof v.directories === "object") return { version: 1, directories: v.directories }
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

const isDirectory = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** Make `ref` the model of `dir`. Written atomically, read first, so two sessions writing for two
 *  directories keep both; directories that are gone are dropped, and the oldest beyond the cap.
 *  A failure is nobody's problem: the memory is a convenience, never in a turn's way. */
export function rememberModel(dir: string, ref: string, now = Date.now()): void {
  if (!ref) return
  try {
    const key = directoryKey(dir)
    const file = read()
    if (file.directories[key]?.model === ref) return
    file.directories[key] = { model: ref, at: now }
    const kept = Object.entries(file.directories)
      .filter(([d, e]) => e && typeof e.model === "string" && (d === key || isDirectory(d)))
      .sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0))
      .slice(0, MAX_DIRECTORIES)
    const path = lastModelFile()
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify({ version: 1, directories: Object.fromEntries(kept) }, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, path)
  } catch {}
}
