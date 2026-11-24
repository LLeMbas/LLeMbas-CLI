// Device files (harness/acp.md, spec 3.11.0, capability `fs`): `_lembas/fs/*` on the link — every
// method, and every refusal: outside the roots, through a link that points out, the CLI's own
// files, a protected path, a read-only device, remote work off, and `serve --stdio`.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { AcpAgent, type Limits } from "../src/acp/agent.ts"
import { moveToTrash } from "../src/acp/files.ts"
import { Peer, type Transport } from "../src/acp/rpc.ts"
import { paths } from "../src/config/paths.ts"

function pair(): [Transport, Transport] {
  const make = () => ({ msg: (_: string) => {}, end: () => {} })
  const a = make()
  const b = make()
  const side = (me: typeof a, other: typeof a): Transport => ({
    send: (t) => queueMicrotask(() => other.msg(t)),
    onMessage: (fn) => (me.msg = fn),
    onClose: (fn) => (me.end = fn),
    close: () => (me.end(), other.end()),
  })
  return [side(a, b), side(b, a)]
}

const made: string[] = []
const temp = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  made.push(d)
  return d
}

let root: string
let outside: string
let trashHome: string
const oldData = process.env.XDG_DATA_HOME
beforeEach(() => {
  root = temp("ph-fs-root-")
  outside = temp("ph-fs-out-")
  // The trash of the test's own data directory, never the person's.
  trashHome = temp("ph-fs-data-")
  process.env.XDG_DATA_HOME = trashHome
  mkdirSync(join(root, "docs"))
  writeFileSync(join(root, "docs/notes.md"), "# Notes\nwaybread\n")
  writeFileSync(join(root, "a.txt"), "alpha\n")
  writeFileSync(join(root, ".hidden"), "h\n")
  writeFileSync(join(outside, "secret.txt"), "not yours\n")
})
afterEach(() => {
  if (oldData === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = oldData
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})

const limitsFor = (extra: Partial<Limits> = {}): Limits => ({ roots: [root], maxMode: "auto", approvalTimeoutMs: 3000, requireTrust: true, enabled: true, ...extra })

async function link(limits: Limits | "stdio" = limitsFor()) {
  const [ta, tb] = pair()
  new AcpAgent(new Peer(ta), limits === "stdio" ? undefined : limits)
  const c = new Peer(tb)
  await c.request("initialize", { protocolVersion: 1, clientCapabilities: { _meta: { lembas: { protocol: 3 } } } })
  return { c, close: () => tb.close() }
}

const refusal = async (p: Promise<unknown>) => p.then(() => ({ message: "(answered)", reason: undefined as string | undefined, data: undefined as any }), (e) => ({ message: (e as Error).message, reason: (e as any).data?.reason as string | undefined, data: (e as any).data }))
const b64 = (s: string | Uint8Array) => Buffer.from(s).toString("base64")
const hash = (s: string | Uint8Array) => `sha256:${createHash("sha256").update(s).digest("hex")}`

test("list: the roots without a path; a folder's entries, folders first, hidden ones on request", async () => {
  const { c } = await link()
  const top: any = await c.request("_lembas/fs/list", {})
  expect(top.path).toBe("")
  expect(top.entries.map((e: any) => e.path)).toEqual([root])
  const l: any = await c.request("_lembas/fs/list", { path: root })
  expect(l.path).toBe(root)
  expect(l.parent).toBe("")
  expect(l.entries.map((e: any) => [e.name, e.kind])).toEqual([["docs", "dir"], ["a.txt", "file"]])
  expect(l.entries[1]).toMatchObject({ path: join(root, "a.txt"), size: 6 })
  expect(typeof l.entries[1].mtime).toBe("number")
  const all: any = await c.request("_lembas/fs/list", { path: root, hidden: true })
  expect(all.entries.map((e: any) => e.name)).toContain(".hidden")
  const sub: any = await c.request("_lembas/fs/list", { path: join(root, "docs") })
  expect(sub.parent).toBe(root)
  expect((await refusal(c.request("_lembas/fs/list", { path: join(root, "a.txt") }))).reason).toBe("not_a_directory")
  expect((await refusal(c.request("_lembas/fs/list", { path: join(root, "nope") }))).reason).toBe("missing")
})

test("stat and read: a file's size, time and hash; a large file in parts", async () => {
  const { c } = await link()
  const st: any = await c.request("_lembas/fs/stat", { path: join(root, "a.txt"), hash: true })
  expect(st).toMatchObject({ name: "a.txt", kind: "file", size: 6, hash: hash("alpha\n") })
  expect((await c.request<any>("_lembas/fs/stat", { path: join(root, "docs") })).kind).toBe("dir")
  const whole: any = await c.request("_lembas/fs/read", { path: join(root, "a.txt") })
  expect(Buffer.from(whole.data, "base64").toString()).toBe("alpha\n")
  expect(whole).toMatchObject({ size: 6, offset: 0, eof: true, hash: hash("alpha\n") })
  // In parts: no hash on a part, eof on the last.
  const one: any = await c.request("_lembas/fs/read", { path: join(root, "a.txt"), offset: 0, length: 2 })
  expect(one).toMatchObject({ offset: 0, eof: false })
  expect(one.hash).toBeUndefined()
  const two: any = await c.request("_lembas/fs/read", { path: join(root, "a.txt"), offset: 2, length: 100 })
  expect(Buffer.from(one.data, "base64").toString() + Buffer.from(two.data, "base64").toString()).toBe("alpha\n")
  expect(two.eof).toBe(true)
  expect((await refusal(c.request("_lembas/fs/read", { path: join(root, "docs") }))).reason).toBe("not_a_file")
  expect((await refusal(c.request("_lembas/fs/read", { path: join(root, "nope.txt") }))).reason).toBe("missing")
  expect((await refusal(c.request("_lembas/fs/read", { path: "a.txt" }))).reason).toBe("invalid")
})

test("write: the base is what the client last saw — written, refused when changed, created with null", async () => {
  const { c } = await link()
  const file = join(root, "a.txt")
  // As last seen: written, whole, keeping the file's mode.
  const w: any = await c.request("_lembas/fs/write", { path: file, data: b64("beta\n"), base: hash("alpha\n") })
  expect(w).toMatchObject({ path: file, size: 5, hash: hash("beta\n") })
  expect(readFileSync(file, "utf8")).toBe("beta\n")
  // Changed since: refused in words, with what is there now; nothing written.
  const stale = await refusal(c.request("_lembas/fs/write", { path: file, data: b64("gamma\n"), base: hash("alpha\n") }))
  expect(stale.reason).toBe("changed")
  expect(stale.message).toContain("changed on the computer since you opened it")
  expect(stale.data.hash).toBe(hash("beta\n"))
  expect(readFileSync(file, "utf8")).toBe("beta\n")
  // A new file: null where there is none; refused where there is one.
  await c.request("_lembas/fs/write", { path: join(root, "new.txt"), data: b64("n\n"), base: null })
  expect(readFileSync(join(root, "new.txt"), "utf8")).toBe("n\n")
  expect((await refusal(c.request("_lembas/fs/write", { path: file, data: b64("x"), base: null }))).reason).toBe("exists")
  // No base said: refused, unless the client says to overwrite.
  expect((await refusal(c.request("_lembas/fs/write", { path: file, data: b64("x") }))).reason).toBe("invalid")
  await c.request("_lembas/fs/write", { path: file, data: b64("forced\n"), overwrite: true })
  expect(readFileSync(file, "utf8")).toBe("forced\n")
  // Gone since it was opened.
  rmSync(file)
  const gone = await refusal(c.request("_lembas/fs/write", { path: file, data: b64("x"), base: hash("forced\n") }))
  expect(gone.reason).toBe("changed")
  expect(gone.data.hash).toBeNull()
  // A folder is not a file; a folder that is not there is not made on the way.
  expect((await refusal(c.request("_lembas/fs/write", { path: join(root, "docs"), data: b64("x"), overwrite: true }))).reason).toBe("not_a_file")
  expect((await refusal(c.request("_lembas/fs/write", { path: join(root, "no/such/f.txt"), data: b64("x"), base: null }))).reason).toBe("missing")
  // Nothing of a part file is left behind.
  expect(readdirSync(root).filter((n) => n.includes("lembas-part"))).toEqual([])
})

test("write: a large file in parts; the base is checked again as it is put in place; an unfinished one goes with the link", async () => {
  const { c, close } = await link()
  const file = join(root, "big.bin")
  const first: any = await c.request("_lembas/fs/write", { path: file, data: b64("part one, "), base: null, more: true })
  expect(first.received).toBe(10)
  // Until the last part, the file is not there: a reader never sees half of it.
  expect(existsSync(file)).toBe(false)
  const mid: any = await c.request("_lembas/fs/write", { upload: first.upload, data: b64("part two, "), more: true })
  expect(mid).toEqual({ upload: first.upload, received: 20 })
  const done: any = await c.request("_lembas/fs/write", { upload: first.upload, data: b64("part three") })
  expect(done).toMatchObject({ path: file, size: 30, hash: hash("part one, part two, part three") })
  expect(readFileSync(file, "utf8")).toBe("part one, part two, part three")
  expect((await refusal(c.request("_lembas/fs/write", { upload: first.upload, data: b64("x") }))).reason).toBe("invalid")
  // Somebody else writes the file while an upload over it is under way: the last part is refused.
  const up: any = await c.request("_lembas/fs/write", { path: file, data: b64("new "), base: done.hash, more: true })
  writeFileSync(file, "changed meanwhile")
  expect((await refusal(c.request("_lembas/fs/write", { upload: up.upload, data: b64("content") }))).reason).toBe("changed")
  expect(readFileSync(file, "utf8")).toBe("changed meanwhile")
  // A part over the limit is refused.
  expect((await refusal(c.request("_lembas/fs/write", { path: join(root, "huge"), data: Buffer.alloc(1024 * 1024 + 1).toString("base64"), base: null }))).reason).toBe("too_large")
  // An upload left open is dropped when the link goes.
  await c.request("_lembas/fs/write", { path: join(root, "left.bin"), data: b64("x"), base: null, more: true })
  expect(readdirSync(root).filter((n) => n.includes("lembas-part")).length).toBe(1)
  close()
  await Bun.sleep(20)
  expect(readdirSync(root).filter((n) => n.includes("lembas-part"))).toEqual([])
  expect(existsSync(join(root, "left.bin"))).toBe(false)
})

test("mkdir, move and copy: made with parents; a target that exists is refused unless overwritten; a folder never replaced", async () => {
  const { c } = await link()
  expect(await c.request<any>("_lembas/fs/mkdir", { path: join(root, "x/y/z") })).toEqual({ path: join(root, "x/y/z") })
  expect(await c.request<any>("_lembas/fs/mkdir", { path: join(root, "x/y/z") })).toEqual({ path: join(root, "x/y/z") })
  expect((await refusal(c.request("_lembas/fs/mkdir", { path: join(root, "a.txt") }))).reason).toBe("exists")
  // Copy a folder with all in it; a link inside is copied as a link, not followed.
  symlinkSync(join(outside, "secret.txt"), join(root, "docs/out-link"))
  await c.request("_lembas/fs/copy", { from: join(root, "docs"), to: join(root, "docs2") })
  expect(readFileSync(join(root, "docs2/notes.md"), "utf8")).toBe("# Notes\nwaybread\n")
  expect(lstatSync(join(root, "docs2/out-link")).isSymbolicLink()).toBe(true)
  expect((await refusal(c.request("_lembas/fs/copy", { from: join(root, "a.txt"), to: join(root, "docs2") }))).reason).toBe("exists")
  expect((await refusal(c.request("_lembas/fs/copy", { from: join(root, "a.txt"), to: join(root, "docs2"), overwrite: true }))).reason).toBe("exists")
  expect((await refusal(c.request("_lembas/fs/copy", { from: join(root, "nope"), to: join(root, "n2") }))).reason).toBe("missing")
  expect((await refusal(c.request("_lembas/fs/copy", { from: join(root, "docs"), to: join(root, "docs/inner") }))).reason).toBe("invalid")
  // Move: a rename; onto a file only with overwrite.
  writeFileSync(join(root, "b.txt"), "beta\n")
  expect((await refusal(c.request("_lembas/fs/move", { from: join(root, "a.txt"), to: join(root, "b.txt") }))).reason).toBe("exists")
  expect(await c.request<any>("_lembas/fs/move", { from: join(root, "a.txt"), to: join(root, "b.txt"), overwrite: true })).toEqual({ path: join(root, "b.txt") })
  expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("alpha\n")
  expect(existsSync(join(root, "a.txt"))).toBe(false)
  expect((await refusal(c.request("_lembas/fs/move", { from: join(root, "a.txt"), to: join(root, "c.txt") }))).reason).toBe("missing")
  expect((await refusal(c.request("_lembas/fs/move", { from: join(root, "b.txt"), to: join(root, "no/dir/c.txt") }))).reason).toBe("missing")
  // The root itself is never moved or deleted.
  expect((await refusal(c.request("_lembas/fs/move", { from: root, to: join(root, "inside") }))).reason).toBe("invalid")
  expect((await refusal(c.request("_lembas/fs/delete", { path: root, permanent: true }))).reason).toBe("invalid")
})

test("delete: to the trash where there is one; refused without one until the client says permanent", async () => {
  const { c } = await link()
  const file = join(root, "a.txt")
  const r: any = await c.request("_lembas/fs/delete", { path: file })
  // Same file system as the test's data directory: trashed. Otherwise the refusal below covers it.
  if (r.trash) {
    expect(r).toEqual({ deleted: true, trash: true })
    expect(existsSync(file)).toBe(false)
    expect(readFileSync(join(trashHome, "Trash/files/a.txt"), "utf8")).toBe("alpha\n")
    const info = readFileSync(join(trashHome, "Trash/info/a.txt.trashinfo"), "utf8")
    expect(info).toContain("[Trash Info]")
    expect(info).toContain(`Path=${file}`)
  }
  expect((await refusal(c.request("_lembas/fs/delete", { path: join(root, "nope") }))).reason).toBe("missing")
  // Permanently, on the person's word: a folder with all in it.
  expect(await c.request<any>("_lembas/fs/delete", { path: join(root, "docs"), permanent: true })).toEqual({ deleted: true, trash: false })
  expect(existsSync(join(root, "docs"))).toBe(false)
})

test("delete: a platform without a trash refuses and says it cannot be undone", () => {
  writeFileSync(join(root, "keep.txt"), "k")
  expect(moveToTrash(join(root, "keep.txt"), process.env, "win32")).toBe(false)
  expect(existsSync(join(root, "keep.txt"))).toBe(true)
  // A data directory that cannot be made: no trash either, and the file stays.
  expect(moveToTrash(join(root, "keep.txt"), { XDG_DATA_HOME: join(root, "keep.txt", "under-a-file") }, "linux")).toBe(false)
  expect(existsSync(join(root, "keep.txt"))).toBe(true)
})

test("delete: a link is deleted as a link; what it points to stays", async () => {
  const { c } = await link()
  symlinkSync(outside, join(root, "way-out"))
  await c.request("_lembas/fs/delete", { path: join(root, "way-out"), permanent: true })
  expect(existsSync(join(root, "way-out"))).toBe(false)
  expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("not yours\n")
})

test("search: names as the @ picker finds them; inside files with content", async () => {
  const { c } = await link()
  const names: any = await c.request("_lembas/fs/search", { path: root, query: "notes" })
  expect(names.root).toBe(root)
  expect(names.files).toContainEqual({ path: "docs/notes.md", kind: "file" })
  if (Bun.which("rg") === null) return
  const found: any = await c.request("_lembas/fs/search", { path: root, query: "waybread", content: true })
  expect(found.matches).toEqual([{ path: "docs/notes.md", line: 2, text: "waybread" }])
  // As written, unless a pattern is asked for.
  writeFileSync(join(root, "re.txt"), "a.c\nabc\n")
  expect((await c.request<any>("_lembas/fs/search", { path: root, query: "a.c", content: true })).matches.map((m: any) => m.text)).toEqual(["a.c"])
  expect((await c.request<any>("_lembas/fs/search", { path: root, query: "a.c", content: true, regex: true })).matches.map((m: any) => m.text)).toEqual(["a.c", "abc"])
  const capped: any = await c.request("_lembas/fs/search", { path: root, query: "a", content: true, limit: 1 })
  expect(capped.matches.length).toBe(1)
  expect(capped.truncated).toBe(true)
  expect((await refusal(c.request("_lembas/fs/search", { path: root, query: "", content: true }))).reason).toBe("invalid")
  expect((await refusal(c.request("_lembas/fs/search", { path: join(root, "a.txt"), query: "x" }))).reason).toBe("not_a_directory")
})

test("outside the roots: every method refuses, and a link that points out is outside", async () => {
  const { c } = await link()
  symlinkSync(outside, join(root, "way-out"))
  const out = join(outside, "secret.txt")
  const through = join(root, "way-out/secret.txt")
  for (const path of [out, through]) {
    expect((await refusal(c.request("_lembas/fs/stat", { path }))).reason).toBe("outside")
    expect((await refusal(c.request("_lembas/fs/read", { path }))).reason).toBe("outside")
    expect((await refusal(c.request("_lembas/fs/write", { path, data: b64("x"), overwrite: true }))).reason).toBe("outside")
    expect((await refusal(c.request("_lembas/fs/delete", { path, permanent: true }))).reason).toBe("outside")
    expect((await refusal(c.request("_lembas/fs/copy", { from: path, to: join(root, "stolen.txt") }))).reason).toBe("outside")
    expect((await refusal(c.request("_lembas/fs/copy", { from: join(root, "a.txt"), to: path, overwrite: true }))).reason).toBe("outside")
    expect((await refusal(c.request("_lembas/fs/move", { from: path, to: join(root, "stolen.txt") }))).reason).toBe("outside")
    expect((await refusal(c.request("_lembas/fs/move", { from: join(root, "a.txt"), to: path, overwrite: true }))).reason).toBe("outside")
  }
  expect((await refusal(c.request("_lembas/fs/list", { path: outside }))).reason).toBe("outside")
  expect((await refusal(c.request("_lembas/fs/list", { path: join(root, "way-out") }))).reason).toBe("outside")
  expect((await refusal(c.request("_lembas/fs/mkdir", { path: join(root, "way-out/new") }))).reason).toBe("outside")
  expect((await refusal(c.request("_lembas/fs/search", { path: outside, query: "x" }))).reason).toBe("outside")
  expect(readFileSync(out, "utf8")).toBe("not yours\n")
  expect(existsSync(join(root, "stolen.txt"))).toBe(false)
  // The listing names the link and says it leads out; it is not opened.
  const l: any = await c.request("_lembas/fs/list", { path: root })
  expect(l.entries.find((e: any) => e.name === "way-out")).toMatchObject({ kind: "dir", link: outside, outside: true })
})

test("the CLI's own files and protected paths: never read, written, moved, copied or deleted, even inside a root", async () => {
  // The device shares the folder that holds the CLI's own configuration.
  const base = join(paths.config, "..")
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(join(paths.config, "connections.yaml"), "connections: {}\n", { mode: 0o600 })
  const { c } = await link(limitsFor({ roots: [base] }))
  const own = join(paths.config, "config.yaml")
  const guarded = join(paths.config, "connections.yaml")
  for (const path of [own, guarded, paths.config]) {
    expect((await refusal(c.request("_lembas/fs/read", { path }))).reason).toBe("own")
    expect((await refusal(c.request("_lembas/fs/stat", { path }))).reason).toBe("own")
    expect((await refusal(c.request("_lembas/fs/write", { path, data: b64("x"), overwrite: true }))).reason).toBe("own")
    expect((await refusal(c.request("_lembas/fs/delete", { path, permanent: true }))).reason).toBe("own")
    expect((await refusal(c.request("_lembas/fs/copy", { from: path, to: join(base, "copy-of-it") }))).reason).toBe("own")
    expect((await refusal(c.request("_lembas/fs/move", { from: path, to: join(base, "moved") }))).reason).toBe("own")
    expect((await refusal(c.request("_lembas/fs/copy", { from: join(base, "nothing"), to: path, overwrite: true }))).reason).not.toBeUndefined()
  }
  expect((await refusal(c.request("_lembas/fs/list", { path: paths.config }))).reason).toBe("own")
  expect(readFileSync(guarded, "utf8")).toBe("connections: {}\n")
  // The listing above names the folder, marked protected, and no more.
  const l: any = await c.request("_lembas/fs/list", { path: base, hidden: true })
  expect(l.entries.find((e: any) => e.path === paths.config)).toMatchObject({ protected: true })
  // A link to the CLI's own files from elsewhere in the root is where it points.
  const way = join(base, "way-in")
  rmSync(way, { force: true })
  symlinkSync(paths.config, way)
  expect((await refusal(c.request("_lembas/fs/read", { path: join(way, "connections.yaml") }))).reason).toBe("own")
  rmSync(way, { force: true })
})

test("a protected path inside a root is refused as protected, on the spelling given and the real one", async () => {
  // A device that shares the whole home: ~/.ssh is still never reached. Nothing is created there.
  const { c } = await link(limitsFor({ roots: [homedir()] }))
  const key = join(homedir(), ".ssh", "id_made_up_for_a_test")
  expect((await refusal(c.request("_lembas/fs/read", { path: key }))).reason).toBe("protected")
  expect((await refusal(c.request("_lembas/fs/write", { path: key, data: b64("x"), base: null }))).reason).toBe("protected")
  expect((await refusal(c.request("_lembas/fs/delete", { path: join(homedir(), ".gnupg"), permanent: true }))).reason).toBe("protected")
  expect(existsSync(key)).toBe(false)
})

test("a device that allows plan mode only is read-only; off, shared-only, no roots and stdio refuse everything", async () => {
  const plan = await link(limitsFor({ maxMode: "plan" }))
  const file = join(root, "a.txt")
  expect(Buffer.from((await plan.c.request<any>("_lembas/fs/read", { path: file })).data, "base64").toString()).toBe("alpha\n")
  expect((await plan.c.request<any>("_lembas/fs/list", { path: root })).entries.length).toBe(2)
  for (const [m, p] of [
    ["write", { path: file, data: b64("x"), overwrite: true }],
    ["mkdir", { path: join(root, "new") }],
    ["move", { from: file, to: join(root, "b.txt") }],
    ["copy", { from: file, to: join(root, "b.txt") }],
    ["delete", { path: file, permanent: true }],
  ] as const) {
    const r = await refusal(plan.c.request(`_lembas/fs/${m}`, p))
    expect([m, r.reason]).toEqual([m, "read_only"])
    expect(r.message).toContain("plan mode only")
  }
  expect(readFileSync(file, "utf8")).toBe("alpha\n")
  expect(statSync(root).isDirectory()).toBe(true)
  const all = ["list", "stat", "read", "write", "mkdir", "delete", "search"]
  for (const limits of [limitsFor({ enabled: false }), limitsFor({ sharedOnly: true }), limitsFor({ roots: [] }), "stdio" as const]) {
    const { c } = await link(limits)
    for (const m of all) expect([m, (await refusal(c.request(`_lembas/fs/${m}`, { path: file, data: b64("x"), overwrite: true, query: "a" }))).reason]).toEqual([m, "off"])
    expect((await refusal(c.request("_lembas/fs/list", {}))).reason).toBe("off")
    expect((await refusal(c.request("_lembas/fs/move", { from: file, to: join(root, "b.txt") }))).reason).toBe("off")
    expect((await refusal(c.request("_lembas/fs/copy", { from: file, to: join(root, "b.txt") }))).reason).toBe("off")
  }
  expect(readFileSync(file, "utf8")).toBe("alpha\n")
})
