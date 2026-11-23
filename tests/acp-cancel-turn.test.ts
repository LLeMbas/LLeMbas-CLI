// `session/cancel` with the turn named (harness/acp.md; spec 3.10.0, capability harness_turns): a
// prompt that waits behind a turn its client did not start is taken out of the queue — answered as
// cancelled, never run — and the turn that runs is not touched. Without the id, the running turn.
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AcpAgent, type Limits } from "../src/acp/agent.ts"
import { Hub } from "../src/acp/hub.ts"
import { Peer, type Transport } from "../src/acp/rpc.ts"
import { Share } from "../src/acp/share.ts"
import { createApp } from "../src/app.ts"
import { paths } from "../src/config/paths.ts"
import { setTrust } from "../src/project/root.ts"
import { delta, fakeProvider, toolCall, type Fake, type Scripted } from "./fake-provider.ts"

let fake: Fake | undefined
const stops: (() => unknown)[] = []
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) writeFileSync(join(root, "f1"), "")
  for (const s of stops.splice(0).reverse()) await s()
  fake?.stop()
})

function pair(): [Transport, Transport] {
  const make = () => ({ msg: (_: string) => {}, end: () => {} })
  const a = make()
  const b = make()
  const side = (me: typeof a, o: typeof a): Transport => ({
    send: (t) => queueMicrotask(() => o.msg(t)),
    onMessage: (fn) => (me.msg = fn),
    onClose: (fn) => (me.end = fn),
    close: () => (me.end(), o.end()),
  })
  return [side(a, b), side(b, a)]
}

const SLOW = 30_000
const say = (text: string): Scripted => ({ chunks: [delta({ content: text }, "stop")] })
/** A reply that stays open for `ms` after its first words. */
const slow = (text: string, ms: number): Scripted => ({ chunks: [delta({ content: "… " }), delta({ content: text })], gapMs: ms })
const waitFor = (flag: string) => `until [ -e ${flag} ]; do sleep 0.05; done`

function setup(script: Scripted[]) {
  fake = fakeProvider(script)
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  f:\n    type: webui\n    url: ${fake.url}\n    models: { f/m: {} }\n`, { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), "model: f/m\nmode: auto\n")
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ph-cancel-")))
  setTrust(dir, "trusted")
  roots.push(dir)
  return dir
}
const limitsFor = (root: string): Limits => ({ roots: [root], maxMode: "auto", approvalTimeoutMs: 3000, requireTrust: true, enabled: true, scheduled: true })

async function link(root: string, hub?: Hub) {
  const [ta, tb] = pair()
  new AcpAgent(new Peer(ta), limitsFor(root), undefined, hub)
  const c = new Peer(tb)
  const events: any[] = []
  c.on("_lembas/event", (p) => void events.push(p.event))
  c.on("_lembas/session/announce", () => {})
  c.handle("session/request_permission", () => ({ outcome: { outcome: "selected", optionId: "once" } }))
  await c.request("initialize", { protocolVersion: 1, clientCapabilities: { _meta: { lembas: { protocol: 3 } } } })
  return { c, events }
}
const until = async (ok: () => boolean | Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms
  while (Date.now() < end && !(await ok())) await Bun.sleep(20)
  return ok()
}
const go = (c: Peer, sid: string, text: string, meta: Record<string, unknown>) => c.request<any>("session/prompt", { sessionId: sid, prompt: [{ type: "text", text }], _meta: { lembas: meta } })
const cancel = (c: Peer, sid: string, turnId?: string) => c.request<any>("session/cancel", { sessionId: sid, ...(turnId ? { _meta: { lembas: { turnId } } } : {}) })

test("a queued prompt named by its turn is taken out of the queue; the harness turn that runs is not touched", async () => {
  const root = setup([{ chunks: [toolCall(0, "j1", "bash", JSON.stringify({ command: waitFor("f1"), background: true, description: "wait for f1" })), delta({}, "tool_calls")] }, say("Started."), slow("Seen the end.", 4000)])
  const { c, events } = await link(root)
  const s: any = await c.request("session/new", { cwd: root, mcpServers: [] })
  const sid = s.sessionId as string
  const status = () => c.request<any>("_lembas/session/status", { sessionId: sid })
  await go(c, sid, "go", { turnId: "web-1" })
  writeFileSync(join(root, "f1"), "")
  // The harness's turn runs, and its reply has begun.
  expect(await until(() => events.some((e) => e.type === "prompt" && e.machine) && events.some((e) => e.type === "text" && e.text === "… "))).toBe(true)
  const m = events.find((e) => e.type === "prompt" && e.machine)
  let answer: any
  const second = go(c, sid, "and now this", { turnId: "web-2" }).then((r) => (answer = r))
  expect(await until(async () => (await status()).queued.includes("web-2"))).toBe(true)
  // An id nobody has, and one that finished: nothing is done.
  expect(await cancel(c, sid, "nobody")).toEqual({ cancelled: "none" })
  expect(await cancel(c, sid, "web-1")).toEqual({ cancelled: "none" })
  expect(await status()).toMatchObject({ busy: true, turnId: m.turnId, queued: ["web-2"] })
  // The queued one: out of the queue, answered as cancelled now — while the other turn still runs.
  expect(await cancel(c, sid, "web-2")).toEqual({ cancelled: "queued" })
  await second
  expect(answer).toEqual({ stopReason: "cancelled", _meta: { lembas: { turnId: "web-2" } } })
  expect(await status()).toMatchObject({ busy: true, turnId: m.turnId, queued: [] })
  expect(events.some((e) => e.type === "done" && e.reason === "cancelled")).toBe(false)
  // The harness turn, named: stopped.
  expect(await cancel(c, sid, m.turnId)).toEqual({ cancelled: "running" })
  expect(await until(() => events.some((e) => e.type === "task" && e.state === "end" && e.turnId === m.turnId))).toBe(true)
  expect(await until(async () => !(await status()).busy)).toBe(true)
  // The withdrawn prompt never ran — not then, and not when its place in the queue came; sent
  // again, its id is known and it is answered as cancelled.
  expect(fake!.requests).toHaveLength(3)
  expect(events.filter((e) => e.type === "prompt").map((e) => e.turnId)).toEqual(["web-1", m.turnId])
  expect(await go(c, sid, "and now this", { turnId: "web-2" })).toEqual({ stopReason: "cancelled", _meta: { lembas: { turnId: "web-2" } } })
  expect(fake!.requests).toHaveLength(3)
  // Nothing runs now: ACP's own cancel finds nothing either.
  expect(await cancel(c, sid)).toEqual({ cancelled: "none" })
}, SLOW)

test("a queued scheduled run taken back answers as a cancelled run", async () => {
  const root = setup([slow("First.", 3000)])
  const { c, events } = await link(root)
  const meta = { scheduled: { schedule_id: "sched1", run_id: "run8", title: "Check", mode: "auto" } }
  const s: any = await c.request("session/new", { cwd: root, mcpServers: [], _meta: { lembas: meta } })
  const sid = s.sessionId as string
  // The person writes into the run's chat; the next run arrives meanwhile and waits.
  const first = go(c, sid, "hello", { turnId: "web-1" })
  expect(await until(() => events.some((e) => e.type === "text" && e.text === "… "))).toBe(true)
  const run = go(c, sid, "check", { turnId: "run8", ...meta })
  expect(await until(async () => (await c.request<any>("_lembas/session/status", { sessionId: sid })).queued.includes("run8"))).toBe(true)
  expect(await cancel(c, sid, "run8")).toEqual({ cancelled: "queued" })
  expect(await run).toEqual({ stopReason: "cancelled", _meta: { lembas: { turnId: "run8", scheduled: { run_id: "run8", status: "cancelled", text: "", error: null } } } })
  expect((await first).stopReason).toBe("end_turn")
  expect(fake!.requests).toHaveLength(1)
}, SLOW)

test("in a session a terminal runs: a web prompt that has not started there is taken back, and nothing is sent when its turn comes", async () => {
  const root = setup([say("typed here")])
  const hub = new Hub({ service: true, limits: { ...limitsFor(root), enabled: true } })
  expect(await hub.listen()).toBe(true)
  stops.push(() => hub.close())
  const { c } = await link(root, hub)
  // The terminal is busy with something of its own until the test lets it go on.
  let free!: () => void
  const busy = new Promise<void>((r) => (free = r))
  let begun = 0
  const app = createApp({ cwd: root, modelTitles: false, asker: { ask: async () => ({ kind: "once" as const }) } })
  const share = new Share(app, {
    prompt: async (r, started) => {
      await busy
      started()
      begun++
      return app.turns.prompt(r.prompt, r.extra, r.shown, { turnId: r.turnId, attachments: r.attachments })
    },
    compact: () => app.engine.compact(),
    deleted: () => app.newSession(),
    notice: () => {},
    changed: () => {},
  })
  stops.push(() => share.close())
  await share.start()
  const sid = app.engine.sessionId!
  expect(await until(() => hub.shared.has(sid))).toBe(true)
  const sent = go(c, sid, "from the web", { turnId: "web-1" })
  expect(await until(async () => (await c.request<any>("_lembas/session/status", { sessionId: sid })).queued.includes("web-1"))).toBe(true)
  expect(await cancel(c, sid, "nobody")).toEqual({ cancelled: "none" })
  expect(await cancel(c, sid, "web-1")).toEqual({ cancelled: "queued" })
  expect(await sent).toEqual({ stopReason: "cancelled", _meta: { lembas: { turnId: "web-1" } } })
  // The terminal comes to it: it is gone.
  free()
  await busy
  await Bun.sleep(0)
  expect(begun).toBe(0)
  expect(fake!.requests).toHaveLength(0)
  expect(app.turns.current).toBeUndefined()
}, SLOW)
