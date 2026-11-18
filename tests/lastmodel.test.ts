// The model last used in a directory (harness spec 3.9.0, acp.md): the file on this machine, how a
// session starts from it, what writes it and what never does, and what `_lembas/directories` says
// of it. A fake LLeMbas is the client; the model is a scripted endpoint.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AcpAgent, type Limits } from "../src/acp/agent.ts"
import { Peer, type Transport } from "../src/acp/rpc.ts"
import { createApp } from "../src/app.ts"
import { paths, setLocalRoot } from "../src/config/paths.ts"
import { setTrust } from "../src/project/root.ts"
import { directoryKey, lastModel, lastModelFile, MAX_DIRECTORIES, pruneGone, REFRESH_MS, rememberModel } from "../src/session/lastmodel.ts"
import { SCHEDULED_META } from "../src/session/store.ts"
import { plan } from "../src/uninstall.ts"
import { delta, fakeProvider, type Fake } from "./fake-provider.ts"

let fake: Fake | undefined
const closing: (() => unknown)[] = []
beforeEach(() => rmSync(lastModelFile(), { force: true }))
afterEach(async () => {
  for (const c of closing.splice(0)) await c()
  fake?.stop()
  rmSync(lastModelFile(), { force: true })
})

function config(url: string, model: string | undefined = "f/m") {
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  f:\n    type: webui\n    url: ${url}\n    models: { f/m: {}, f/big: {}, f/small: {} }\n`, { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), model ? `model: ${model}\n` : "")
}

function project(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ph-lastmodel-")))
  Bun.spawnSync(["git", "init", "-q", dir])
  setTrust(dir, "trusted")
  return dir
}

const asker = { ask: async () => ({ action: "deny" as const }) } as never

function app(cwd: string, extra: Record<string, unknown> = {}) {
  const a = createApp({ cwd, asker, snapshots: false, modelTitles: false, ...extra })
  closing.push(() => a.close())
  return a
}

const reply = (text = "ok") => ({ chunks: [delta({ content: text })] })

// ── the file ────────────────────────────────────────────────────────────────────────────────

test("one model per directory: exactly that directory, never its parent's nor its child's", () => {
  const root = project()
  const sub = join(root, "sub")
  mkdirSync(join(sub, "deeper"), { recursive: true })
  rememberModel(sub, "f/big")
  expect(lastModel(sub)).toBe("f/big")
  expect(lastModel(root)).toBeUndefined()
  expect(lastModel(join(sub, "deeper"))).toBeUndefined()
  // A trailing slash and a link name the same directory.
  expect(lastModel(`${sub}/`)).toBe("f/big")
  symlinkSync(sub, join(root, "link"))
  expect(directoryKey(join(root, "link"))).toBe(sub)
  expect(lastModel(join(root, "link"))).toBe("f/big")
  rememberModel(sub, "f/small")
  expect(lastModel(sub)).toBe("f/small")
})

test("the file is this machine's: in the state directory, private, and nowhere in the project", () => {
  const root = project()
  rememberModel(root, "f/big")
  expect(lastModelFile()).toBe(join(paths.state, "models.json"))
  expect(statSync(lastModelFile()).mode & 0o777).toBe(0o600)
  expect(JSON.parse(readFileSync(lastModelFile(), "utf8"))).toMatchObject({ version: 1, directories: { [root]: { model: "f/big" } } })
  expect(existsSync(join(root, ".agent"))).toBe(false)
})

test("a write looks at no directory; the gone ones are dropped apart from it, and what cannot be looked at is kept", async () => {
  const root = project()
  const gone = join(root, "gone")
  mkdirSync(gone)
  rememberModel(gone, "f/big", 1)
  rmSync(gone, { recursive: true })
  const dirs = Array.from({ length: 3 }, (_, i) => join(root, `d${i}`))
  for (const d of dirs) mkdirSync(d)
  dirs.forEach((d, i) => rememberModel(d, "f/m", 10 + i))
  const kept = () => Object.keys(JSON.parse(readFileSync(lastModelFile(), "utf8")).directories).sort()
  // The gone one is still there after three writes: writing stats nothing.
  expect(kept()).toEqual([...dirs, gone].sort())
  expect(await pruneGone(100)).toEqual([gone])
  expect(kept()).toEqual(dirs)
  expect(JSON.parse(readFileSync(lastModelFile(), "utf8")).pruned).toBe(100)
  expect(MAX_DIRECTORIES).toBe(500)
  // A broken file is no memory, and is written over.
  writeFileSync(lastModelFile(), "{ not json")
  expect(lastModel(dirs[0]!)).toBeUndefined()
  rememberModel(dirs[0]!, "f/big")
  expect(lastModel(dirs[0]!)).toBe("f/big")
})

test("a directory's time is refreshed as it is used, within the hour not rewritten: the ones used longest ago are the ones that go", () => {
  const root = project()
  const at = () => JSON.parse(readFileSync(lastModelFile(), "utf8")).directories[root].at
  rememberModel(root, "f/big", 1000)
  rememberModel(root, "f/big", 1000 + REFRESH_MS - 1)
  expect(at()).toBe(1000)
  rememberModel(root, "f/big", 1000 + REFRESH_MS)
  expect(at()).toBe(1000 + REFRESH_MS)
  // Another model is written at once.
  rememberModel(root, "f/small", 1000 + REFRESH_MS + 5)
  expect(at()).toBe(1000 + REFRESH_MS + 5)
})

test("local mode keeps it in the local root; uninstall --purge takes it with the state, a plain one keeps it", () => {
  const root = project()
  rememberModel(root, "f/big")
  const file = lastModelFile()
  expect(plan({ purge: true, binary: join(root, "lembas") }).remove.some((d) => file.startsWith(`${d}/`))).toBe(true)
  const plain = plan({ binary: join(root, "lembas") })
  expect(plain.remove.some((d) => file.startsWith(`${d}/`))).toBe(false)
  expect(plain.kept.some((d) => file.startsWith(`${d}/`))).toBe(true)
  const local = join(root, ".lembas-local")
  setLocalRoot(local)
  try {
    expect(lastModelFile()).toBe(join(local, "state", "models.json"))
    expect(lastModel(root)).toBeUndefined()
  } finally {
    setLocalRoot(undefined)
  }
})

// ── how a session starts ────────────────────────────────────────────────────────────────────

test("a session starts on the model last used in its directory, over the global setting", () => {
  fake = fakeProvider([])
  config(fake.url)
  const root = project()
  expect(app(root).engine.model.ref).toBe("f/m")
  rememberModel(root, "f/big")
  expect(app(root).engine.model.ref).toBe("f/big")
  // Another directory is not this one — a subdirectory included.
  mkdirSync(join(root, "sub"))
  expect(app(join(root, "sub")).engine.model.ref).toBe("f/m")
  expect(app(project()).engine.model.ref).toBe("f/m")
})

test("the model asked for and the project's setting come before it; a model no longer served is skipped and kept", () => {
  fake = fakeProvider([])
  config(fake.url)
  const root = project()
  rememberModel(root, "f/big")
  expect(app(root, { model: "f/small" }).engine.model.ref).toBe("f/small")
  mkdirSync(join(root, ".agent"))
  writeFileSync(join(root, ".agent", "config.yaml"), "model: f/small\n")
  expect(app(root).engine.model.ref).toBe("f/small")
  rmSync(join(root, ".agent"), { recursive: true })
  expect(app(root).engine.model.ref).toBe("f/big")
  rememberModel(root, "f/withdrawn")
  expect(app(root).engine.model.ref).toBe("f/m")
  expect(lastModel(root)).toBe("f/withdrawn")
})

// ── what writes it ──────────────────────────────────────────────────────────────────────────

test("a person's turn makes the session's model the directory's; a turn the harness started does not", async () => {
  fake = fakeProvider([reply(), reply()])
  config(fake.url)
  const root = project()
  const a = app(root, { model: "f/big" })
  // Starting is not using.
  expect(lastModel(root)).toBeUndefined()
  await a.turns.prompt("[job j1 finished]", [], "[job j1 finished]", { machine: true })
  expect(lastModel(root)).toBeUndefined()
  await a.turns.prompt("hello")
  expect(lastModel(root)).toBe("f/big")
})

test("changing the model is remembered at once; a command's own model, borrowed for one prompt, is not", async () => {
  fake = fakeProvider([reply(), reply()])
  config(fake.url)
  const root = project()
  const a = app(root)
  a.settings.set("model", "f/big")
  expect(lastModel(root)).toBe("f/big")
  a.switchModel("f/small", "borrowed")
  await a.turns.prompt("a command's prompt")
  expect(lastModel(root)).toBe("f/big")
  a.switchModel("f/big")
  a.chooseModel("f/small")
  expect(lastModel(root)).toBe("f/small")
})

test("a session that does not remember — a one-shot run — starts on the directory's model and leaves it alone", async () => {
  fake = fakeProvider([reply()])
  config(fake.url)
  const root = project()
  rememberModel(root, "f/big")
  const a = app(root, { model: "f/small", kind: "run" })
  await a.turns.prompt("hello")
  a.settings.set("model", "f/m")
  expect(lastModel(root)).toBe("f/big")
  expect(app(root, { kind: "run" }).engine.model.ref).toBe("f/big")
})

test("a command whose model is the session's own leaves nothing borrowed: the next prompt is remembered", async () => {
  fake = fakeProvider([reply(), reply()])
  config(fake.url)
  const root = project()
  const a = app(root, { model: "f/big" })
  const prev = { model: a.engine.model.ref, effort: a.engine.effort }
  a.switchModel("f/big", "borrowed")
  await a.turns.prompt("a command's prompt")
  expect(lastModel(root)).toBeUndefined()
  a.returnModel(prev)
  await a.turns.prompt("hello")
  expect(lastModel(root)).toBe("f/big")
})

test("a change of model inside a turn the harness started is not remembered", async () => {
  fake = fakeProvider([reply()])
  config(fake.url)
  const root = project()
  const a = app(root)
  const off = a.bus.on((e) => {
    // What a model's settings call would do, mid-turn.
    if (e.type === "prompt") a.settings.set("model", "f/big")
  })
  await a.turns.prompt("[job j1 finished]", [], "[job j1 finished]", { machine: true })
  off()
  expect(a.engine.model.ref).toBe("f/big")
  expect(lastModel(root)).toBeUndefined()
})

test("a schedule's session opened in a terminal is still the schedule's: nothing in it is remembered, and a new session after it is the terminal's again", async () => {
  fake = fakeProvider([reply(), reply()])
  config(fake.url)
  const root = project()
  const a = app(root, { model: "f/big" })
  const first = a.engine.sessionId!
  a.newSession()
  a.store!.setMeta(first, SCHEDULED_META, { scheduleId: "sched1", runId: "run7", title: "Check", mode: "edit", waitMs: 1000 })
  a.resume(first)
  await a.turns.prompt("what did the run find?")
  a.settings.set("model", "f/small")
  expect(lastModel(root)).toBeUndefined()
  a.newSession()
  await a.turns.prompt("hello")
  expect(lastModel(root)).toBe("f/small")
})

// ── the link ────────────────────────────────────────────────────────────────────────────────

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

const limitsFor = (root: string, extra: Partial<Limits> = {}): Limits => ({ roots: [root], maxMode: "auto", approvalTimeoutMs: 3000, requireTrust: true, enabled: true, scheduled: true, ...extra })

async function client(limits: Limits) {
  const [ta, tb] = pair()
  new AcpAgent(new Peer(ta), limits, "f")
  const c = new Peer(tb)
  c.on("_lembas/event", () => {})
  c.on("session/update", () => {})
  const init: any = await c.request("initialize", { protocolVersion: 1, clientCapabilities: { _meta: { lembas: { protocol: 3 } } } })
  return { c, init }
}

const say = (sessionId: string, text: string, lembas: Record<string, unknown> = {}) => ({ sessionId, prompt: [{ type: "text", text }], _meta: { lembas } })

test("_lembas/directories says each directory's model, and `list: false` answers for one directory alone", async () => {
  fake = fakeProvider([])
  config(fake.url)
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ph-lastmodel-dirs-")))
  const work = join(home, "project")
  const notes = join(home, "notes")
  for (const d of [join(work, "src"), notes]) mkdirSync(d, { recursive: true })
  setTrust(home, "trusted")
  rememberModel(work, "f/big")
  const { c, init } = await client(limitsFor(home))
  expect(init._meta.lembas.capabilities).toContain("directory_model")

  const listed: any = await c.request("_lembas/directories", { path: home })
  expect(listed.model).toBeUndefined()
  expect(listed.entries).toEqual([
    { path: notes, name: "notes", accepted: true },
    { path: work, name: "project", accepted: true, model: "f/big" },
  ])

  expect(await c.request<unknown>("_lembas/directories", { path: work, list: false })).toEqual({ path: work, name: "project", accepted: true, model: "f/big", parent: home })
  expect(await c.request<unknown>("_lembas/directories", { path: notes, list: false })).toEqual({ path: notes, name: "notes", accepted: true, parent: home })
  // Listed, the answered directory carries its own; a child does not inherit it.
  const inside: any = await c.request("_lembas/directories", { path: work })
  expect(inside.model).toBe("f/big")
  expect(inside.entries).toEqual([{ path: join(work, "src"), name: "src", accepted: true }])
  // The places too.
  rememberModel(home, "f/small")
  expect(((await c.request("_lembas/directories", {})) as any).places).toEqual([{ path: home, name: basenameOf(home), accepted: true, model: "f/small" }])
  // `list: false` is still judged as any path.
  await expect(c.request("_lembas/directories", { path: "/somewhere/else", list: false })).rejects.toThrow("outside the directories")
})

const basenameOf = (p: string) => p.split("/").pop()!

test("a directory no session may be opened in says no model", async () => {
  fake = fakeProvider([])
  config(fake.url)
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ph-lastmodel-untrusted-")))
  rememberModel(root, "f/big")
  const { c } = await client(limitsFor(root))
  const one: any = await c.request("_lembas/directories", { path: root, list: false })
  expect(one.accepted).toBe(false)
  expect(one.model).toBeUndefined()
})

test("a chat's turn on the link makes its model the directory's, and so does a change of the chat's model", async () => {
  fake = fakeProvider([reply()])
  config(fake.url)
  const root = project()
  const { c } = await client(limitsFor(root))
  const s: any = await c.request("session/new", { cwd: root, _meta: { lembas_model: "f/big" } })
  expect(lastModel(root)).toBeUndefined()
  await c.request("session/prompt", say(s.sessionId, "hello"))
  expect(lastModel(root)).toBe("f/big")
  await c.request("_lembas/configure", { sessionId: s.sessionId, model: "f/small" })
  expect(lastModel(root)).toBe("f/small")
  // A session opened with no model starts on it.
  const next: any = await c.request("session/new", { cwd: root })
  expect(next._meta.lembas.model).toBe("f/small")
})

test("a scheduled run uses the directory's model and never becomes it — not its turn, a model change, or the person's turn in its chat", async () => {
  fake = fakeProvider([reply("Done."), reply("And again."), reply("Nothing new.")])
  config(fake.url)
  const root = project()
  rememberModel(root, "f/big")
  const { c } = await client(limitsFor(root))
  const scheduled = { schedule_id: "sched1", run_id: "run7", title: "Check" }
  const s: any = await c.request("session/new", { cwd: root, _meta: { lembas_model: "f/small", lembas: { scheduled } } })
  expect(s._meta.lembas.model).toBe("f/small")
  await c.request("session/prompt", say(s.sessionId, "check", { scheduled, turnId: "run7" }))
  expect(lastModel(root)).toBe("f/big")
  await c.request("_lembas/configure", { sessionId: s.sessionId, model: "f/m" })
  expect(lastModel(root)).toBe("f/big")
  await c.request("session/prompt", say(s.sessionId, "what did you find?"))
  expect(lastModel(root)).toBe("f/big")
  // Opened from the store again by another link (a restart): still a schedule's session.
  const again = await client(limitsFor(root))
  await again.c.request("session/prompt", say(s.sessionId, "and now?"))
  expect(lastModel(root)).toBe("f/big")
  // …on the model it had (changed to f/m above), not on the directory's: kept with the session.
  expect(fake.requests.map((r) => r.model)).toEqual(["f/small", "f/m", "f/m"])
  // A schedule that names no model: the session starts on the directory's.
  const follows: any = await c.request("session/new", { cwd: root, _meta: { lembas: { scheduled: { ...scheduled, run_id: "run8" } } } })
  expect(follows._meta.lembas.model).toBe("f/big")
})
