// The hub: one session, used from the terminal and the web UI alike. A fake LLeMbas is the
// ACP client on one side of the agent; a terminal's App and its Share are on the other, through a
// real Unix socket.
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AcpAgent, historyTurns, refusalFor, type Limits } from "../src/acp/agent.ts"
import { Hub } from "../src/acp/hub.ts"
import { Peer, type Transport } from "../src/acp/rpc.ts"
import { releaseForResume, Share, type LocalAsk } from "../src/acp/share.ts"
import { createApp, type App } from "../src/app.ts"
import type { AskReply } from "../src/bus/index.ts"
import { paths } from "../src/config/paths.ts"
import { setTrust } from "../src/project/root.ts"
import { Store } from "../src/session/store.ts"
import { delta, fakeProvider, toolCall, type Fake } from "./fake-provider.ts"

let fake: Fake | undefined
const stops: (() => void)[] = []
afterEach(() => {
  fake?.stop()
  for (const s of stops.splice(0).reverse()) s()
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

function config(url: string, extra = "") {
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  f:\n    dialect: openai-chat\n    base_url: ${url}\n    models: { m: {} }\n`, { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), `model: f/m\n${extra}`)
}

function project(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ph-hub-")))
  setTrust(dir, "trusted")
  return dir
}

const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 200 && !ok(); i++) await Bun.sleep(10)
  if (!ok()) throw new Error(`timed out waiting for ${what}`)
}

/** The hub and a fake instance linked to it. */
async function linked(limits: Limits, o: { service?: boolean; answer?: (p: any) => unknown } = {}) {
  const hub = new Hub({ service: o.service ?? true, limits: { ...limits, enabled: true } })
  expect(await hub.listen()).toBe(true)
  stops.push(() => hub.close())
  const [ta, tb] = pair()
  new AcpAgent(new Peer(ta), limits, undefined, hub)
  const web = new Peer(tb)
  const heard: { method: string; params: any }[] = []
  for (const m of ["_lembas/session/announce", "_lembas/session/left", "_lembas/session/deleted", "_lembas/permission/settled", "_lembas/event"]) web.on(m, (p) => void heard.push({ method: m, params: p }))
  web.handle("session/request_permission", (p) => o.answer?.(p) ?? { outcome: { outcome: "selected", optionId: "once" } })
  await web.request("initialize", { protocolVersion: 1, clientCapabilities: { _meta: { lembas: true } } })
  return { hub, web, heard, events: (sid: string) => heard.filter((h) => h.method === "_lembas/event" && h.params.sessionId === sid).map((h) => h.params.event) }
}

/** A terminal: its App, and its Share running prompts the way the TUI does. */
async function terminal(root: string, askLocal?: (req: any) => LocalAsk) {
  const local = (req: any): LocalAsk => askLocal?.(req) ?? { reply: Promise.resolve({ kind: "once" }), dismiss: () => {} }
  // As the TUI wires it: an approval goes through the Share, which asks here and on the web.
  let share: Share | undefined
  const app: App = createApp({ cwd: root, modelTitles: false, asker: { ask: (req) => (share ? share.ask(req, local(req)) : local(req).reply) } })
  const notices: string[] = []
  share = new Share(app, {
    prompt: (r, started) => (started(), app.turns.prompt(r.prompt, r.extra, r.shown, { turnId: r.turnId, attachments: r.attachments })),
    compact: () => app.engine.compact(),
    deleted: () => app.newSession(),
    notice: (t) => void notices.push(t),
    changed: () => {},
  })
  const shared = share
  stops.push(() => shared.close())
  await shared.start()
  return { app, share: shared, notices }
}

const limitsFor = (root: string, extra: Partial<Limits> = {}): Limits => ({ roots: [root], maxMode: "auto", approvalTimeoutMs: 2000, requireTrust: true, ...extra })

test("a terminal's session is announced, and the web UI prompts it there", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "from the web" })] }, { chunks: [delta({ content: "typed here" })] }])
  const root = project()
  config(fake.url, "mode: edit\n")
  const { web, heard, events } = await linked(limitsFor(root))
  const { app, share } = await terminal(root)
  const id = app.engine.sessionId!
  await until(() => heard.some((h) => h.method === "_lembas/session/announce"), "the announcement")
  expect(share.sharedId).toBe(id)
  expect(heard.find((h) => h.method === "_lembas/session/announce")!.params).toMatchObject({ sessionId: id, cwd: root, mode: "edit", origin: "terminal" })

  // The web UI's prompt runs in the terminal's own session.
  const r: any = await web.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text: "hello" }] })
  expect(r.stopReason).toBe("end_turn")
  expect(app.engine.messages.some((m) => m.role === "user" && JSON.stringify(m).includes("hello"))).toBe(true)
  expect(events(id).filter((e) => e.type === "text").map((e) => e.text).join("")).toBe("from the web")

  // What is typed in the terminal reaches the web UI as it happens: the prompt, the reply, the end.
  await app.turns.prompt("and this")
  await until(() => events(id).filter((e) => e.type === "task" && e.state === "end").length === 2, "the second task")
  const second = events(id).slice(events(id).findIndex((e) => e.type === "prompt" && e.text === "and this"))
  expect(second.map((e) => e.type)).toContain("text")

  // Its whole history, for a web UI that has not seen it yet.
  const h: any = await web.request("_lembas/session/history", { sessionId: id })
  expect(h.turns.map((t: any) => t.role)).toEqual(["user", "assistant", "user", "assistant"])
  expect(h.turns[3].text).toBe("typed here")

  share.close()
  await until(() => heard.some((x) => x.method === "_lembas/session/left"), "the terminal leaving")
  expect(heard.find((x) => x.method === "_lembas/session/left")!.params).toEqual({ sessionId: id, available: true })
})

test("a session the web UI started is carried on in a terminal, not forked — and back", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "one" })] }, { chunks: [delta({ content: "two" })] }, { chunks: [delta({ content: "three" })] }])
  const root = project()
  config(fake.url)
  const { web } = await linked(limitsFor(root))
  const s: any = await web.request("session/new", { cwd: root })
  await web.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "started on the web" }] })

  // Opened in a terminal: the hub lets go of it, the terminal resumes it from the store.
  const { app, share } = await terminal(root)
  expect(await releaseForResume(s.sessionId)).toBeUndefined()
  app.resume(s.sessionId)
  await until(() => share.sharedId === s.sessionId, "the resumed session shared")
  expect(app.engine.messages.some((m) => JSON.stringify(m).includes("started on the web"))).toBe(true)

  // The web UI's next prompt goes to the terminal, which has the whole conversation.
  await web.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "and now?" }] })
  expect(JSON.stringify(fake.requests[1].messages)).toContain("started on the web")

  // The terminal closes: the service opens it from the store at the next prompt, with all of it.
  share.close()
  await Bun.sleep(50)
  await web.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "back on the service" }] })
  const sent = JSON.stringify(fake.requests[2].messages)
  expect(sent).toContain("started on the web")
  expect(sent).toContain("and now?")
})

test("a session working on the web UI's prompt is not taken from under it", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "slow " }), delta({ content: "reply" })], gapMs: 300 }])
  const root = project()
  config(fake.url)
  const { web } = await linked(limitsFor(root))
  const s: any = await web.request("session/new", { cwd: root })
  const running = web.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "go" }] })
  await Bun.sleep(50)
  expect(await releaseForResume(s.sessionId)).toContain("working on a prompt from the web UI")
  await running
  expect(await releaseForResume(s.sessionId)).toBeUndefined()
})

test("an approval is asked on both sides; the web UI's answer takes the terminal's card down", async () => {
  fake = fakeProvider([
    { chunks: [toolCall(0, "t1", "bash", JSON.stringify({ command: "echo both-sides", description: "say it" }))] },
    { chunks: [delta({ content: "ran it" })] },
  ])
  const root = project()
  config(fake.url, "mode: manual\n")
  let asked: any
  const { heard } = await linked(limitsFor(root), {
    answer: async (p) => {
      asked = p
      await Bun.sleep(20)
      return { outcome: { outcome: "selected", optionId: "once" } }
    },
  })
  let dismissed: AskReply | undefined
  const { app, notices } = await terminal(root, () => {
    let settle!: (r: AskReply) => void
    const reply = new Promise<AskReply>((r) => (settle = r))
    return { reply, dismiss: (r) => ((dismissed = r), settle(r)) }
  })
  await until(() => heard.some((h) => h.method === "_lembas/session/announce"), "the announcement")
  const r = await app.turns.prompt("run it")
  expect(r).toBe("stop")
  expect(asked._meta.lembas.patient).toBe(true)
  expect(dismissed).toEqual({ kind: "once" })
  expect(notices.join("\n")).toContain("answered in the web UI")
})

test("outside the device's limits a terminal's session stays its own, unless shared by name", async () => {
  fake = fakeProvider([])
  const root = project()
  const elsewhere = project()
  config(fake.url)
  const { heard } = await linked(limitsFor(root))
  const { share } = await terminal(elsewhere)
  await Bun.sleep(50)
  expect(share.sharedId).toBeUndefined()
  expect(heard.some((h) => h.method === "_lembas/session/announce")).toBe(false)
  expect(await share.remote(true)).toContain("shared with the web UI")
  expect(heard.find((h) => h.method === "_lembas/session/announce")!.params.cwd).toBe(elsewhere)
  expect(await share.remote(false)).toContain("no longer shared")
})

test("without the service, a terminal's session is shared only by name", async () => {
  fake = fakeProvider([])
  const root = project()
  config(fake.url)
  const { heard } = await linked(limitsFor(root), { service: false })
  const { share } = await terminal(root)
  await Bun.sleep(50)
  expect(share.sharedId).toBeUndefined()
  expect(share.status()).toContain("/remote")
  await share.remote(true)
  expect(share.sharedId).toBeDefined()
  expect(heard.some((h) => h.method === "_lembas/session/announce")).toBe(true)
})

test("after a restart, a session id the instance kept is opened from the store", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "first" })] }, { chunks: [delta({ content: "remembered" })] }])
  const root = project()
  config(fake.url)
  const limits = limitsFor(root)
  const first = await linked(limits)
  const s: any = await first.web.request("session/new", { cwd: root })
  await first.web.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "remember the word heron" }] })
  // A new link (the service restarted): the same id still answers, with its history.
  const [ta, tb] = pair()
  new AcpAgent(new Peer(ta), limits)
  const web = new Peer(tb)
  await web.request("initialize", { protocolVersion: 1, clientCapabilities: { _meta: { lembas: true } } })
  const r: any = await web.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "which word?" }] })
  expect(r.stopReason).toBe("end_turn")
  expect(JSON.stringify(fake.requests[1].messages)).toContain("heron")
})

test("historyTurns: a person's message, then what was said, thought and run in answer", () => {
  const turns = historyTurns([
    { role: "user", parts: [{ type: "text", text: "list it" }] },
    { role: "assistant", parts: [{ type: "reasoning", text: "hmm" }, { type: "tool_call", id: "c1", name: "bash", args: '{"command":"ls"}' }] },
    { role: "tool", callId: "c1", name: "bash", content: "a\nb" },
    { role: "assistant", parts: [{ type: "text", text: "two files" }] },
  ])
  expect(turns).toEqual([
    { role: "user", text: "list it" },
    { role: "assistant", text: "two files", reasoning: "hmm", tools: [{ id: "c1", name: "bash", args: '{"command":"ls"}', output: "a\nb", isError: false }] },
  ])
})

// The session's own state decides, and what one side does to it the other sees.

test("a prompt that comes while the session works waits its turn instead of being refused", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "first " }), delta({ content: "reply" })], gapMs: 150 }, { chunks: [delta({ content: "second" })] }])
  const root = project()
  config(fake.url)
  const { web } = await linked(limitsFor(root))
  const s: any = await web.request("session/new", { cwd: root })
  const one = web.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "one" }] })
  await Bun.sleep(30)
  expect(await web.request<any>("_lembas/session/status", { sessionId: s.sessionId })).toMatchObject({ exists: true, held: "here", busy: true })
  const two = web.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "two" }] })
  expect(((await one) as any).stopReason).toBe("end_turn")
  expect(((await two) as any).stopReason).toBe("end_turn")
  // The second ran after the first, with its answer in the conversation.
  expect(JSON.stringify(fake.requests[1].messages)).toContain("first reply")
  expect(await web.request<any>("_lembas/session/status", { sessionId: s.sessionId })).toMatchObject({ busy: false })
  expect(await web.request<any>("_lembas/session/status", { sessionId: "ses_none" })).toMatchObject({ exists: false, held: "none" })
})

test("a message sent mid-task comes back with its id where the model took it in", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "working " }), delta({ content: "on it" })], gapMs: 100 }, { chunks: [delta({ content: "and that" })] }])
  const root = project()
  config(fake.url)
  const { web, events } = await linked(limitsFor(root))
  const s: any = await web.request("session/new", { cwd: root })
  const running = web.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "go" }] })
  await Bun.sleep(30)
  await web.request("_lembas/steer", { sessionId: s.sessionId, text: "also this", messageId: "m42" })
  await running
  const steered = events(s.sessionId).find((e) => e.type === "steered")
  expect(steered).toMatchObject({ texts: ["also this"], ids: ["m42"] })
  // Between the reply it interrupted and the one that answered it.
  const order = events(s.sessionId).map((e) => e.type)
  expect(order.indexOf("steered")).toBeGreaterThan(order.indexOf("text"))
  expect(order.lastIndexOf("text")).toBeGreaterThan(order.indexOf("steered"))
})

test("the web UI deletes a session, renames it and compacts it — the one in the store", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "an answer" })] }, { chunks: [delta({ content: "a summary" })] }])
  const root = project()
  config(fake.url)
  const { web, events } = await linked(limitsFor(root))
  const s: any = await web.request("session/new", { cwd: root })
  await web.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "hello" }] })
  expect(await web.request<any>("_lembas/session/title", { sessionId: s.sessionId, title: "Named on the web" })).toEqual({ title: "Named on the web" })
  expect(((await web.request("_lembas/session/history", { sessionId: s.sessionId })) as any).title).toBe("Named on the web")
  expect(((await web.request("_lembas/session/compact", { sessionId: s.sessionId })) as any).summary).toBe("a summary")
  expect(events(s.sessionId).some((e) => e.type === "compacted")).toBe(true)
  expect(await web.request<any>("_lembas/session/delete", { sessionId: s.sessionId })).toEqual({ deleted: true })
  expect(await web.request<any>("_lembas/session/status", { sessionId: s.sessionId })).toMatchObject({ exists: false })
  expect(await web.request<any>("_lembas/session/delete", { sessionId: s.sessionId })).toEqual({ deleted: false })
})

test("deleting on one side deletes on the other: a terminal's session, both ways", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "hi" })] }])
  const root = project()
  config(fake.url)
  const { web, heard } = await linked(limitsFor(root))
  const { app, share } = await terminal(root)
  const first = app.engine.sessionId!
  await until(() => share.sharedId === first, "the session shared")
  await web.request("session/prompt", { sessionId: first, prompt: [{ type: "text", text: "hello" }] })
  expect(((await web.request("_lembas/session/status", { sessionId: first })) as any).held).toBe("terminal")

  // From the web: gone from the store, and the terminal goes on in a new session, shared as any is.
  expect(await web.request<any>("_lembas/session/delete", { sessionId: first })).toEqual({ deleted: true })
  expect(app.store!.session(first)).toBeUndefined()
  const second = app.engine.sessionId!
  expect(second).not.toBe(first)
  await until(() => share.sharedId === second, "the new session shared")

  // From the terminal: the instance is told, and deletes the chat.
  expect(await share.deleted(second)).toBeUndefined()
  await until(() => heard.some((h) => h.method === "_lembas/session/deleted"), "the deletion")
  expect(heard.find((h) => h.method === "_lembas/session/deleted")!.params).toEqual({ sessionId: second })
  expect(app.store!.session(second)).toBeUndefined()
})

test("a link that drops and comes back finds the session still working, and follows it", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "a long " }), delta({ content: "answer" })], gapMs: 150 }])
  const root = project()
  config(fake.url)
  const limits = limitsFor(root)
  const hub = new Hub({ service: true, limits: { ...limits, enabled: true } })
  expect(await hub.listen()).toBe(true)
  stops.push(() => hub.close())
  const connect = async () => {
    const [ta, tb] = pair()
    new AcpAgent(new Peer(ta), limits, undefined, hub)
    const web = new Peer(tb)
    const events: any[] = []
    web.on("_lembas/event", (p) => void events.push(p.event))
    web.handle("session/request_permission", () => ({ outcome: { outcome: "selected", optionId: "once" } }))
    await web.request("initialize", { protocolVersion: 1, clientCapabilities: { _meta: { lembas: true } } })
    return { web, events, drop: () => ta.close() }
  }
  const first = await connect()
  const s: any = await first.web.request("session/new", { cwd: root })
  void first.web.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "go" }] }).catch(() => {})
  await Bun.sleep(40)
  first.drop()
  expect(hub.busy()).toBe(true)

  // The instance is back: the session is still at work, and its events reach the new link.
  const second = await connect()
  expect(await second.web.request<any>("_lembas/session/status", { sessionId: s.sessionId })).toMatchObject({ held: "here", busy: true })
  await until(() => second.events.some((e) => e.type === "task" && e.state === "end"), "the turn to end on the new link")
  expect(second.events.filter((e) => e.type === "text").map((e) => e.text).join("")).toContain("answer")
  expect(hub.busy()).toBe(false)
})

// ── Deleting what the web UI was shown ────────────────────────────────────────────────
// A delete from the web UI was judged by the rule for *opening* a session, trust and all — and
// refused, silently on both sides, exactly the sessions the web UI had been showing as chats.

/** A link to an agent with no hub and nothing held: this machine's service after a restart. */
async function restarted(limits: Limits) {
  const [ta, tb] = pair()
  new AcpAgent(new Peer(ta), limits)
  const web = new Peer(tb)
  await web.request("initialize", { protocolVersion: 1, clientCapabilities: { _meta: { lembas: true } } })
  return web
}

test("a session shared by name from an untrusted directory is deleted from the web after its terminal let go", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "hi" })] }])
  // Inside remote.roots, but nobody trusted it: the service does not share it, /remote does.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ph-hub-untrusted-")))
  config(fake.url)
  const { web } = await linked(limitsFor(root))
  const { app, share } = await terminal(root)
  const id = app.engine.sessionId!
  expect(share.sharedId).toBeUndefined()
  await share.remote(true)
  expect(share.sharedId).toBe(id)
  await web.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text: "hello" }] })
  // The terminal closes; the chat stays in the web UI, which deletes it.
  share.close()
  await Bun.sleep(30)
  expect(app.store!.session(id)).toBeDefined()
  expect(await web.request<any>("_lembas/session/delete", { sessionId: id })).toEqual({ deleted: true })
  expect(app.store!.session(id)).toBeUndefined()
})

test("a web session in a trusted subdirectory of an untrusted project is deleted, held or not", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "one" })] }])
  // The project's directory is the parent's: its root, which is what the store keeps, is untrusted.
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "ph-hub-parent-")))
  mkdirSync(join(parent, ".lembas"))
  const sub = join(parent, "work")
  mkdirSync(sub)
  setTrust(sub, "trusted")
  config(fake.url)
  const limits = limitsFor(parent)
  const { web } = await linked(limits)
  const a: any = await web.request("session/new", { cwd: sub })
  const b: any = await web.request("session/new", { cwd: sub })
  await web.request("session/prompt", { sessionId: a.sessionId, prompt: [{ type: "text", text: "hello" }] })
  // Held by the link that made it.
  expect(await web.request<any>("_lembas/session/delete", { sessionId: a.sessionId })).toEqual({ deleted: true })
  // After a restart of the service, nothing held: the mark the link left is what says so.
  const again = await restarted(limits)
  expect(await again.request<any>("_lembas/session/delete", { sessionId: b.sessionId })).toEqual({ deleted: true })
})

test("a session the web UI was never shown is deleted only inside remote.roots", async () => {
  config("http://127.0.0.1:1")
  const none = { ask: () => Promise.resolve({ kind: "once" } as AskReply) }
  const inside = realpathSync(mkdtempSync(join(tmpdir(), "ph-hub-in-")))
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "ph-hub-out-")))
  const here = createApp({ cwd: outside, modelTitles: false, asker: none })
  const away = here.engine.sessionId!
  const local = createApp({ cwd: inside, modelTitles: false, asker: none })
  const near = local.engine.sessionId!
  const web = await restarted(limitsFor(inside))
  // Outside: refused, and says why.
  await expect(web.request("_lembas/session/delete", { sessionId: away })).rejects.toThrow(/outside the directories/)
  expect(here.store!.session(away)).toBeDefined()
  // Inside, untrusted, from before the mark: a delete runs nothing there, so trust is not asked.
  expect(await web.request<any>("_lembas/session/delete", { sessionId: near })).toEqual({ deleted: true })
  // Remote work off (the link a terminal holds for /remote): only what it shared.
  const third = createApp({ cwd: inside, modelTitles: false, asker: none })
  const off = await restarted({ ...limitsFor(inside), sharedOnly: true })
  await expect(off.request("_lembas/session/delete", { sessionId: third.engine.sessionId! })).rejects.toThrow(/remote work is off/)
})

test("a terminal's busy session deleted from the web stops before it goes", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "a " }), delta({ content: "long " }), delta({ content: "answer" })], gapMs: 150 }])
  const root = project()
  config(fake.url)
  const { web } = await linked(limitsFor(root))
  const { app, share } = await terminal(root)
  const first = app.engine.sessionId!
  await until(() => share.sharedId === first, "the session shared")
  const running = app.turns.prompt("go").catch(() => {})
  await until(() => Boolean(app.turns.current), "the turn started")
  expect(await web.request<any>("_lembas/session/delete", { sessionId: first })).toEqual({ deleted: true })
  // The turn was over before the session went, and nothing of it was written anywhere after.
  expect(app.turns.current).toBeUndefined()
  await running
  expect(app.store!.session(first)).toBeUndefined()
  expect(app.engine.sessionId).not.toBe(first)
})

// ── what else could keep a deleted session in /sessions ───────────────────────────────────────

test("a home directory used as the project root, trusted by name, is accepted and its sessions deleted", () => {
  // A home directory holding the project directory and trusted as itself in trust.json, with
  // remote.roots [home]: both the opening rule and the delete rule accept it, marked or not.
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ph-hub-home-")))
  mkdirSync(join(home, ".agent"))
  setTrust(home, "trusted")
  const L = limitsFor(home)
  expect(refusalFor(L, home)).toBeUndefined()
  mkdirSync(join(home, ".agent", "local"))
  expect(refusalFor(L, home)).toBeUndefined()
  config("http://127.0.0.1:1")
  const app = createApp({ cwd: home, modelTitles: false, asker: { ask: () => Promise.resolve({ kind: "once" } as AskReply) } })
  expect(app.store!.session(app.engine.sessionId!)!.root).toBe(home)
})

test("opening a stored session for the web UI leaves no empty session behind", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "typed" })] }, { chunks: [delta({ content: "from the web" })] }])
  const root = project()
  config(fake.url)
  // A terminal's session, the terminal gone: the web UI prompts it, and the service opens it from the
  // store. Making a fresh session first and then resuming the stored one would leave an empty,
  // untitled session in the project at every such opening — listed by /sessions as its bare id, and
  // still there after the chat was deleted.
  const term = createApp({ cwd: root, modelTitles: false, asker: { ask: () => Promise.resolve({ kind: "once" } as AskReply) } })
  await term.turns.prompt("from the terminal")
  const id = term.engine.sessionId!
  const store = term.store!
  const web = await restarted(limitsFor(root))
  await web.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text: "hello" }] })
  expect(store.sessions(50, root).map((s) => s.id)).toEqual([id])
  expect(await web.request<any>("_lembas/session/delete", { sessionId: id })).toEqual({ deleted: true })
  expect(store.sessions(50, root)).toEqual([])
})

test("a delete waits out another process's write instead of failing as locked", async () => {
  const store = new Store()
  const s = store.createSession("/nowhere", "m")
  // Another process mid-write — a terminal appending a turn — holding the lock for a moment.
  const child = Bun.spawn(
    [process.execPath, "-e", `const {Database}=require("bun:sqlite");const d=new Database(process.argv[1]);d.run("PRAGMA journal_mode=WAL");d.run("BEGIN IMMEDIATE");d.run("UPDATE sessions SET updated=updated");console.log("locked");setTimeout(()=>d.run("COMMIT"),700)`, store.db.filename],
    { stdout: "pipe" },
  )
  const reader = child.stdout.getReader()
  await reader.read()
  expect(store.deleteSession(s.id)).toBe(true)
  await child.exited
})
