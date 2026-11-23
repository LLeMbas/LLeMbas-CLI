// A steered message is given to the model once (harness/acp.md `_lembas/steer`; spec 3.10.0): a
// prompt carrying the id of a message the session was steered does not run — it says what became
// of the message — and a prompt's turn that ends with no link up carries its too-late steers to
// the next turn, as a turn the harness started does.
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AcpAgent, type Limits } from "../src/acp/agent.ts"
import { Hub } from "../src/acp/hub.ts"
import { Peer, type Transport } from "../src/acp/rpc.ts"
import { paths } from "../src/config/paths.ts"
import { setTrust } from "../src/project/root.ts"
import { delta, fakeProvider, type Fake, type Scripted } from "./fake-provider.ts"

let fake: Fake | undefined
const stops: (() => unknown)[] = []
afterEach(async () => {
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
const slow = (text: string, ms: number): Scripted => ({ chunks: [delta({ content: "… " }), delta({ content: text })], gapMs: ms })
const users = (body: any): string => body.messages.filter((m: any) => m.role === "user").map((m: any) => (typeof m.content === "string" ? m.content : m.content.map((p: any) => p.text ?? "").join("\n"))).join("\n")

function setup(script: Scripted[], config = "") {
  fake = fakeProvider(script)
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  f:\n    type: webui\n    url: ${fake.url}\n    models: { f/m: {} }\n`, { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), `model: f/m\nmode: auto\n${config}`)
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ph-once-")))
  setTrust(dir, "trusted")
  return dir
}
const limitsFor = (root: string): Limits => ({ roots: [root], maxMode: "auto", approvalTimeoutMs: 3000, requireTrust: true, enabled: true })

async function link(root: string, hub?: Hub) {
  const [ta, tb] = pair()
  new AcpAgent(new Peer(ta), limitsFor(root), undefined, hub)
  const c = new Peer(tb)
  const events: any[] = []
  c.on("_lembas/event", (p) => void events.push(p.event))
  await c.request("initialize", { protocolVersion: 1, clientCapabilities: { _meta: { lembas: { protocol: 3 } } } })
  return { c, events, drop: () => tb.close() }
}
async function service(root: string) {
  const hub = new Hub({ service: true, limits: { ...limitsFor(root), enabled: true } })
  expect(await hub.listen()).toBe(true)
  stops.push(async () => {
    for (const s of hub.held.values()) await s.app.close().catch(() => {})
    hub.close()
  })
  return hub
}
const until = async (ok: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms
  while (Date.now() < end && !ok()) await Bun.sleep(20)
  return ok()
}
const go = (c: Peer, sid: string, text: string, turnId: string) => c.request<any>("session/prompt", { sessionId: sid, prompt: [{ type: "text", text }], _meta: { lembas: { turnId } } })
const begun = (events: any[]) => events.some((e) => e.type === "text" && e.text === "… ")

test("a message the turn took in, sent again as a prompt with its id, does not run: taken — also after a restart", async () => {
  const root = setup([slow("First.", 1000), say("With it.")])
  const hub = await service(root)
  const { c, events } = await link(root, hub)
  const s: any = await c.request("session/new", { cwd: root, mcpServers: [] })
  const sid = s.sessionId as string
  const first = go(c, sid, "go", "web-1")
  expect(await until(() => begun(events))).toBe(true)
  await c.request("_lembas/steer", { sessionId: sid, text: "and say hello", messageId: "web-2" })
  // While it waits in the running turn's queue, the same id as a prompt runs nothing either.
  expect(await go(c, sid, "and say hello", "web-2")).toEqual({ stopReason: "end_turn", _meta: { lembas: { turnId: "web-2", steered: "waiting" } } })
  expect((await first)._meta.lembas.unsent).toBeUndefined()
  expect(events.find((e) => e.type === "steered")).toMatchObject({ ids: ["web-2"] })
  expect(fake!.requests).toHaveLength(2)
  expect(await go(c, sid, "and say hello", "web-2")).toEqual({ stopReason: "end_turn", _meta: { lembas: { turnId: "web-2", steered: "taken" } } })
  // The device starts again: the session comes from the store, and still knows the id.
  const held = hub.held.get(sid)!
  await held.app.close()
  hub.held.delete(sid)
  const again = await link(root)
  expect(await go(again.c, sid, "and say hello", "web-2")).toEqual({ stopReason: "end_turn", _meta: { lembas: { turnId: "web-2", steered: "taken" } } })
  expect(fake!.requests).toHaveLength(2)
  expect(again.events.some((e) => e.type === "prompt")).toBe(false)
}, SLOW)

test("a prompt's turn that ends with no link up carries its too-late steer; its id as a prompt says carried, then taken — the model reads it once", async () => {
  // busy_input: queue — nothing goes in at a step by itself, so the turn ends with it waiting.
  const root = setup([slow("First.", 1000), say("Second."), say("Third.")], "busy_input: queue\n")
  const hub = await service(root)
  const first = await link(root, hub)
  const s: any = await first.c.request("session/new", { cwd: root, mcpServers: [] })
  const sid = s.sessionId as string
  void go(first.c, sid, "go", "web-1").catch(() => {})
  expect(await until(() => begun(first.events))).toBe(true)
  await first.c.request("_lembas/steer", { sessionId: sid, text: "one more thing", messageId: "web-2" })
  first.drop()
  const held = hub.held.get(sid)!
  expect(await until(() => !held.prompting && !held.app.engine.busy)).toBe(true)
  // The link is back. The answer kept for the first prompt hands nothing back: it was carried.
  const { c, events } = await link(root, hub)
  expect((await go(c, sid, "go", "web-1"))._meta.lembas.unsent).toBeUndefined()
  // "Send now" for the message the client is unsure of: not run, and said to be carried.
  expect(await go(c, sid, "one more thing", "web-2")).toEqual({ stopReason: "end_turn", _meta: { lembas: { turnId: "web-2", steered: "carried" } } })
  expect(fake!.requests).toHaveLength(1)
  // The next turn takes it in at its first step.
  expect((await go(c, sid, "next", "web-3")).stopReason).toBe("end_turn")
  expect(events.find((e) => e.type === "steered")).toMatchObject({ texts: ["one more thing"], ids: ["web-2"] })
  expect(await go(c, sid, "one more thing", "web-2")).toEqual({ stopReason: "end_turn", _meta: { lembas: { turnId: "web-2", steered: "taken" } } })
  expect(fake!.requests).toHaveLength(2)
  expect(users(fake!.requests[1]).split("one more thing")).toHaveLength(2)
}, SLOW)

test("a steer handed back as unsent is the client's again: its id as a prompt runs", async () => {
  const root = setup([slow("First.", 1000), say("Now that.")], "busy_input: queue\n")
  const { c, events } = await link(root)
  const s: any = await c.request("session/new", { cwd: root, mcpServers: [] })
  const sid = s.sessionId as string
  const first = go(c, sid, "go", "web-1")
  expect(await until(() => begun(events))).toBe(true)
  await c.request("_lembas/steer", { sessionId: sid, text: "then that", messageId: "web-2" })
  expect((await first)._meta.lembas.unsent).toEqual(["then that"])
  const r = await go(c, sid, "then that", "web-2")
  expect(r._meta.lembas.steered).toBeUndefined()
  expect(fake!.requests).toHaveLength(2)
  expect(events.filter((e) => e.type === "prompt").map((e) => e.turnId)).toEqual(["web-1", "web-2"])
}, SLOW)
