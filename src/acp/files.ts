// Device files (harness/acp.md, spec 3.11.0, capability `fs`): `_lembas/fs/*`, the person's own
// hands on the files of this computer from a client's file manager — no model, no tool, no card.
// What bounds them is this device: only inside `remote.roots` with remote work on; a path judged
// where it really is, symlinks followed first; never the CLI's own files, never a protected path;
// read-only where the device allows plan mode only. conformance/device_files.json.
import { closeSync, existsSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, renameSync, rmSync, statSync, writeFileSync, writeSync, chmodSync } from "node:fs"
import { cp, rm } from "node:fs/promises"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { expandHome, globalPaths, paths } from "../config/paths.ts"
import type { Mode } from "../config/schema.ts"
import { LOOP } from "../harness.ts"
import { realPath } from "../permission/evaluate.ts"
import { protectedPath, protectedRoots } from "../permission/hardline.ts"
import fuzzysort from "fuzzysort"
import { INVALID_PARAMS, RpcError } from "./rpc.ts"

const F = LOOP.files

export type FsReason = "off" | "invalid" | "outside" | "own" | "protected" | "runs_code" | "read_only" | "missing" | "exists" | "changed" | "not_a_file" | "not_a_directory" | "no_trash" | "too_large"

/** `read`: list, stat, read, search, a copy's source. `write`: write, mkdir, a move's or a copy's
 *  target. `remove`: delete and a move's source — the name itself, a link not followed. */
export type FsOp = "read" | "write" | "remove"

const inside = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith("/") ? dir : dir + "/")

export interface Judging {
  op: FsOp
  path: string
  roots: readonly string[]
  /** The CLI's own directories. */
  own: readonly string[]
  /** Whether `p` is a protected path, or under one. */
  guarded: (p: string) => boolean
  /** The protected paths themselves, for a method that works on a whole folder. */
  guardedRoots?: readonly string[]
  enabled: boolean
  sharedOnly?: boolean
  maxMode: Mode
  /** A path as the file system will see it: symlinks followed. */
  real: (p: string) => string
  /** The method works on everything under the path too (a delete, a move, a copy's source). */
  deep?: boolean
  /** Whether a change at `p` would change what runs on the device (`runsCode`). Absent: not judged. */
  runsCode?: (p: string) => boolean
}

/** Whether a method may touch `path`, and where it really is (`kind: path`). The first that
 *  applies of off, invalid, outside, own, protected, runs_code, read_only. */
export function judgePath(o: Judging): { ok: true; real: string } | { refused: FsReason } {
  if (!o.enabled || o.sharedOnly || !o.roots.length) return { refused: "off" }
  const given = typeof o.path === "string" ? expandHome(o.path.trim()) : ""
  if (!given || !isAbsolute(given)) return { refused: "invalid" }
  const norm = resolve(given)
  const roots = o.roots.map((r) => o.real(resolve(expandHome(r))))
  // A name's own directory is followed; the name is not — deleting a link deletes the link.
  const real = o.op === "remove" ? join(o.real(dirname(norm)), basename(norm)) : o.real(norm)
  // A root itself is never deleted or moved.
  if (o.op === "remove" && roots.some((r) => r === real || r === o.real(norm))) return { refused: "invalid" }
  if (!roots.some((r) => inside(real, r))) return { refused: "outside" }
  const own = o.own.map((d) => o.real(d))
  const deep = o.deep || o.op === "remove"
  if (own.some((d) => inside(real, d) || inside(norm, d) || (deep && inside(d, real)))) return { refused: "own" }
  if (o.guarded(norm) || o.guarded(real) || (deep && (o.guardedRoots ?? []).some((g) => inside(o.real(g), real)))) return { refused: "protected" }
  // Reading a file that runs is reading; changing one is not the same act as changing a document.
  if (o.op !== "read" && (o.runsCode?.(real) || o.runsCode?.(norm))) return { refused: "runs_code" }
  if (o.op !== "read" && o.maxMode === "plan") return { refused: "read_only" }
  return { ok: true, real }
}

/** Files that run code (acp.md, *Files that run code*; `loop.json` `files.runs_code`): git's own
 *  directory (hooks and config run programs), a project's agent configuration (its config,
 *  agents, commands, skills — and with them its MCP servers), and the start-up files of the
 *  device's user. `_lembas/fs/*` reads them and never changes them: a path that is one, is under
 *  one, or — for the project's and the home's — holds one. */
export function runsCode(p: string, home: string, R: typeof F.runs_code = F.runs_code): boolean {
  const parts = p.split("/")
  if (parts.some((x) => R.segments.includes(x))) return true
  const at = parts.lastIndexOf(R.project_dir)
  if (at >= 0) {
    const rest = parts.slice(at + 1)
    // The directory itself (moved or copied into place it brings all of them), or one of its names.
    if (!rest.length || R.project.includes(rest[0]!)) return true
  }
  return R.home.some((h) => {
    const g = join(home, h)
    return inside(p, g) || (p !== home && inside(g, p) && inside(p, home))
  })
}

/** After anything was waited for, a path is judged again: the method goes on only when it is
 *  still allowed and still the same place (`kind: again`). Otherwise something moved under it. */
export function sameAgain(first: string, again: { ok: true; real: string } | { refused: FsReason }): { act: true } | { refused: FsReason } {
  if ("refused" in again) return { refused: again.refused }
  return again.real === first ? { act: true } : { refused: "changed" }
}

/** A part file of an upload, beside its target: never listed, searched or named by a client. */
export const PART = /^\..*\.lembas-part$/

const HASH = /^sha256:[0-9a-f]{64}$/

/** Whether `_lembas/fs/write` writes (`kind: base`): the file must be as the client last saw it. */
export function baseCheck(o: { base?: unknown; overwrite?: unknown; current: string | null }): { write: true } | { refused: "changed" | "exists" | "invalid" } {
  if (o.base === null) return o.current === null ? { write: true } : { refused: "exists" }
  if (o.base === undefined) return o.overwrite === true ? { write: true } : { refused: "invalid" }
  if (typeof o.base !== "string" || !HASH.test(o.base)) return { refused: "invalid" }
  return o.current === o.base ? { write: true } : { refused: "changed" }
}

/** The link's limits as these methods read them. */
export interface FsLimits {
  roots: string[]
  maxMode: Mode
  enabled?: boolean
  sharedOnly?: boolean
  /** `remote.files_that_run_code`: files that run code may be changed. Absent: no. */
  runsCode?: boolean
}

const SENTENCES: Record<string, (p: string) => string> = {
  off: () => "this computer does not share its files now — turn remote work on there and give it a folder (lembas remote enable, lembas remote add <dir>)",
  invalid: (p) => `${p || "that"} is not a path this computer can use here`,
  outside: (p) => `${p} is outside the folders this computer shares (remote.roots)`,
  own: (p) => `${p} holds LLeMbas CLI's own files on this computer, which are not reached from here`,
  protected: (p) => `${p} is a protected path on this computer and is not reached from here`,
  read_only: () => "this computer allows remote work in plan mode only (remote.max_mode): its files can be read from here, not changed",
  missing: (p) => `${p} does not exist on this computer`,
  exists: (p) => `${p} already exists on this computer`,
  not_a_file: (p) => `${p} is not a file`,
  not_a_directory: (p) => `${p} is not a folder`,
  runs_code: (p) => `${p} is a file that runs code on this computer (git's own files, a project's agent configuration, or a start-up file): it can be read from here, and is changed from here only once the computer allows it — lembas remote files-that-run-code on there (remote.files_that_run_code)`,
}

const refuse = (reason: FsReason, path: string, message?: string, extra: Record<string, unknown> = {}): never => {
  throw new RpcError(INVALID_PARAMS, message ?? SENTENCES[reason]?.(path) ?? `${path}: ${reason}`, { reason, ...extra })
}

/** The CLI's own directories: its configuration, data and state — the user's, and local mode's. */
export function ownDirs(): string[] {
  return [...new Set([paths.config, paths.data, paths.state, globalPaths.config, globalPaths.data, globalPaths.state])]
}

const guarded = (p: string) => protectedPath(p) !== undefined

const yieldNow = () => new Promise<void>((r) => setImmediate(r))

/** `sha256:` and the hex digest of an open file's content, read in pieces, letting other work in
 *  between. By descriptor: the file that was judged is the file that is read, whatever becomes
 *  of its name meanwhile. */
export async function hashFd(fd: number): Promise<string> {
  const h = createHash("sha256")
  const buf = Buffer.alloc(1024 * 1024)
  for (let at = 0; ; ) {
    const n = readSync(fd, buf, 0, buf.length, at)
    if (n <= 0) break
    h.update(buf.subarray(0, n))
    at += n
    await yieldNow()
  }
  return `sha256:${h.digest("hex")}`
}

/** The same for a path this process chose itself (the show tool's file). */
export async function hashFile(abs: string): Promise<string> {
  const fd = openSync(abs, "r")
  try {
    return await hashFd(fd)
  } finally {
    closeSync(fd)
  }
}

const hashBytes = (b: Uint8Array) => `sha256:${createHash("sha256").update(b).digest("hex")}`

/** The part files of uploads under way, kept in the state directory so that a process that died
 *  with one open can take it away at its next start. */
const journalFile = () => join(paths.state, "uploads.json")
function journal(change?: (list: string[]) => string[]): string[] {
  let list: string[] = []
  try {
    const read = JSON.parse(readFileSync(journalFile(), "utf8"))
    if (Array.isArray(read)) list = read.filter((x): x is string => typeof x === "string")
  } catch {}
  if (!change) return list
  const next = change(list)
  try {
    mkdirSync(paths.state, { recursive: true, mode: 0o700 })
    writeFileSync(journalFile(), JSON.stringify(next), { mode: 0o600 })
  } catch {}
  return next
}

/** Whether a part file's name still leads to where it was made: its directory, as recorded, is
 *  its own real path (nothing on the way became a link), and the name is a plain file. */
function partInPlace(part: string): boolean {
  try {
    return realPath(dirname(part)) === dirname(part) && lstatSync(part).isFile()
  } catch {
    return false
  }
}

/** Part files a process left behind (it was killed with an upload open): removed, once, by the
 *  next one. Only what the journal names and what is named like a part file. */
export function sweepParts(live: ReadonlySet<string> = new Set()): string[] {
  const gone: string[] = []
  journal((list) =>
    list.filter((part) => {
      if (live.has(part)) return true
      if (PART.test(basename(part)) && partInPlace(part)) {
        try {
          rmSync(part, { force: true })
          gone.push(part)
        } catch {}
      }
      return false
    }),
  )
  return gone
}

interface Upload {
  id: string
  /** Where the file really goes, and the part file beside it. */
  target: string
  part: string
  fd: number
  received: number
  /** What was said of it when it began (for the sentences). */
  said: string
  base: unknown
  overwrite: unknown
  timer: ReturnType<typeof setTimeout>
}

export interface Entry {
  name: string
  path: string
  kind: "file" | "dir" | "other"
  size: number
  mtime: number
  link?: string
  outside?: true
  protected?: true
}

/** The system's trash for `abs`, when it has one that can take it: the file is moved there.
 *  False: there is none (another file system, or a platform without one known here). */
export function moveToTrash(abs: string, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): boolean {
  const name = basename(abs)
  const free = (dir: string) => {
    let candidate = name
    for (let i = 2; existsSync(join(dir, candidate)); i++) candidate = `${name}.${i}`
    return candidate
  }
  try {
    if (platform === "darwin") {
      const dir = join(homedir(), ".Trash")
      if (!existsSync(dir)) return false
      renameSync(abs, join(dir, free(dir)))
      return true
    }
    if (platform !== "linux" && platform !== "freebsd" && platform !== "openbsd") return false
    // The freedesktop trash of the user's data directory: files/ and info/ side by side.
    const data = env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(homedir(), ".local", "share")
    const trash = join(data, "Trash")
    const files = join(trash, "files")
    const info = join(trash, "info")
    mkdirSync(files, { recursive: true, mode: 0o700 })
    mkdirSync(info, { recursive: true, mode: 0o700 })
    const as = free(files)
    const record = join(info, `${as}.trashinfo`)
    const when = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 19)
    writeFileSync(record, `[Trash Info]\nPath=${abs.split("/").map(encodeURIComponent).join("/")}\nDeletionDate=${when}\n`, { mode: 0o600 })
    try {
      renameSync(abs, join(files, as))
    } catch {
      // Another file system: this trash cannot take it, and nothing is copied behind anyone's back.
      rmSync(record, { force: true })
      return false
    }
    return true
  } catch {
    return false
  }
}

/** One change at a time, for every link of this process: a path that was judged stays what it
 *  was judged to be until the method that judged it has acted, because nothing else that changes
 *  files through these methods runs in between. */
let changes: Promise<unknown> = Promise.resolve()
function oneAtATime<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = changes.then(fn, fn)
  changes = run.catch(() => {})
  return run
}

let swept = false

/** The names under a folder, for a search by name: kept for the few folders searched last. */
interface Names {
  at: number
  all: string[]
}

/** `_lembas/fs/*` for one link. */
export class DeviceFiles {
  private uploads = new Map<string, Upload>()
  private names = new Map<string, Names>()

  constructor(private limits: () => FsLimits | undefined) {
    if (!swept) {
      swept = true
      sweepParts()
    }
  }

  private judging(op: FsOp, path: unknown, deep = false) {
    const L = this.limits()
    const said = typeof path === "string" ? path : ""
    if (!L) return { refused: "off" as FsReason }
    if (PART.test(basename(said))) return { refused: "invalid" as FsReason }
    const home = realPath(homedir())
    return judgePath({ op, path: said, roots: L.roots, own: ownDirs(), guarded, guardedRoots: protectedRoots(), enabled: L.enabled !== false, sharedOnly: L.sharedOnly, maxMode: L.maxMode, real: realPath, deep, ...(L.runsCode === true ? {} : { runsCode: (p: string) => runsCode(p, home) }) })
  }

  /** Where `path` really is for `op`, or the refusal. Nothing is waited for between this and
   *  the act it allows — see `again`. */
  private judge(op: FsOp, path: unknown, deep = false): string {
    const r = this.judging(op, path, deep)
    if ("refused" in r) return refuse(r.refused, typeof path === "string" ? path : "")
    return r.real
  }

  /** After something was waited for: the path judged once more, and still the same place. */
  private again(op: FsOp, path: unknown, first: string, deep = false): void {
    const r = sameAgain(first, this.judging(op, path, deep))
    if ("act" in r) return
    const said = typeof path === "string" ? path : ""
    if (r.refused === "changed") return refuse("changed", said, `${said} is not where it was a moment ago — something moved under it while this was being done. Nothing was written; look at the folder again`)
    return refuse(r.refused, said)
  }

  /** Whether an entry is one these methods will not open (the CLI's own, or protected). */
  private closed(abs: string): boolean {
    const real = realPath(abs)
    return guarded(abs) || guarded(real) || ownDirs().some((d) => inside(real, realPath(d)) || inside(abs, d))
  }

  private isInside(abs: string): boolean {
    const L = this.limits()
    if (!L) return false
    const real = realPath(abs)
    return L.roots.some((r) => inside(real, realPath(resolve(expandHome(r)))))
  }

  private entry(abs: string): Entry {
    const l = lstatSync(abs)
    let link: string | undefined
    let st = l
    let outside = false
    if (l.isSymbolicLink()) {
      link = readlinkSync(abs)
      outside = !this.isInside(abs)
      // What a link that leads out points to is not looked at: its name and target are all that is said.
      if (!outside)
        try {
          st = statSync(abs)
        } catch {}
    }
    return {
      name: basename(abs),
      path: abs,
      kind: outside ? "other" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other",
      size: !outside && st.isFile() ? st.size : 0,
      mtime: Math.round(st.mtimeMs),
      ...(link !== undefined ? { link } : {}),
      ...(outside ? { outside: true as const } : {}),
      ...(this.closed(abs) ? { protected: true as const } : {}),
    }
  }

  /** What is at `abs` now, links followed: a folder, something else, or nothing. */
  private kindOf(abs: string): "dir" | "other" | undefined {
    try {
      return statSync(abs).isDirectory() ? "dir" : "other"
    } catch {
      return undefined
    }
  }

  list(p: any) {
    const L = this.limits()
    const wanted = typeof p?.path === "string" ? p.path.trim() : ""
    if (!wanted) {
      if (!L || L.enabled === false || L.sharedOnly || !L.roots.length) return refuse("off", "")
      const roots = [...new Set(L.roots.map((r) => resolve(expandHome(r))))].filter((d) => existsSync(d))
      return { path: "", entries: roots.sort().map((d) => this.entry(d)) }
    }
    const dir = this.judge("read", wanted)
    const there = this.kindOf(dir)
    if (!there) return refuse("missing", wanted)
    if (there !== "dir") return refuse("not_a_directory", wanted)
    // Folders first, then by name — decided from the directory's own record, so that only the
    // entries that are answered are looked at one by one.
    const all = readdirSync(dir, { withFileTypes: true }).filter((d) => (p?.hidden === true || !d.name.startsWith(".")) && !PART.test(d.name))
    const isDir = (d: (typeof all)[number]) => d.isDirectory() || (d.isSymbolicLink() && this.isInside(join(dir, d.name)) && this.kindOf(join(dir, d.name)) === "dir")
    const ranked = all.map((d) => ({ name: d.name, dir: isDir(d) })).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
    const entries: Entry[] = []
    for (const d of ranked.slice(0, F.list_max)) {
      try {
        entries.push(this.entry(join(dir, d.name)))
      } catch {}
    }
    const up = dirname(dir)
    const parent = up !== dir && this.isInside(up) ? up : ""
    return { path: dir, parent, entries, ...(ranked.length > F.list_max ? { truncated: true } : {}) }
  }

  async stat(p: any) {
    const said = String(p?.path ?? "")
    const abs = this.judge("read", p?.path)
    if (!existsSync(abs)) return refuse("missing", said)
    const e = this.entry(abs)
    if (p?.hash !== true || e.kind !== "file") return e
    // Opened in the same breath as it was judged: the hash is of that file.
    const fd = openSync(abs, "r")
    try {
      return { ...e, hash: await hashFd(fd) }
    } finally {
      closeSync(fd)
    }
  }

  read(p: any) {
    const said = String(p?.path ?? "")
    const abs = this.judge("read", p?.path)
    let fd: number
    try {
      fd = openSync(abs, "r")
    } catch {
      return refuse("missing", said)
    }
    try {
      const st = fstatSync(fd)
      if (!st.isFile()) return refuse("not_a_file", said)
      const offset = Number.isInteger(p?.offset) && p.offset > 0 ? (p.offset as number) : 0
      const length = Math.max(0, Math.min(F.chunk_max_bytes, Number.isInteger(p?.length) && p.length >= 0 ? (p.length as number) : F.chunk_max_bytes))
      const buf = Buffer.alloc(Math.max(0, Math.min(length, st.size - offset)))
      const n = buf.length ? readSync(fd, buf, 0, buf.length, offset) : 0
      const data = buf.subarray(0, n)
      const eof = offset + n >= st.size
      return { path: abs, size: st.size, mtime: Math.round(st.mtimeMs), offset, data: data.toString("base64"), eof, ...(offset === 0 && eof ? { hash: hashBytes(data) } : {}) }
    } finally {
      closeSync(fd)
    }
  }

  private decoded(data: unknown): Buffer {
    if (typeof data !== "string") return refuse("invalid", "", "data must be the content, base64")
    const b = Buffer.from(data, "base64")
    if (b.length > F.chunk_max_bytes) return refuse("too_large", "", `a part may carry at most ${Math.round(F.chunk_max_bytes / 1024)} KB; send the file in parts (more: true)`)
    return b
  }

  /** The hash of the file at `abs` now, or null when there is none. */
  private async current(abs: string): Promise<string | null> {
    let fd: number
    try {
      fd = openSync(abs, "r")
    } catch {
      return null
    }
    try {
      return fstatSync(fd).isFile() ? await hashFd(fd) : null
    } finally {
      closeSync(fd)
    }
  }

  private async checkBase(u: { target: string; base: unknown; overwrite: unknown }, said: string) {
    const current = await this.current(u.target)
    const r = baseCheck({ base: u.base, overwrite: u.overwrite, current })
    if ("write" in r) return
    if (r.refused === "changed") {
      let mtime: number | null = null
      try {
        mtime = Math.round(statSync(u.target).mtimeMs)
      } catch {}
      return refuse("changed", said, current === null ? `${said} is gone from the computer since you opened it — nothing was written` : `${said} changed on the computer since you opened it — nothing was written. Open it again, or overwrite it on purpose`, { hash: current, mtime })
    }
    if (r.refused === "exists") return refuse("exists", said)
    return refuse("invalid", said, "a write says what it expects to find: base (the hash last seen, or null for a new file), or overwrite: true")
  }

  private drop(u: Upload) {
    clearTimeout(u.timer)
    this.uploads.delete(u.id)
    // The part file is removed by its name only while that name is still in the target's own
    // directory. Where the folder was moved from under it, the name may lead anywhere: the file
    // is emptied through its descriptor instead, and left where it lies.
    const inPlace = partInPlace(u.part)
    try {
      if (!inPlace) ftruncateSync(u.fd, 0)
    } catch {}
    try {
      closeSync(u.fd)
    } catch {}
    if (inPlace) rmSync(u.part, { force: true })
    journal((list) => list.filter((x) => x !== u.part))
  }

  private idle(u: Upload) {
    clearTimeout(u.timer)
    u.timer = setTimeout(() => this.drop(u), F.upload_idle_seconds * 1000)
    ;(u.timer as { unref?: () => void }).unref?.()
  }

  /** One part into an upload's part file — by its descriptor, never by name — within the cap. */
  private take(u: Upload, data: Buffer) {
    if (u.received + data.length > F.upload_max_bytes) {
      this.drop(u)
      return refuse("too_large", u.said, `${u.said} is larger than the ${Math.round(F.upload_max_bytes / 1024 / 1024)} MB one file may be from here — nothing was written`)
    }
    writeSync(u.fd, data)
    u.received += data.length
  }

  write(p: any) {
    return oneAtATime(() => this.writing(p))
  }

  private async writing(p: any) {
    // A later part of an upload already begun.
    if (typeof p?.upload === "string") {
      const u = this.uploads.get(p.upload)
      if (!u) return refuse("invalid", "", "that upload is not open any more — start the write again")
      const data = this.decoded(p.data)
      try {
        // Judged again with every part: the limits, and the place, may have changed since the first.
        this.again("write", u.target, u.target)
        this.take(u, data)
      } catch (e) {
        if (this.uploads.has(u.id)) this.drop(u)
        throw e
      }
      if (p.more === true) {
        this.idle(u)
        return { upload: u.id, received: u.received }
      }
      return this.commit(u)
    }
    const said = String(p?.path ?? "")
    const target = this.judge("write", p?.path)
    if (this.kindOf(target) === "dir") return refuse("not_a_file", said)
    if (!existsSync(dirname(target))) return refuse("missing", dirname(said), `the folder ${dirname(said)} does not exist on this computer — make it first`)
    const data = this.decoded(p?.data)
    if (p?.more === true && this.uploads.size >= F.uploads_max) return refuse("too_large", said, `this computer already takes ${F.uploads_max} files at once — wait for one to finish`)
    // Hashing what is there is waited for — so the path is judged again after it, and the part
    // file is opened in the same breath as that second look.
    await this.checkBase({ target, base: p?.base, overwrite: p?.overwrite }, said)
    this.again("write", p?.path, target)
    const id = crypto.randomUUID()
    const part = join(dirname(target), `.${basename(target)}.${id.slice(0, 8)}.lembas-part`)
    journal((list) => [...list, part])
    let fd: number
    try {
      fd = openSync(part, "wx", 0o600)
    } catch (e) {
      journal((list) => list.filter((x) => x !== part))
      throw e
    }
    const u: Upload = { id, target, part, fd, received: 0, said, base: p?.base, overwrite: p?.overwrite, timer: setTimeout(() => {}, 0) }
    this.uploads.set(id, u)
    try {
      this.take(u, data)
    } catch (e) {
      if (this.uploads.has(id)) this.drop(u)
      throw e
    }
    if (p?.more === true) {
      this.idle(u)
      return { upload: id, received: u.received }
    }
    return this.commit(u)
  }

  /** The last part is in: the base checked once more, the path judged once more, the part file
   *  proved to be where the target is — and then, with nothing waited for in between, the file
   *  put in place whole. */
  private async commit(u: Upload) {
    try {
      closeSync(u.fd)
      await this.checkBase(u, u.said)
      this.again("write", u.target, u.target)
      if (!partInPlace(u.part)) refuse("changed", u.said, `${u.said} is not where it was a moment ago — something moved under it while this was being done. Nothing was written; look at the folder again`)
      // The file keeps its mode; a new one gets the usual.
      let mode = 0o644
      try {
        mode = statSync(u.target).mode & 0o777
      } catch {}
      chmodSync(u.part, mode)
      renameSync(u.part, u.target)
    } catch (e) {
      if (partInPlace(u.part)) rmSync(u.part, { force: true })
      throw e
    } finally {
      clearTimeout(u.timer)
      this.uploads.delete(u.id)
      journal((list) => list.filter((x) => x !== u.part))
    }
    const fd = openSync(u.target, "r")
    try {
      const st = fstatSync(fd)
      return { path: u.target, size: st.size, mtime: Math.round(st.mtimeMs), hash: await hashFd(fd) }
    } finally {
      closeSync(fd)
    }
  }

  mkdir(p: any) {
    return oneAtATime(() => {
      const said = String(p?.path ?? "")
      const abs = this.judge("write", p?.path)
      const there = this.kindOf(abs)
      if (there === "dir") return { path: abs }
      if (there) return refuse("exists", said, `${said} exists on this computer and is not a folder`)
      mkdirSync(abs, { recursive: true })
      return { path: abs }
    })
  }

  /** The target of a move or a copy: free, or to be replaced when the client said so — a folder
   *  is never replaced. */
  private target(to: unknown, overwrite: unknown): string {
    const said = String(to ?? "")
    const abs = this.judge("write", to, true)
    let st: ReturnType<typeof lstatSync> | undefined
    try {
      st = lstatSync(abs)
    } catch {}
    if (st && (overwrite !== true || st.isDirectory())) return refuse("exists", said)
    if (!existsSync(dirname(abs))) return refuse("missing", dirname(said), `the folder ${dirname(said)} does not exist on this computer — make it first`)
    return abs
  }

  /** A whole tree copied, off the main thread: a link is copied as a link, never followed. */
  private tree(from: string, to: string) {
    return cp(from, to, { recursive: true, verbatimSymlinks: true, force: true })
  }

  move(p: any) {
    return oneAtATime(async () => {
      const from = this.judge("remove", p?.from)
      try {
        lstatSync(from)
      } catch {
        return refuse("missing", String(p?.from))
      }
      const to = this.target(p?.to, p?.overwrite)
      if (inside(to, from)) return refuse("invalid", String(p?.to), "a folder cannot be moved into itself")
      try {
        renameSync(from, to)
      } catch (e) {
        if ((e as { code?: string }).code !== "EXDEV") throw e
        // Another file system: copied whole, then the original removed. Nothing else changes
        // files from here meanwhile (oneAtATime).
        await this.tree(from, to)
        await rm(from, { recursive: true, force: true })
      }
      return { path: to }
    })
  }

  copy(p: any) {
    return oneAtATime(async () => {
      const from = this.judge("read", p?.from, true)
      if (!existsSync(from)) return refuse("missing", String(p?.from))
      const to = this.target(p?.to, p?.overwrite)
      if (inside(to, from)) return refuse("invalid", String(p?.to), "a folder cannot be copied into itself")
      await this.tree(from, to)
      return { path: to }
    })
  }

  delete(p: any) {
    return oneAtATime(async () => {
      const said = String(p?.path ?? "")
      const abs = this.judge("remove", p?.path)
      try {
        lstatSync(abs)
      } catch {
        return refuse("missing", said)
      }
      if (p?.permanent !== true) {
        if (moveToTrash(abs)) return { deleted: true, trash: true }
        return refuse("no_trash", said, `this computer has no trash that can take ${said}: deleting it cannot be undone. Send the delete again with permanent: true once the person has agreed`)
      }
      await rm(abs, { recursive: true, force: true })
      return { deleted: true, trash: false }
    })
  }

  /** The names under `root`, listed off the main thread and kept a few seconds; the folders
   *  searched longest ago are forgotten beyond `files.indexes_max`. */
  private async namesOf(root: string): Promise<string[]> {
    const kept = this.names.get(root)
    if (kept && Date.now() - kept.at < 5000) {
      this.names.delete(root)
      this.names.set(root, kept)
      return kept.all
    }
    const MAX = 50_000
    const files: string[] = []
    if (Bun.which("rg") !== null) {
      // Gitignored files are left out (ripgrep's own rule); hidden ones are named.
      const proc = Bun.spawn(["rg", "--files", "--hidden", "--glob", "!.git"], { cwd: root, stdout: "pipe", stderr: "ignore", stdin: "ignore" })
      const timer = setTimeout(() => proc.kill(), 20_000)
      let buf = ""
      const decoder = new TextDecoder()
      try {
        outer: for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
          buf += decoder.decode(chunk, { stream: true })
          let nl: number
          while ((nl = buf.indexOf("\n")) >= 0) {
            const f = buf.slice(0, nl)
            buf = buf.slice(nl + 1)
            if (f) files.push(f)
            if (files.length >= MAX) break outer
          }
        }
      } finally {
        clearTimeout(timer)
        proc.kill()
      }
    } else {
      let n = 0
      for await (const f of new Bun.Glob("**/*").scan({ cwd: root, dot: true, onlyFiles: true, followSymlinks: false })) {
        if (f.split("/").some((x) => x === ".git" || x === "node_modules")) continue
        files.push(f)
        if (files.length >= MAX) break
        if (++n % 500 === 0) await yieldNow()
      }
    }
    const dirs = new Set<string>()
    for (const f of files) {
      const parts = f.split("/")
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/") + "/")
    }
    const all = [...dirs, ...files].filter((f) => !PART.test(basename(f))).sort()
    this.names.delete(root)
    this.names.set(root, { at: Date.now(), all })
    while (this.names.size > F.indexes_max) this.names.delete(this.names.keys().next().value!)
    return all
  }

  async search(p: any) {
    const said = String(p?.path ?? "")
    const root = this.judge("read", p?.path)
    const there = this.kindOf(root)
    if (!there) return refuse("missing", said)
    if (there !== "dir") return refuse("not_a_directory", said)
    const query = typeof p?.query === "string" ? p.query : ""
    // Judged as each is answered, not when the search began: what is named can still be opened.
    const open = (rel: string) => {
      const abs = join(root, rel)
      return !PART.test(basename(rel)) && !this.closed(abs) && this.isInside(abs)
    }
    if (p?.content !== true) {
      const limit = Math.max(1, Math.min(50, Number(p?.limit) || 20))
      const all = await this.namesOf(root)
      const hits = query ? fuzzysort.go(query, all, { limit: 200, threshold: -10000 }).map((h) => h.target) : all
      const found = hits.filter((f) => open(f.replace(/\/$/, ""))).slice(0, limit)
      return { root, files: found.map((f) => ({ path: f.replace(/\/$/, ""), kind: f.endsWith("/") ? "dir" : "file" })) }
    }
    if (!query) return refuse("invalid", said, "query must say what to look for")
    if (Bun.which("rg") === null) return refuse("invalid", said, "searching inside files needs ripgrep (rg) on this computer")
    const limit = Math.max(1, Math.min(F.search_max, Number(p?.limit) || F.search_max))
    // Gitignored files are left out (ripgrep's own rule); hidden ones are looked into.
    const args = ["rg", "--line-number", "--no-heading", "--color", "never", "--hidden", "--glob", "!.git", "--glob", "!*.lembas-part", "--max-columns", "400", "--null", ...(p?.regex === true ? [] : ["--fixed-strings"]), "-e", query, "."]
    const proc = Bun.spawn(args, { cwd: root, stdout: "pipe", stderr: "ignore", stdin: "ignore" })
    const timer = setTimeout(() => proc.kill(), 20_000)
    const matches: { path: string; line: number; text: string }[] = []
    let truncated = false
    let buf = ""
    const decoder = new TextDecoder()
    try {
      for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true })
        let nl: number
        while ((nl = buf.indexOf("\n")) >= 0) {
          const row = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          const nul = row.indexOf("\u0000")
          if (nul < 0) continue
          const path = row.slice(0, nul).replace(/^\.\//, "")
          const m = /^(\d+):(.*)$/s.exec(row.slice(nul + 1))
          if (!m || !open(path)) continue
          if (matches.length >= limit) {
            truncated = true
            break
          }
          matches.push({ path, line: Number(m[1]), text: m[2]!.slice(0, 400) })
        }
        if (truncated) break
      }
    } finally {
      clearTimeout(timer)
      proc.kill()
    }
    return { root, matches, ...(truncated ? { truncated: true } : {}) }
  }

  /** The link is gone: unfinished uploads go with it. */
  close() {
    for (const u of [...this.uploads.values()]) this.drop(u)
    this.names.clear()
  }
}
