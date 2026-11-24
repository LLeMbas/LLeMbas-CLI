// Device files (harness/acp.md, spec 3.11.0, capability `fs`): `_lembas/fs/*`, the person's own
// hands on the files of this computer from a client's file manager — no model, no tool, no card.
// What bounds them is this device: only inside `remote.roots` with remote work on; a path judged
// where it really is, symlinks followed first; never the CLI's own files, never a protected path;
// read-only where the device allows plan mode only. conformance/device_files.json.
import { closeSync, cpSync, createReadStream, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readlinkSync, readSync, renameSync, rmSync, statSync, writeFileSync, writeSync, chmodSync } from "node:fs"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { expandHome, globalPaths, paths } from "../config/paths.ts"
import type { Mode } from "../config/schema.ts"
import { LOOP } from "../harness.ts"
import { realPath } from "../permission/evaluate.ts"
import { protectedPath, protectedRoots } from "../permission/hardline.ts"
import { FileIndex } from "../project/files.ts"
import { INVALID_PARAMS, RpcError } from "./rpc.ts"

const F = LOOP.files

export type FsReason = "off" | "invalid" | "outside" | "own" | "protected" | "read_only" | "missing" | "exists" | "changed" | "not_a_file" | "not_a_directory" | "no_trash" | "too_large"

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
}

/** Whether a method may touch `path`, and where it really is (`kind: path`). The first that
 *  applies of off, invalid, outside, own, protected, read_only. */
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
  if (o.op !== "read" && o.maxMode === "plan") return { refused: "read_only" }
  return { ok: true, real }
}

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
}

const refuse = (reason: FsReason, path: string, message?: string, extra: Record<string, unknown> = {}): never => {
  throw new RpcError(INVALID_PARAMS, message ?? SENTENCES[reason]?.(path) ?? `${path}: ${reason}`, { reason, ...extra })
}

/** The CLI's own directories: its configuration, data and state — the user's, and local mode's. */
export function ownDirs(): string[] {
  return [...new Set([paths.config, paths.data, paths.state, globalPaths.config, globalPaths.data, globalPaths.state])]
}

const guarded = (p: string) => protectedPath(p) !== undefined

/** `sha256:` and the hex digest of a file's content, read in pieces. */
export async function hashFile(abs: string): Promise<string> {
  const h = createHash("sha256")
  for await (const chunk of createReadStream(abs)) h.update(chunk as Buffer)
  return `sha256:${h.digest("hex")}`
}

const hashBytes = (b: Uint8Array) => `sha256:${createHash("sha256").update(b).digest("hex")}`

interface Upload {
  id: string
  /** Where the file really goes, and the part file beside it. */
  target: string
  part: string
  fd: number
  received: number
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

/** `_lembas/fs/*` for one link. */
export class DeviceFiles {
  private uploads = new Map<string, Upload>()
  private indexes = new Map<string, FileIndex>()

  constructor(private limits: () => FsLimits | undefined) {}

  /** Where `path` really is for `op`, or the refusal. */
  private judge(op: FsOp, path: unknown, deep = false): string {
    const L = this.limits()
    const said = typeof path === "string" ? path : ""
    if (!L) return refuse("off", said)
    const r = judgePath({ op, path: said, roots: L.roots, own: ownDirs(), guarded, guardedRoots: protectedRoots(), enabled: L.enabled !== false, sharedOnly: L.sharedOnly, maxMode: L.maxMode, real: realPath, deep })
    if ("refused" in r) return refuse(r.refused, said)
    return r.real
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
    if (l.isSymbolicLink()) {
      link = readlinkSync(abs)
      try {
        st = statSync(abs)
      } catch {}
    }
    const outside = link !== undefined && !this.isInside(abs)
    return {
      name: basename(abs),
      path: abs,
      kind: st.isDirectory() ? "dir" : st.isFile() ? "file" : "other",
      size: st.isFile() ? st.size : 0,
      mtime: Math.round(st.mtimeMs),
      ...(link !== undefined ? { link } : {}),
      ...(outside ? { outside: true as const } : {}),
      ...(this.closed(abs) ? { protected: true as const } : {}),
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
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(dir)
    } catch {
      return refuse("missing", wanted)
    }
    if (!st.isDirectory()) return refuse("not_a_directory", wanted)
    const names = readdirSync(dir).filter((n) => p?.hidden === true || !n.startsWith("."))
    const entries: Entry[] = []
    for (const n of names) {
      try {
        entries.push(this.entry(join(dir, n)))
      } catch {}
    }
    entries.sort((a, b) => (a.kind === "dir" ? 0 : 1) - (b.kind === "dir" ? 0 : 1) || a.name.localeCompare(b.name))
    const up = dirname(dir)
    const parent = up !== dir && this.isInside(up) ? up : ""
    return { path: dir, parent, entries: entries.slice(0, F.list_max), ...(entries.length > F.list_max ? { truncated: true } : {}) }
  }

  async stat(p: any) {
    const abs = this.judge("read", p?.path)
    if (!existsSync(abs)) return refuse("missing", String(p?.path))
    const e = this.entry(abs)
    return { ...e, ...(p?.hash === true && e.kind === "file" ? { hash: await hashFile(abs) } : {}) }
  }

  /** What is at `abs` now, links followed: a folder, something else, or nothing. */
  private kindOf(abs: string): "dir" | "other" | undefined {
    try {
      return statSync(abs).isDirectory() ? "dir" : "other"
    } catch {
      return undefined
    }
  }

  private file(abs: string, said: string) {
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(abs)
    } catch {
      return refuse("missing", said)
    }
    if (!st.isFile()) return refuse("not_a_file", said)
    return st
  }

  read(p: any) {
    const said = String(p?.path ?? "")
    const abs = this.judge("read", p?.path)
    const st = this.file(abs, said)
    const offset = Number.isInteger(p?.offset) && p.offset > 0 ? (p.offset as number) : 0
    const length = Math.max(0, Math.min(F.chunk_max_bytes, Number.isInteger(p?.length) && p.length >= 0 ? (p.length as number) : F.chunk_max_bytes))
    const buf = Buffer.alloc(Math.max(0, Math.min(length, st.size - offset)))
    const fd = openSync(abs, "r")
    let n = 0
    try {
      if (buf.length) n = readSync(fd, buf, 0, buf.length, offset)
    } finally {
      closeSync(fd)
    }
    const data = buf.subarray(0, n)
    const eof = offset + n >= st.size
    return { path: abs, size: st.size, mtime: Math.round(st.mtimeMs), offset, data: data.toString("base64"), eof, ...(offset === 0 && eof ? { hash: hashBytes(data) } : {}) }
  }

  private decoded(data: unknown): Buffer {
    if (typeof data !== "string") return refuse("invalid", "", "data must be the content, base64")
    const b = Buffer.from(data, "base64")
    if (b.length > F.chunk_max_bytes) return refuse("too_large", "", `a part may carry at most ${Math.round(F.chunk_max_bytes / 1024)} KB; send the file in parts (more: true)`)
    return b
  }

  private async current(abs: string): Promise<string | null> {
    try {
      if (!statSync(abs).isFile()) return null
    } catch {
      return null
    }
    return hashFile(abs)
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
    try {
      closeSync(u.fd)
    } catch {}
    rmSync(u.part, { force: true })
  }

  private idle(u: Upload) {
    clearTimeout(u.timer)
    u.timer = setTimeout(() => this.drop(u), F.upload_idle_seconds * 1000)
    ;(u.timer as { unref?: () => void }).unref?.()
  }

  async write(p: any) {
    // A later part of an upload already begun.
    if (typeof p?.upload === "string") {
      const u = this.uploads.get(p.upload)
      if (!u) return refuse("invalid", "", "that upload is not open any more — start the write again")
      // Judged again: the limits may have changed since the first part.
      this.judge("write", u.target)
      const data = this.decoded(p.data)
      writeSync(u.fd, data)
      u.received += data.length
      if (p.more === true) {
        this.idle(u)
        return { upload: u.id, received: u.received }
      }
      return this.commit(u, u.target)
    }
    const said = String(p?.path ?? "")
    const target = this.judge("write", p?.path)
    if (this.kindOf(target) === "dir") return refuse("not_a_file", said)
    if (!existsSync(dirname(target))) return refuse("missing", dirname(said), `the folder ${dirname(said)} does not exist on this computer — make it first`)
    const data = this.decoded(p?.data)
    await this.checkBase({ target, base: p?.base, overwrite: p?.overwrite }, said)
    if (p?.more === true && this.uploads.size >= F.uploads_max) return refuse("too_large", said, `this computer already takes ${F.uploads_max} files at once — wait for one to finish`)
    const id = crypto.randomUUID()
    const part = join(dirname(target), `.${basename(target)}.${id.slice(0, 8)}.lembas-part`)
    const u: Upload = { id, target, part, fd: openSync(part, "wx", 0o600), received: 0, base: p?.base, overwrite: p?.overwrite, timer: setTimeout(() => {}, 0) }
    this.uploads.set(id, u)
    try {
      writeSync(u.fd, data)
      u.received = data.length
    } catch (e) {
      this.drop(u)
      throw e
    }
    if (p?.more === true) {
      this.idle(u)
      return { upload: id, received: u.received }
    }
    return this.commit(u, said)
  }

  /** The last part is in: the base checked once more, then the file put in place whole. */
  private async commit(u: Upload, said: string) {
    try {
      closeSync(u.fd)
      await this.checkBase(u, said)
      // The file keeps its mode; a new one gets the usual.
      let mode = 0o644
      try {
        mode = statSync(u.target).mode & 0o777
      } catch {}
      chmodSync(u.part, mode)
      renameSync(u.part, u.target)
    } catch (e) {
      rmSync(u.part, { force: true })
      throw e
    } finally {
      clearTimeout(u.timer)
      this.uploads.delete(u.id)
    }
    const st = statSync(u.target)
    return { path: u.target, size: st.size, mtime: Math.round(st.mtimeMs), hash: await hashFile(u.target) }
  }

  mkdir(p: any) {
    const said = String(p?.path ?? "")
    const abs = this.judge("write", p?.path)
    const there = this.kindOf(abs)
    if (there === "dir") return { path: abs }
    if (there) return refuse("exists", said, `${said} exists on this computer and is not a folder`)
    mkdirSync(abs, { recursive: true })
    return { path: abs }
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

  move(p: any) {
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
      // Another file system: copied whole, then the original removed.
      cpSync(from, to, { recursive: true, verbatimSymlinks: true, force: true })
      rmSync(from, { recursive: true, force: true })
    }
    return { path: to }
  }

  copy(p: any) {
    const from = this.judge("read", p?.from, true)
    if (!existsSync(from)) return refuse("missing", String(p?.from))
    const to = this.target(p?.to, p?.overwrite)
    if (inside(to, from)) return refuse("invalid", String(p?.to), "a folder cannot be copied into itself")
    // A link is copied as a link, never followed: a copy does not reach what a link points to.
    cpSync(from, to, { recursive: true, verbatimSymlinks: true, force: true })
    return { path: to }
  }

  delete(p: any) {
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
    rmSync(abs, { recursive: true, force: true })
    return { deleted: true, trash: false }
  }

  async search(p: any) {
    const said = String(p?.path ?? "")
    const root = this.judge("read", p?.path)
    const there = this.kindOf(root)
    if (!there) return refuse("missing", said)
    if (there !== "dir") return refuse("not_a_directory", said)
    const query = typeof p?.query === "string" ? p.query : ""
    const open = (rel: string) => {
      const abs = join(root, rel)
      return !this.closed(abs) && this.isInside(abs)
    }
    if (p?.content !== true) {
      const limit = Math.max(1, Math.min(50, Number(p?.limit) || 20))
      let index = this.indexes.get(root)
      if (!index) this.indexes.set(root, (index = new FileIndex(root)))
      const found = index.search(query, limit).filter((f) => open(f.replace(/\/$/, "")))
      return { root, files: found.map((f) => ({ path: f.replace(/\/$/, ""), kind: f.endsWith("/") ? "dir" : "file" })) }
    }
    if (!query) return refuse("invalid", said, "query must say what to look for")
    if (Bun.which("rg") === null) return refuse("invalid", said, "searching inside files needs ripgrep (rg) on this computer")
    const limit = Math.max(1, Math.min(F.search_max, Number(p?.limit) || F.search_max))
    // Gitignored files are left out (ripgrep's own rule); hidden ones are looked into.
    const args = ["rg", "--line-number", "--no-heading", "--color", "never", "--hidden", "--glob", "!.git", "--max-columns", "400", "--null", ...(p?.regex === true ? [] : ["--fixed-strings"]), "-e", query, "."]
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
  }
}
