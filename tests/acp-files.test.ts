// Device files (harness/acp.md, spec 3.11.0, capability `fs`): `_lembas/fs/*` on the link — every
// method, and every refusal: outside the roots, through a link that points out, the CLI's own
// files, a protected path, a read-only device, remote work off, and `serve --stdio`.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { AcpAgent, type Limits } from "../src/acp/agent.ts"
import { DeviceFiles, moveToTrash, PART, sweepParts } from "../src/acp/files.ts"
import { LOOP } from "../src/harness.ts"
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
  expect(l.entries.find((e: any) => e.name === "way-out")).toMatchObject({ kind: "other", size: 0, link: outside, outside: true })
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

// ── one change at a time; judged again after every wait (review finding 1) ──────────────────

test("a write racing two moves that swap a link into its path never lands outside the roots", async () => {
  const { c } = await link()
  mkdirSync(join(root, "a"))
  // Large enough that hashing it for the base check is waited for.
  writeFileSync(join(root, "a/keys.txt"), Buffer.alloc(24 * 1024 * 1024, 1))
  symlinkSync(outside, join(root, "way-out"))
  // All three at once, as a client may send them: the write, then the folder moved aside and the
  // link moved into its place.
  const write = refusal(c.request("_lembas/fs/write", { path: join(root, "a/keys.txt"), data: b64("planted\n"), overwrite: true }))
  const aside = refusal(c.request("_lembas/fs/move", { from: join(root, "a"), to: join(root, "b") }))
  const swap = refusal(c.request("_lembas/fs/move", { from: join(root, "way-out"), to: join(root, "a") }))
  const [w] = await Promise.all([write, aside, swap])
  // Changes run one after another: the write finished where it was judged, before either move.
  expect(w.reason).toBeUndefined()
  expect(readdirSync(outside).sort()).toEqual(["secret.txt"])
  expect(readFileSync(join(root, "b/keys.txt"), "utf8")).toBe("planted\n")
  expect(lstatSync(join(root, "a")).isSymbolicLink()).toBe(true)
})

test("a path that changes under a write while its base is hashed is judged again: refused, nothing written outside", async () => {
  const { c } = await link()
  mkdirSync(join(root, "a"))
  writeFileSync(join(root, "a/keys.txt"), Buffer.alloc(48 * 1024 * 1024, 1))
  const write = refusal(c.request("_lembas/fs/write", { path: join(root, "a/keys.txt"), data: b64("planted\n"), overwrite: true }))
  // Not through these methods (which wait their turn): something else on the computer swaps the
  // folder for a link that leads out, while the hash is under way.
  await Bun.sleep(5)
  const { renameSync } = await import("node:fs")
  renameSync(join(root, "a"), join(root, "b"))
  symlinkSync(outside, join(root, "a"))
  const w = await write
  expect(w.reason).toBe("outside")
  expect(readdirSync(outside).sort()).toEqual(["secret.txt"])
  expect(readdirSync(join(root, "b"))).toEqual(["keys.txt"])
  // The same for the parts of an upload: the path is judged with each.
  rmSync(join(root, "a"))
  mkdirSync(join(root, "a"))
  const up: any = await c.request("_lembas/fs/write", { path: join(root, "a/big.bin"), data: b64("one"), base: null, more: true })
  renameSync(join(root, "a"), join(root, "c"))
  symlinkSync(outside, join(root, "a"))
  expect((await refusal(c.request("_lembas/fs/write", { upload: up.upload, data: b64("two") }))).reason).toBe("outside")
  expect(readdirSync(outside).sort()).toEqual(["secret.txt"])
  // The upload is dropped. Its part file's name now leads out, so nothing is removed by that name:
  // the file is emptied where it lies.
  const left = readdirSync(join(root, "c"))
  expect(left.every((n) => PART.test(n))).toBe(true)
  expect(left.map((n) => statSync(join(root, "c", n)).size)).toEqual([0])
})

test("a hash is of the file that was judged, whatever becomes of its name meanwhile", async () => {
  const { c } = await link()
  const big = Buffer.alloc(24 * 1024 * 1024, 3)
  writeFileSync(join(root, "big.bin"), big)
  const st = c.request<any>("_lembas/fs/stat", { path: join(root, "big.bin"), hash: true })
  await Bun.sleep(5)
  rmSync(join(root, "big.bin"))
  symlinkSync(join(outside, "secret.txt"), join(root, "big.bin"))
  expect((await st).hash).toBe(hash(big))
})

// ── files that run code (review finding 2; the owner's decision: a device setting, off) ─────

test("files that run code: read from here, changed only where remote.files_that_run_code is on", async () => {
  mkdirSync(join(root, "app/.git/hooks"), { recursive: true })
  mkdirSync(join(root, "app/.agent/commands"), { recursive: true })
  writeFileSync(join(root, "app/.git/config"), "[core]\n")
  writeFileSync(join(root, "app/.agent/config.yaml"), "mode: manual\n")
  writeFileSync(join(root, "app/readme.md"), "r\n")
  const [ta, tb] = pair()
  new AcpAgent(new Peer(ta), limitsFor())
  const c = new Peer(tb)
  const init: any = await c.request("initialize", { protocolVersion: 1, clientCapabilities: { _meta: { lembas: { protocol: 3 } } } })
  // Said with the limits, so a client knows beforehand.
  expect(init._meta.lembas.limits.files_that_run_code).toBe(false)
  const hook = join(root, "app/.git/hooks/pre-commit")
  const w = await refusal(c.request("_lembas/fs/write", { path: hook, data: b64("#!/bin/sh\n"), base: null }))
  expect(w.reason).toBe("runs_code")
  expect(w.message).toContain("remote.files_that_run_code")
  for (const [m, p] of [
    ["write", { path: join(root, "app/.git/config"), data: b64("x"), overwrite: true }],
    ["write", { path: join(root, "app/.agent/config.yaml"), data: b64("x"), overwrite: true }],
    ["write", { path: join(root, "app/.agent/commands/go.md"), data: b64("x"), base: null }],
    ["mkdir", { path: join(root, "app/.git/hooks/sub") }],
    ["delete", { path: join(root, "app/.git/config"), permanent: true }],
    ["move", { from: join(root, "app/readme.md"), to: hook }],
    ["move", { from: join(root, "app/.git/hooks"), to: join(root, "app/hooks") }],
    ["copy", { from: join(root, "app/readme.md"), to: hook }],
    ["move", { from: join(root, "docs"), to: join(root, "app/docs/.git") }],
    ["copy", { from: join(root, "docs"), to: join(root, "docs/.agent") }],
  ] as const)
    expect([m, JSON.stringify(p).slice(0, 0), (await refusal(c.request(`_lembas/fs/${m}`, p))).reason]).toEqual([m, "", "runs_code"])
  expect(existsSync(hook)).toBe(false)
  expect(readFileSync(join(root, "app/.git/config"), "utf8")).toBe("[core]\n")
  // Reading, listing and searching them stay allowed; so do a project's other files and the repository as a whole.
  expect(Buffer.from((await c.request<any>("_lembas/fs/read", { path: join(root, "app/.git/config") })).data, "base64").toString()).toBe("[core]\n")
  expect((await c.request<any>("_lembas/fs/list", { path: join(root, "app/.git") })).entries.map((e: any) => e.name)).toEqual(["hooks", "config"])
  mkdirSync(join(root, "app/.agent/plans"))
  await c.request("_lembas/fs/write", { path: join(root, "app/.agent/plans/next.md"), data: b64("# Plan\n"), base: null })
  await c.request("_lembas/fs/copy", { from: join(root, "app"), to: join(root, "app2") })
  expect(readFileSync(join(root, "app2/.git/config"), "utf8")).toBe("[core]\n")
  // The device's own setting on: a file like any other.
  const on = await link(limitsFor({ filesThatRunCode: true }))
  await on.c.request("_lembas/fs/write", { path: hook, data: b64("#!/bin/sh\n"), base: null })
  expect(readFileSync(hook, "utf8")).toBe("#!/bin/sh\n")
})

test("a start-up file of the device's user is refused where the home is shared (nothing is written there)", async () => {
  const { c } = await link(limitsFor({ roots: [homedir()] }))
  const rc = join(homedir(), ".bashrc")
  const before = existsSync(rc) ? readFileSync(rc, "utf8") : undefined
  expect((await refusal(c.request("_lembas/fs/write", { path: rc, data: b64("echo hi\n"), overwrite: true }))).reason).toBe("runs_code")
  expect((await refusal(c.request("_lembas/fs/delete", { path: join(homedir(), ".config"), permanent: true }))).reason).not.toBeUndefined()
  expect(existsSync(rc) ? readFileSync(rc, "utf8") : undefined).toBe(before)
})

// ── bounds (review findings 7 and 8) ────────────────────────────────────────────────────────

test("an upload is capped in all; a listing is cut before its entries are looked at; few folders' names are kept", async () => {
  const { c } = await link()
  const F = LOOP.files
  const old = { upload: F.upload_max_bytes, list: F.list_max }
  try {
    F.upload_max_bytes = 10
    const up: any = await c.request("_lembas/fs/write", { path: join(root, "cap.bin"), data: b64("12345678"), base: null, more: true })
    const over = await refusal(c.request("_lembas/fs/write", { upload: up.upload, data: b64("abc"), more: true }))
    expect(over.reason).toBe("too_large")
    // Dropped: its part file is gone and it takes no more.
    expect(readdirSync(root).filter((n) => PART.test(n))).toEqual([])
    expect((await refusal(c.request("_lembas/fs/write", { upload: up.upload, data: b64("a") }))).reason).toBe("invalid")
    expect(existsSync(join(root, "cap.bin"))).toBe(false)
    F.list_max = 1
    const l: any = await c.request("_lembas/fs/list", { path: root })
    expect(l.entries.map((e: any) => e.name)).toEqual(["docs"])
    expect(l.truncated).toBe(true)
  } finally {
    F.upload_max_bytes = old.upload
    F.list_max = old.list
  }
  const files = new DeviceFiles(() => ({ roots: [root], maxMode: "auto", enabled: true }))
  for (const d of ["d1", "d2", "d3", "d4", "d5", "d6"]) {
    mkdirSync(join(root, d))
    writeFileSync(join(root, d, "f.txt"), "x")
    await files.search({ path: join(root, d), query: "f" })
  }
  expect((files as unknown as { names: Map<string, unknown> }).names.size).toBe(LOOP.files.indexes_max)
})

test("part files: never listed or found, not named by a client, and swept when a process left one behind", async () => {
  const { c } = await link()
  const up: any = await c.request("_lembas/fs/write", { path: join(root, "slow.bin"), data: b64("needle one"), base: null, more: true })
  const part = readdirSync(root).find((n) => PART.test(n))!
  expect(part).toBeDefined()
  expect((await c.request<any>("_lembas/fs/list", { path: root, hidden: true })).entries.map((e: any) => e.name)).not.toContain(part)
  expect((await c.request<any>("_lembas/fs/search", { path: root, query: "slow" })).files).toEqual([])
  if (Bun.which("rg") !== null) expect((await c.request<any>("_lembas/fs/search", { path: root, query: "needle", content: true })).matches).toEqual([])
  expect((await refusal(c.request("_lembas/fs/read", { path: join(root, part) }))).reason).toBe("invalid")
  expect((await refusal(c.request("_lembas/fs/delete", { path: join(root, part), permanent: true }))).reason).toBe("invalid")
  // The journal names it while it is open; a process that died would leave both behind.
  const journal = join(paths.state, "uploads.json")
  expect(JSON.parse(readFileSync(journal, "utf8"))).toContain(join(root, part))
  // The next process sweeps what the journal names — and only what is named like a part file.
  writeFileSync(join(root, "keep.txt"), "k")
  writeFileSync(journal, JSON.stringify([join(root, part), join(root, "keep.txt")]))
  expect(sweepParts()).toEqual([join(root, part)])
  expect(existsSync(join(root, part))).toBe(false)
  expect(existsSync(join(root, "keep.txt"))).toBe(true)
  expect(JSON.parse(readFileSync(journal, "utf8"))).toEqual([])
  void up
})

test("copying a whole tree does not stop the device answering", async () => {
  const { c } = await link()
  mkdirSync(join(root, "tree"))
  for (let i = 0; i < 40; i++) {
    mkdirSync(join(root, "tree", `d${i}`))
    for (let j = 0; j < 60; j++) writeFileSync(join(root, "tree", `d${i}`, `f${j}.txt`), "x".repeat(2000))
  }
  const order: string[] = []
  const copy = c.request("_lembas/fs/copy", { from: join(root, "tree"), to: join(root, "tree2") }).then(() => order.push("copy"))
  const read = c.request("_lembas/fs/read", { path: join(root, "a.txt") }).then(() => order.push("read"))
  await Promise.all([copy, read])
  expect(order).toEqual(["read", "copy"])
  expect(readdirSync(join(root, "tree2")).length).toBe(40)
})
