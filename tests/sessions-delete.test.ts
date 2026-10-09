// Sessions' loose ends: a delete made with no link up reaches the instance later (the
// pending list), a session reopens in the directory it was started in, and a resume leaves no
// empty session behind. A fake LLeMbas is the ACP client of the agent, as in hub.test.ts.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AcpAgent, type Limits } from "../src/acp/agent.ts"
import { Hub } from "../src/acp/hub.ts"
import { addPendingDeleted, clearPendingDeleted, DELETED_MAX, deletedFile, pendingDeleted } from "../src/acp/pending.ts"
import { Peer, type Transport } from "../src/acp/rpc.ts"
import { deleteEverywhere, discardOnExit, Share } from "../src/acp/share.ts"
import { createApp, type App } from "../src/app.ts"
import type { AskReply, Event } from "../src/bus/index.ts"
import { paths } from "../src/config/paths.ts"
import { setTrust } from "../src/project/root.ts"
import { CWD_META, REMOTE_META, Store } from "../src/session/store.ts"
import { delta, fakeProvider, type Fake } from "./fake-provider.ts"

let fake: Fake | undefined
const stops: (() => void)[] = []
beforeEach(() => rmSync(deletedFile(), { force: true }))
afterEach(() => {
  fake?.stop()
  for (const s of stops.splice(0).reverse()) s()
  rmSync(deletedFile(), { force: true })
})

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

function config(url: string) {
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  f:\n    dialect: openai-chat\n    base_url: ${url}\n    models: { m: {} }\n`, { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), "model: f/m\n")
}

function project(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ph-del-")))
  setTrust(dir, "trusted")
  return dir
}

const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 200 && !ok(); i++) await Bun.sleep(10)
  if (!ok()) throw new Error(`timed out waiting for ${what}`)
}

const limitsFor = (root: string): Limits => ({ roots: [root], maxMode: "auto", approvalTimeoutMs: 2000, requireTrust: true })
const asker = { ask: () => Promise.resolve({ kind: "once" } as AskReply) }

/** A fake instance on an agent: what it hears of deletes. */
async function instance(limits: Limits, hub?: Hub, said: unknown = true) {
  const [ta, tb] = pair()
  new AcpAgent(new Peer(ta), limits, undefined, hub)
  const web = new Peer(tb)
  const deleted: string[] = []
  web.on("_lembas/session/deleted", (p) => void deleted.push(p.sessionId))
  await web.request("initialize", { protocolVersion: 1, clientCapabilities: { _meta: { lembas: said } } })
  return { web, deleted }
}

async function hubUp(limits: Limits) {
  const hub = new Hub({ service: true, limits: { ...limits, enabled: true } })
  expect(await hub.listen()).toBe(true)
  stops.push(() => hub.close())
  return hub
}

function terminal(root: string): { app: App; share: Share } {
  const app = createApp({ cwd: root, modelTitles: false, asker })
  const share = new Share(app, {
    prompt: (r, started) => (started(), app.turns.prompt(r.prompt, r.extra, r.shown, { turnId: r.turnId })),
    compact: () => app.engine.compact(),
    deleted: () => app.newSession(),
    notice: () => {},
    changed: () => {},
  })
  stops.push(() => share.close())
  return { app, share }
}

test("the pending list: deduplicated, newest kept, and clearing keeps what came meanwhile", () => {
  expect(pendingDeleted()).toEqual([])
  addPendingDeleted(["a", "b"])
  addPendingDeleted(["a", "c"])
  // `a` again is the newest word about it.
  expect(pendingDeleted()).toEqual(["b", "a", "c"])
  const sent = pendingDeleted()
  addPendingDeleted(["d"])
  clearPendingDeleted(sent)
  expect(pendingDeleted()).toEqual(["d"])
  addPendingDeleted(Array.from({ length: DELETED_MAX + 20 }, (_, i) => `s${i}`))
  const all = pendingDeleted()
  expect(all.length).toBe(DELETED_MAX)
  expect(all.at(-1)).toBe(`s${DELETED_MAX + 19}`)
  expect(all).not.toContain("d")
})

test("a delete made with no hub waits, and the next link's initialize sends it and forgets it", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "hi" })] }])
  const root = project()
  config(fake.url)
  const app = createApp({ cwd: root, modelTitles: false, asker })
  await app.turns.prompt("hello")
  const id = app.engine.sessionId!
  app.newSession()
  // No hub runs: `lembas sessions delete` and a terminal without a service go this way.
  expect(await deleteEverywhere(app.store!, id)).toBeUndefined()
  expect(app.store!.session(id)).toBeUndefined()
  expect(pendingDeleted()).toEqual([id])

  // `serve --stdio` (no limits) is an editor: it neither hears it nor empties the list.
  const [ta, tb] = pair()
  new AcpAgent(new Peer(ta), undefined)
  const editor = new Peer(tb)
  const heard: string[] = []
  editor.on("_lembas/session/deleted", (p) => void heard.push(p.sessionId))
  await editor.request("initialize", { protocolVersion: 1, clientCapabilities: { _meta: { lembas: true } } })
  await Bun.sleep(20)
  expect(heard).toEqual([])
  expect(pendingDeleted()).toEqual([id])

  // A client that is not LLeMbas is not told either.
  const other = await instance(limitsFor(root), undefined, null)
  await Bun.sleep(20)
  expect(other.deleted).toEqual([])

  const { deleted } = await instance(limitsFor(root))
  await until(() => deleted.length > 0, "the pending delete")
  expect(deleted).toEqual([id])
  expect(pendingDeleted()).toEqual([])
})

test("a hub with no link keeps a terminal's delete, and the link that comes up sends it", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "hi" })] }])
  const root = project()
  config(fake.url)
  const hub = await hubUp(limitsFor(root))
  const { app, share } = terminal(root)
  await share.start()
  await app.turns.prompt("hello")
  const id = app.engine.sessionId!
  app.newSession()
  expect(await share.deleted(id)).toBeUndefined()
  await until(() => pendingDeleted().includes(id), "the hub to keep it")
  const { deleted } = await instance(limitsFor(root), hub)
  await until(() => deleted.includes(id), "the delete sent")
  expect(pendingDeleted()).toEqual([])

  // With the link up, the next delete goes at once, and nothing waits.
  await app.turns.prompt("again")
  const next = app.engine.sessionId!
  app.newSession()
  expect(await share.deleted(next)).toBeUndefined()
  await until(() => deleted.includes(next), "the second delete")
  expect(pendingDeleted()).toEqual([])
})

test("`lembas sessions delete` through a running hub: let go of, deleted, and told", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "hi" })] }])
  const root = project()
  config(fake.url)
  const hub = await hubUp(limitsFor(root))
  const { deleted } = await instance(limitsFor(root), hub)
  const app = createApp({ cwd: root, modelTitles: false, asker })
  await app.turns.prompt("hello")
  const id = app.engine.sessionId!
  app.newSession()
  // A connection of its own, made and closed for the delete.
  const store = new Store()
  expect(await deleteEverywhere(store, id)).toBeUndefined()
  expect(store.session(id)).toBeUndefined()
  await until(() => deleted.includes(id), "the instance told")
  expect(pendingDeleted()).toEqual([])
})

test("a session reopens in the directory it was started in, while that is still there", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "one" })] }, { chunks: [delta({ content: "two" })] }])
  const root = project()
  const sub = join(root, "pkg")
  mkdirSync(sub)
  // A repository, so a subdirectory is inside the project and not a project of its own.
  Bun.spawnSync(["git", "init", "-q", root])
  config(fake.url)
  // Started in a subdirectory: the store keeps the project's root, and the directory beside it.
  const term = createApp({ cwd: sub, modelTitles: false, asker })
  await term.turns.prompt("hello")
  const id = term.engine.sessionId!
  expect(term.store!.session(id)!.root).toBe(root)
  expect(term.store!.meta<string>(id, CWD_META)).toBe(sub)
  term.newSession()
  expect(term.store!.meta<string>(term.engine.sessionId!, CWD_META)).toBe(sub)

  const { web } = await instance(limitsFor(root))
  // Not held yet: from the store.
  expect(((await web.request("_lembas/files/search", { sessionId: id, query: "" })) as any).root).toBe(sub)
  // Opened by a prompt: it works there.
  await web.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text: "again" }] })
  expect(((await web.request("_lembas/files/search", { sessionId: id, query: "" })) as any).root).toBe(sub)

  // Gone, or outside the project: its project's root, as before.
  const store = term.store!
  store.setMeta(id, CWD_META, join(root, "gone"))
  const other = await instance(limitsFor(root))
  expect(((await other.web.request("_lembas/files/search", { sessionId: id, query: "" })) as any).root).toBe(root)
  store.setMeta(id, CWD_META, tmpdir())
  expect(((await other.web.request("_lembas/files/search", { sessionId: id, query: "" })) as any).root).toBe(root)
})

test("a session started in the web UI keeps its directory too", async () => {
  fake = fakeProvider([])
  const root = project()
  const sub = join(root, "web")
  mkdirSync(sub)
  Bun.spawnSync(["git", "init", "-q", root])
  config(fake.url)
  const { web } = await instance(limitsFor(root))
  const s: any = await web.request("session/new", { cwd: sub })
  expect(new Store().meta<string>(s.sessionId, CWD_META)).toBe(sub)
})

test("resuming leaves no empty session behind; one with anything in it stays", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "kept" })] }, { chunks: [delta({ content: "other" })] }])
  const root = project()
  config(fake.url)
  const first = createApp({ cwd: root, modelTitles: false, asker })
  await first.turns.prompt("hello")
  const kept = first.engine.sessionId!
  first.newSession()
  await first.turns.prompt("there")
  const other = first.engine.sessionId!
  first.resume(kept)

  // `-c` and /sessions: the app made a session at start, and the resume discards it.
  const app = createApp({ cwd: root, modelTitles: false, asker })
  const seen: Event[] = []
  app.bus.on((e) => void seen.push(e))
  const empty = app.engine.sessionId!
  app.resume(kept)
  expect(app.store!.session(empty)).toBeUndefined()
  expect(seen.find((e) => e.type === "discarded")).toEqual({ type: "discarded", id: empty, shown: false })
  // Never shown to the web UI: nothing for the instance to hear.
  expect(pendingDeleted()).toEqual([])
  expect(app.store!.sessions(50, root).map((s) => s.id).sort()).toEqual([kept, other].sort())

  // Away from a session with words in it: that one is kept.
  app.resume(other)
  expect(app.store!.session(kept)).toBeDefined()

  // `-s <id>`: no session made first at all.
  const direct = createApp({ cwd: root, modelTitles: false, asker, resuming: kept })
  direct.resume(kept)
  expect(direct.store!.sessions(50, root, false).map((s) => s.id).sort()).toEqual([kept, other].sort())
})

test("an empty session the web UI was shown is deleted there too when a resume discards it", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "kept" })] }])
  const root = project()
  config(fake.url)
  const first = createApp({ cwd: root, modelTitles: false, asker })
  await first.turns.prompt("hello")
  const kept = first.engine.sessionId!
  // No hub: the Share keeps the word for the next link.
  const { app } = terminal(root)
  const empty = app.engine.sessionId!
  app.store!.setMeta(empty, REMOTE_META, true)
  app.resume(kept)
  expect(app.store!.session(empty)).toBeUndefined()
  expect(pendingDeleted()).toEqual([empty])
})

test("/sessions lists only sessions somebody said something in", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "hi" })] }])
  const root = project()
  config(fake.url)
  const app = createApp({ cwd: root, modelTitles: false, asker })
  await app.turns.prompt("hello")
  const said = app.engine.sessionId!
  app.newSession()
  app.newSession()
  expect(app.store!.sessions(40, root, true).map((s) => s.id)).toEqual([said])
  expect(app.store!.isEmpty(app.engine.sessionId!)).toBe(true)
  expect(app.store!.isEmpty(said)).toBe(false)
})

async function cli(...args: string[]) {
  const p = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), ...args], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  return { out, err, code }
}

test("lembas sessions prune and delete: empty ones go, the instance hears of the ones it was shown", async () => {
  const store = new Store()
  const root = project()
  const said = store.createSession(root, "f/m")
  store.append(said.id, { role: "user", parts: [{ type: "text", text: "hello" }] })
  const old = store.createSession(root, "f/m")
  const shown = store.createSession(root, "f/m")
  store.setMeta(shown.id, REMOTE_META, true)
  // Both an hour and more ago; a fresh empty one may be a terminal's, open now.
  store.db.query("UPDATE sessions SET updated = ? WHERE id IN (?, ?)").run(Date.now() - 2 * 3_600_000, old.id, shown.id)
  const fresh = store.createSession(root, "f/m")

  const dry = await cli("sessions", "prune", "--dry-run")
  expect(dry.code).toBe(0)
  expect(dry.out).toContain(old.id)
  expect(dry.out).toContain(shown.id)
  expect(dry.out).not.toContain(fresh.id)
  expect(store.session(old.id)).toBeDefined()

  const pruned = await cli("sessions", "prune")
  expect(pruned.out).toContain("deleted 2 empty sessions")
  expect(store.session(old.id)).toBeUndefined()
  expect(store.session(shown.id)).toBeUndefined()
  expect(store.session(fresh.id)).toBeDefined()
  expect(store.session(said.id)).toBeDefined()
  expect(pendingDeleted()).toEqual([shown.id])

  const del = await cli("sessions", "delete", said.id, "ses_nothing")
  expect(del.code).toBe(1)
  expect(del.out).toContain(`${said.id}: deleted`)
  expect(del.err).toContain("ses_nothing: no such session")
  expect(store.session(said.id)).toBeUndefined()
  expect(pendingDeleted()).toEqual([shown.id, said.id])
})

test("a terminal that leaves takes its empty session with it, and tells the instance when it was shown", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "hi" })] }])
  const root = project()
  config(fake.url)
  // No hub: an empty session never shown just goes; one shown waits in the pending list.
  const quiet = createApp({ cwd: root, modelTitles: false, asker })
  const quietId = quiet.engine.sessionId!
  expect(await discardOnExit(quiet.store!, quietId)).toBe(true)
  expect(quiet.store!.session(quietId)).toBeUndefined()
  expect(pendingDeleted()).toEqual([])
  const shownApp = createApp({ cwd: root, modelTitles: false, asker })
  const shownId = shownApp.engine.sessionId!
  shownApp.store!.setMeta(shownId, REMOTE_META, true)
  expect(await discardOnExit(shownApp.store!, shownId)).toBe(true)
  expect(pendingDeleted()).toEqual([shownId])
  rmSync(deletedFile(), { force: true })

  // Anything said in it: kept.
  const said = createApp({ cwd: root, modelTitles: false, asker })
  await said.turns.prompt("hello")
  expect(await discardOnExit(said.store!, said.engine.sessionId)).toBe(false)
  expect(said.store!.session(said.engine.sessionId!)).toBeDefined()

  // With the service: the terminal's session was shared (shown); once its terminal has closed its
  // link, the instance is told at once.
  const hub = await hubUp(limitsFor(root))
  const { deleted } = await instance(limitsFor(root), hub)
  const { app, share } = terminal(root)
  await share.start()
  const id = app.engine.sessionId!
  await until(() => share.sharedId === id, "the session shared")
  share.close()
  await Bun.sleep(20)
  expect(await discardOnExit(app.store!, id)).toBe(true)
  await until(() => deleted.includes(id), "the instance told")
  expect(pendingDeleted()).toEqual([])
})

test("an empty session another terminal still has open is not taken from it", async () => {
  fake = fakeProvider([])
  const root = project()
  config(fake.url)
  await hubUp(limitsFor(root))
  const { app, share } = terminal(root)
  await share.start()
  const id = app.engine.sessionId!
  await until(() => share.sharedId === id, "the session shared")
  // Somebody else leaving with that id (a reload's twin, a stale -s): the hub refuses, it stays.
  expect(await discardOnExit(app.store!, id)).toBe(false)
  expect(app.store!.session(id)).toBeDefined()
})

test("lembas run on its way out: an empty session goes, one with a prompt stays", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "done" })] }])
  const root = project()
  config(fake.url)
  const empty = createApp({ cwd: root, modelTitles: false, asker, snapshots: false })
  const id = empty.engine.sessionId!
  expect(empty.discardIfEmpty()).toBe(true)
  expect(empty.store!.session(id)).toBeUndefined()
  const ran = createApp({ cwd: root, modelTitles: false, asker, snapshots: false })
  await ran.engine.prompt("hello")
  expect(ran.discardIfEmpty()).toBe(false)
  expect(ran.store!.session(ran.engine.sessionId!)).toBeDefined()
  // No store (--no-store): nothing to do.
  expect(createApp({ cwd: root, modelTitles: false, asker, store: false }).discardIfEmpty()).toBe(false)
})
