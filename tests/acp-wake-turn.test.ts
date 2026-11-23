// A turn the harness starts by itself (harness/acp.md, *A turn the harness starts*; spec 3.10.0):
// a finished job's note waking an idle session. Over the link it is a turn like any other — status
// says busy and names it, a message steered joins it, Stop stops it, a prompt waits for it, the
// history keeps it marked `machine` — and two of them never overlap.
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AcpAgent } from "../src/acp/agent.ts"
import { Peer, RpcError, type Transport } from "../src/acp/rpc.ts"
import { paths } from "../src/config/paths.ts"
import { MARKS } from "../src/jobs/note.ts"
import { setTrust } from "../src/project/root.ts"
import { delta, fakeProvider, toolCall, type Fake, type Scripted } from "./fake-provider.ts"

let fake: Fake | undefined
afterEach(() => fake?.stop())

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

async function client(script: Scripted[]) {
  fake = fakeProvider(script)
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  f:\n    type: webui\n    url: ${fake.url}\n    models: { f/m: {} }\n`, { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), "model: f/m\nmode: auto\n")
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ph-acp-wake-")))
  setTrust(dir, "trusted")
  const [ta, tb] = pair()
  new AcpAgent(new Peer(ta))
  const c = new Peer(tb)
  const events: any[] = []
  c.on("_lembas/event", (p) => void events.push(p.event))
  c.handle("session/request_permission", () => ({ outcome: { outcome: "selected", optionId: "once" } }))
  const init: any = await c.request("initialize", { protocolVersion: 1, clientCapabilities: { _meta: { lembas: { protocol: 3 } } } })
  const s: any = await c.request("session/new", { cwd: dir, mcpServers: [] })
  const sid = s.sessionId as string
  const status = () => c.request<any>("_lembas/session/status", { sessionId: sid })
  const machine = () => events.filter((e) => e.type === "prompt" && e.machine === true)
  const ended = (turnId: string) => events.some((e) => e.type === "task" && e.state === "end" && e.turnId === turnId)
  const release = (flag: string) => writeFileSync(join(dir, flag), "")
  return { c, events, sid, init, status, machine, ended, release }
}

const SLOW = 20_000
const until = async (ok: () => boolean, ms = 8000) => {
  const end = Date.now() + ms
  while (Date.now() < end && !ok()) await Bun.sleep(20)
  return ok()
}
const said = (p: Promise<unknown>) => p.then(() => undefined, (e) => (e instanceof RpcError ? `${e.code} ${e.message}` : String(e)))
const go = (c: Peer, sid: string, text = "go", turnId?: string) =>
  c.request<any>("session/prompt", { sessionId: sid, prompt: [{ type: "text", text }], ...(turnId ? { _meta: { lembas: { turnId } } } : {}) })

/** Background commands, each ending when the test lets it (`release`) — so never before the turn
 *  that started it has ended, however slow the machine — and the reply to having started them. */
const waitFor = (flag: string) => `until [ -e ${flag} ]; do sleep 0.05; done`
const background = (...flags: string[]): Scripted[] => [
  { chunks: flags.map((flag, i) => toolCall(i, `t${i + 1}`, "bash", JSON.stringify({ command: waitFor(flag), background: true, description: `wait for ${flag}` }))) },
  { chunks: [delta({ content: "Started." })] },
]
/** A reply that stays open for `ms` after its first words: time to look at the turn while it runs. */
const slow = (text: string, ms = 2500): Scripted => ({ chunks: [delta({ content: "… " }), delta({ content: text })], gapMs: ms })

/** The turns in the order their events came: `start <id>`, `prompt <id>`, `text <words>`, `end <id>`,
 *  with each turn's id replaced by its number. */
function order(events: any[]) {
  const n = new Map<string, number>()
  const of = (id: string) => n.get(id) ?? (n.set(id, n.size + 1), n.size)
  const out: string[] = []
  for (const e of events) {
    if (e.type === "task") out.push(`${e.state} ${of(e.turnId)}`)
    else if (e.type === "prompt") out.push(`prompt ${of(e.turnId)}${e.machine ? " machine" : ""}`)
    else if (e.type === "text" && e.text.trim() && e.text !== "… ") out.push(`text ${e.text}`)
  }
  return out
}

test("status during a wake turn: busy, and the turn named — an id of its own, the one its prompt and task events carry", async () => {
  const { c, events, sid, status, machine, ended, release } = await client([...background("f1"), slow("Seen the end.")])
  const first = await go(c, sid, "go", "web-1")
  release("f1")
  expect(await until(() => machine().length === 1)).toBe(true)
  const m = machine()[0]
  expect(typeof m.turnId).toBe("string")
  expect(m.turnId).not.toBe("web-1")
  expect(first._meta.lembas.turnId).toBe("web-1")
  // Its `task` start came before its prompt, with the same id.
  const at = events.indexOf(m)
  expect(events.slice(0, at).findLast((e) => e.type === "task")).toEqual({ type: "task", state: "start", turnId: m.turnId })
  const during = await status()
  expect(during).toMatchObject({ held: "here", busy: true, turnId: m.turnId, queued: [], lastTurnId: "web-1" })
  expect(await until(() => ended(m.turnId))).toBe(true)
  const after = await status()
  expect(after.busy).toBe(false)
  expect(after.turnId).toBeUndefined()
  expect(after.lastTurnId).toBe(m.turnId)
}, SLOW)

test("initialize lists the harness_turns capability", async () => {
  const { init } = await client([])
  expect(init._meta.lembas.capabilities).toContain("harness_turns")
}, SLOW)

test("the history keeps a wake turn: its note as a user turn marked machine, with the turn's id, and the reply after it", async () => {
  const { c, sid, machine, ended, release } = await client([...background("f1"), { chunks: [delta({ content: "Seen the end." })] }])
  await go(c, sid, "go", "web-1")
  release("f1")
  expect(await until(() => machine().length === 1 && ended(machine()[0].turnId))).toBe(true)
  const h: any = await c.request("_lembas/session/history", { sessionId: sid })
  expect(h.turns.map((t: any) => t.role)).toEqual(["user", "assistant", "user", "assistant"])
  expect(h.turns[0]).toEqual({ role: "user", text: "go", turnId: "web-1" })
  expect(h.turns[0].machine).toBeUndefined()
  const note = h.turns[2]
  expect(note.machine).toBe(true)
  expect(note.turnId).toBe(machine()[0].turnId)
  expect(note.text).toStartWith(`${MARKS.command}\njob1 (${waitFor("f1")}) exited with 0`)
  expect(h.turns[3].text).toBe("Seen the end.")
  // The note is never a prompt: its id sent back as one runs nothing, and answers with no answer.
  const asked = fake!.requests.length
  expect((await c.request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: note.text }], _meta: { lembas: { turnId: note.turnId } } })) ?? null).toBeNull()
  expect(fake!.requests).toHaveLength(asked)
  expect(machine()).toHaveLength(1)
}, SLOW)

test("a message steered during a wake turn joins it", async () => {
  const { c, events, sid, machine, ended, release } = await client([...background("f1"), slow("Seen the end."), { chunks: [delta({ content: "And hello." })] }])
  await go(c, sid)
  release("f1")
  expect(await until(() => machine().length === 1)).toBe(true)
  const m = machine()[0]
  expect(await c.request<any>("_lembas/steer", { sessionId: sid, text: "and say hello", messageId: "web-2" })).toEqual({ queued: 1 })
  expect(await until(() => ended(m.turnId))).toBe(true)
  // Taken in at the turn's next step, inside the turn: before its end, and no turn of its own.
  const steered = events.findIndex((e) => e.type === "steered")
  expect(events[steered]).toMatchObject({ texts: ["and say hello"], ids: ["web-2"] })
  expect(steered).toBeLessThan(events.findIndex((e) => e.type === "task" && e.state === "end" && e.turnId === m.turnId))
  expect(fake!.requests).toHaveLength(4)
  expect(String(fake!.requests[3].messages.at(-1).content)).toContain("and say hello")
  expect(order(events).filter((l) => l.startsWith("prompt"))).toEqual(["prompt 1", "prompt 2 machine"])
  // The turn's end hands nothing back: the message was taken in.
  expect(events.find((e) => e.type === "task" && e.state === "end" && e.turnId === m.turnId).unsent).toBeUndefined()
}, SLOW)

test("Stop stops a wake turn; a message it had not taken in comes back on the turn's end", async () => {
  const { c, events, sid, status, machine, ended, release } = await client([...background("f1"), slow("Never finished.", 5000)])
  await go(c, sid)
  release("f1")
  expect(await until(() => machine().length === 1)).toBe(true)
  const m = machine()[0]
  await c.request("_lembas/steer", { sessionId: sid, text: "one more thing" })
  c.notify("session/cancel", { sessionId: sid })
  expect(await until(() => ended(m.turnId), 3000)).toBe(true)
  expect(events.some((e) => e.type === "done" && e.reason === "cancelled")).toBe(true)
  expect(events.find((e) => e.type === "task" && e.state === "end" && e.turnId === m.turnId)).toEqual({ type: "task", state: "end", turnId: m.turnId, unsent: ["one more thing"] })
  expect((await status()).busy).toBe(false)
  // Nothing is left to steer into: said in words.
  expect(await said(c.request("_lembas/steer", { sessionId: sid, text: "anyone?" }))).toBe("-32602 this session is not working on anything; send it as a prompt")
}, SLOW)

test("a prompt that arrives during a wake turn waits for it: queued in status, run after the turn's end, never beside it", async () => {
  const { c, events, sid, status, machine, ended, release } = await client([...background("f1"), slow("Seen the end."), { chunks: [delta({ content: "Second answer." })] }])
  await go(c, sid, "go", "web-1")
  release("f1")
  expect(await until(() => machine().length === 1)).toBe(true)
  const m = machine()[0]
  const second = go(c, sid, "and now this", "web-2")
  await Bun.sleep(100)
  expect(await status()).toMatchObject({ busy: true, turnId: m.turnId, queued: ["web-2"] })
  expect(ended(m.turnId)).toBe(false)
  // Neither compacted nor rewound under a turn that runs, whoever started it.
  expect(await said(c.request("_lembas/session/compact", { sessionId: sid }))).toBe("-32602 this session is working — compact it when the reply is done")
  expect(await said(c.request("_lembas/session/rewind", { sessionId: sid, turnId: "web-1" }))).toBe("-32602 this session is working — rewind it when the reply is done")
  expect(await second).toMatchObject({ stopReason: "end_turn", _meta: { lembas: { turnId: "web-2" } } })
  expect(order(events)).toEqual([
    "start 1", "prompt 1", "text Started.", "end 1",
    "start 2", "prompt 2 machine", "text Seen the end.", "end 2",
    "start 3", "prompt 3", "text Second answer.", "end 3",
  ])
  expect((await status()).lastTurnId).toBe("web-2")
}, SLOW)

test("two notes one after the other: two turns, each prompt followed by its own events and its own end before the next begins", async () => {
  const { c, events, sid, machine, ended, release } = await client([...background("f1", "f2"), { chunks: [delta({ content: "First seen." })] }, { chunks: [delta({ content: "Second seen." })] }])
  await go(c, sid)
  release("f1")
  expect(await until(() => machine().length === 1 && ended(machine()[0].turnId))).toBe(true)
  release("f2")
  expect(await until(() => machine().length === 2 && ended(machine()[1].turnId))).toBe(true)
  const [m1, m2] = machine()
  expect(m1.turnId).not.toBe(m2.turnId)
  expect(m1.text).toStartWith(`⏎ job1 (${waitFor("f1")})`)
  expect(m2.text).toStartWith(`⏎ job2 (${waitFor("f2")})`)
  expect(order(events)).toEqual([
    "start 1", "prompt 1", "text Started.", "end 1",
    "start 2", "prompt 2 machine", "text First seen.", "end 2",
    "start 3", "prompt 3 machine", "text Second seen.", "end 3",
  ])
  // Each note is said (`job_note`) before the turn it starts.
  const notes = events.filter((e) => e.type === "job_note")
  expect(notes.map((n) => n.jobId)).toEqual(["job1", "job2"])
  expect(events.indexOf(notes[1])).toBeGreaterThan(events.findIndex((e) => e.type === "task" && e.state === "end" && e.turnId === m1.turnId))
  expect(events.indexOf(notes[1])).toBeLessThan(events.findIndex((e) => e.type === "task" && e.state === "start" && e.turnId === m2.turnId))
  const h: any = await c.request("_lembas/session/history", { sessionId: sid })
  expect(h.turns.filter((t: any) => t.machine).map((t: any) => t.turnId)).toEqual([m1.turnId, m2.turnId])
}, SLOW)

test("a second note that arrives while the first one's turn runs joins that turn: one prompt, one end", async () => {
  const { c, events, sid, machine, release } = await client([...background("f1", "f2"), slow("First seen.", 3000), { chunks: [delta({ content: "Both seen." })] }])
  await go(c, sid)
  release("f1")
  expect(await until(() => machine().length === 1)).toBe(true)
  release("f2")
  expect(await until(() => fake!.requests.length === 4 && events.filter((e) => e.type === "task" && e.state === "end").length === 2)).toBe(true)
  await Bun.sleep(200)
  expect(machine()).toHaveLength(1)
  expect(order(events)).toEqual(["start 1", "prompt 1", "text Started.", "end 1", "start 2", "prompt 2 machine", "text First seen.", "text Both seen.", "end 2"])
  expect(events.filter((e) => e.type === "job_note").map((n) => n.jobId)).toEqual(["job1", "job2"])
  // The second note went to the model inside the turn, under its mark.
  expect(String(fake!.requests[3].messages.at(-1).content)).toStartWith(`${MARKS.command}\njob2 `)
}, SLOW)
