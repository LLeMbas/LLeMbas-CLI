// What a session still has out after its turn's reply (harness/acp.md: *A turn the harness starts*,
// *Scheduled work on a linked computer*; spec 3.10.0): subagents that work, background jobs, a
// note or a steered message that has not reached the model. None of it is lost — not to a terminal
// opening the session, not to the service starting again, not to Stop, and not to a restart — and
// a schedule's run is not over while its subagents work.
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AcpAgent, type Limits } from "../src/acp/agent.ts"
import { Hub } from "../src/acp/hub.ts"
import { Peer, type Transport } from "../src/acp/rpc.ts"
import { releaseForResume } from "../src/acp/share.ts"
import { createApp, type App } from "../src/app.ts"
import type { AskReply } from "../src/bus/index.ts"
import { paths } from "../src/config/paths.ts"
import { LOOP } from "../src/harness.ts"
import { MARKS } from "../src/jobs/note.ts"
import { setTrust } from "../src/project/root.ts"
import { delta, fakeProvider, toolCall, type Fake, type Scripted } from "./fake-provider.ts"

let fake: Fake | undefined
const stops: (() => unknown)[] = []
const roots: string[] = []
afterEach(async () => {
  // Whatever a test left waiting for its flag ends now: no loop outlives the test, pass or fail.
  for (const root of roots.splice(0)) for (const flag of ["f1", "f-api", "f-web"]) writeFileSync(join(root, flag), "")
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
const call = (id: string, name: string, args: unknown): Scripted => ({ chunks: [toolCall(0, id, name, JSON.stringify(args)), delta({}, "tool_calls")] })
/** A reply that stays open for `ms` after its first words: time to look at the turn while it runs. */
const slow = (text: string, ms = 2500): Scripted => ({ chunks: [delta({ content: "… " }), delta({ content: text })], gapMs: ms })
const system = (body: any): string => body.messages[0].content
const memberName = (body: any): string | undefined => /You are "([a-z0-9-]+)" \(s\d+\), a subagent/.exec(system(body))?.[1]
const users = (body: any): string => body.messages.filter((m: any) => m.role === "user").map((m: any) => (typeof m.content === "string" ? m.content : m.content.map((p: any) => p.text ?? "").join("\n"))).join("\n")
const leads = () => fake!.requests.filter((r) => !memberName(r))

/** The lead's script — its replies in order — and each member's by its name. A member that has
 *  said all it has says it is done. */
function scripted(lead: Scripted[], members: Record<string, Scripted[]> = {}) {
  const at: Record<string, number> = {}
  return (body: any): Scripted => {
    const who = memberName(body) ?? "lead"
    const list = who === "lead" ? lead : (members[who] ?? [])
    const n = (at[who] = (at[who] ?? -1) + 1)
    return list[n] ?? say(`${who} has nothing more.`)
  }
}

/** A command that ends when the test lets it (`release`): never before, however slow the machine. */
const waitFor = (flag: string) => `until [ -e ${flag} ]; do sleep 0.05; done`
const add = (name: string, id = `add-${name}`) => call(id, "team_add", { name, role: `the ${name}`, task: `Do the ${name}.`, goal: "a service" })
/** A member that works until its flag is there, then reports. */
const member = (name: string, report = `The ${name} is done.`): Scripted[] => [call(`w-${name}`, "bash", { command: waitFor(`f-${name}`) }), say(report)]

function setup(script: Scripted[] | ((body: any, n: number) => Scripted | undefined), o: { config?: string; model?: string; models?: string } = {}) {
  fake = fakeProvider(script)
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  f:\n    type: webui\n    url: ${fake.url}\n    models: ${o.models ?? "{ f/m: {} }"}\n`, { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), `model: ${o.model ?? "f/m"}\nmode: auto\n${o.config ?? ""}`)
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ph-out-")))
  Bun.spawnSync(["git", "init", "-q", dir])
  setTrust(dir, "trusted")
  roots.push(dir)
  return dir
}

const limitsFor = (root: string, extra: Partial<Limits> = {}): Limits => ({ roots: [root], maxMode: "auto", approvalTimeoutMs: 3000, requireTrust: true, enabled: true, scheduled: true, ...extra })

/** A fake LLeMbas on a link of its own — to `hub`'s sessions when there is one. */
async function link(root: string, hub?: Hub) {
  const [ta, tb] = pair()
  new AcpAgent(new Peer(ta), limitsFor(root), undefined, hub)
  const c = new Peer(tb)
  const events: any[] = []
  c.on("_lembas/event", (p) => void events.push(p.event))
  c.handle("session/request_permission", () => ({ outcome: { outcome: "selected", optionId: "once" } }))
  await c.request("initialize", { protocolVersion: 1, clientCapabilities: { _meta: { lembas: { protocol: 3 } } } })
  const machine = () => events.filter((e) => e.type === "prompt" && e.machine === true)
  const ended = (turnId: string) => events.some((e) => e.type === "task" && e.state === "end" && e.turnId === turnId)
  const texts = () => events.filter((e) => e.type === "text").map((e) => e.text).join("")
  return { c, events, machine, ended, texts, drop: () => tb.close() }
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
const go = (c: Peer, sid: string, text = "go", meta: Record<string, unknown> = {}) => c.request<any>("session/prompt", { sessionId: sid, prompt: [{ type: "text", text }], ...(Object.keys(meta).length ? { _meta: { lembas: meta } } : {}) })
const sched = (extra: Record<string, unknown> = {}) => ({ schedule_id: "sched1", run_id: "run7", title: "Check", mode: "auto", ...extra })
const waitingForSubagents = (events: any[]) => events.some((e) => e.type === "phase" && !e.agent && e.progress?.phase === "waiting_for_subagents")

// ── 1. A session with subagents or jobs out is not let go of ─────────────────────────────────

test("a subagent still works after the lead's turn: the service is busy, a terminal is refused in words, and the report still comes", async () => {
  const root = setup(scripted([add("api"), say("api is on it."), say("All done.")], { api: member("api") }))
  const hub = await service(root)
  const { c, machine, ended, texts } = await link(root, hub)
  const s: any = await c.request("session/new", { cwd: root, mcpServers: [] })
  const sid = s.sessionId as string
  expect((await go(c, sid)).stopReason).toBe("end_turn")
  // No turn runs — and the session is not idle: its subagent works.
  expect((await c.request<any>("_lembas/session/status", { sessionId: sid })).busy).toBe(false)
  expect(hub.busy()).toBe(true)
  const why = await releaseForResume(sid)
  expect(why).toContain("api")
  expect(why).toContain("subagent")
  // Nothing was stopped by the asking: the member reports, and the lead answers.
  writeFileSync(join(root, "f-api"), "")
  expect(await until(() => machine().length === 1 && ended(machine()[0].turnId))).toBe(true)
  expect(texts()).toContain("All done.")
  expect(users(leads().at(-1))).toContain("[Team report from api to lead:]\nThe api is done.")
  // Now it is idle, and a terminal may have it.
  expect(await until(() => !hub.busy())).toBe(true)
  expect(await releaseForResume(sid)).toBeUndefined()
  expect(hub.held.has(sid)).toBe(false)
}, SLOW)

test("a background command still runs after the turn: busy, and a terminal is told which job", async () => {
  const root = setup([call("j1", "bash", { command: waitFor("f1"), background: true, description: "wait for f1" }), say("Started."), say("Seen the end.")])
  const hub = await service(root)
  const { c, machine, ended } = await link(root, hub)
  const s: any = await c.request("session/new", { cwd: root, mcpServers: [] })
  const sid = s.sessionId as string
  await go(c, sid)
  expect(hub.busy()).toBe(true)
  const why = await releaseForResume(sid)
  expect(why).toContain("job1")
  expect(hub.held.has(sid)).toBe(true)
  writeFileSync(join(root, "f1"), "")
  expect(await until(() => machine().length === 1 && ended(machine()[0].turnId))).toBe(true)
  expect(await until(() => !hub.busy())).toBe(true)
  expect(await releaseForResume(sid)).toBeUndefined()
}, SLOW)

// ── 2. A schedule's run is not over while its subagents work ─────────────────────────────────

test("a scheduled run that uses a team: one turn, the answer and the report from its last reply — after the member reported", async () => {
  const report = { title: "The API", summary: "The API is written.", body: "## Done\n\nsrc/api.ts" }
  const root = setup(scripted([add("api"), say("api is on it."), call("r1", "report_write", report), say("Filed: the API is done.")], { api: member("api") }))
  const { c, events, machine } = await link(root)
  const meta = { scheduled: sched({ notify: "always" }) }
  const s: any = await c.request("session/new", { cwd: root, mcpServers: [], _meta: { lembas: meta } })
  const sid = s.sessionId as string
  let answered = false
  const run = go(c, sid, "check", { turnId: "run7", ...meta }).then((r) => ((answered = true), r))
  await until(() => answered || waitingForSubagents(events))
  // The lead's reply has ended and the member works: the run has not answered.
  expect(answered).toBe(false)
  expect(await c.request<any>("_lembas/session/status", { sessionId: sid })).toMatchObject({ busy: true, turnId: "run7" })
  writeFileSync(join(root, "f-api"), "")
  const r = await run
  expect(r.stopReason).toBe("end_turn")
  expect(r._meta.lembas.scheduled).toEqual({ run_id: "run7", status: "ok", text: "Filed: the API is done.", error: null, report: { ...report, importance: "normal" } })
  // One turn from start to end: the report came in at a step, not as a turn of its own.
  expect(events.filter((e) => e.type === "task").map((e) => `${e.state} ${e.turnId}`)).toEqual(["start run7", "end run7"])
  expect(machine()).toHaveLength(0)
  expect(users(leads()[2])).toContain("[Team report from api to lead:]\nThe api is done.")
  // A schedule's session is offered a team, and its run report_write.
  const tools = leads()[0].tools.map((t: any) => t.function.name)
  expect(tools).toEqual(expect.arrayContaining(["team_add", "report_write"]))
  // Nothing of the run is left working.
  const after = await c.request<any>("_lembas/session/status", { sessionId: sid })
  expect(after.busy).toBe(false)
  expect(after.tree.agents.filter((a: any) => a.state === "working" || a.state === "waiting").map((a: any) => a.name)).toEqual([])
}, SLOW)

test("a waiting run holds no slot: with two slots and two subagents both work at once, and each report comes into the one turn", async () => {
  const root = setup(scripted([add("api"), add("web"), say("Both are on it."), say("One is in."), say("Both are in.")], { api: member("api"), web: member("web") }), { models: "{ f/m: { parallel: 2 } }" })
  const { c, events, machine } = await link(root)
  const meta = { scheduled: sched() }
  const s: any = await c.request("session/new", { cwd: root, mcpServers: [], _meta: { lembas: meta } })
  const sid = s.sessionId as string
  let answered = false
  const run = go(c, sid, "check", { turnId: "run7", ...meta }).then((r) => ((answered = true), r))
  await until(() => answered || waitingForSubagents(events))
  expect(answered).toBe(false)
  // While the main agent's own turn ran, web waited for a slot; now it has the main agent's.
  const states = async () => Object.fromEntries((await c.request<any>("_lembas/session/status", { sessionId: sid })).tree.agents.map((a: any) => [a.name, a.state]))
  expect(await states()).toEqual({ lead: "idle", api: "working", web: "working" })
  writeFileSync(join(root, "f-api"), "")
  expect(await until(() => answered || leads().length === 4)).toBe(true)
  expect(answered).toBe(false)
  writeFileSync(join(root, "f-web"), "")
  const r = await run
  expect(r._meta.lembas.scheduled).toMatchObject({ status: "ok", text: "Both are in." })
  expect(events.filter((e) => e.type === "task").map((e) => `${e.state} ${e.turnId}`)).toEqual(["start run7", "end run7"])
  expect(machine()).toHaveLength(0)
  expect(users(leads()[3])).toContain("[Team report from api to lead:]")
  expect(users(leads()[4])).toContain("[Team report from web to lead:]")
  expect(await states()).toEqual({ lead: "idle", api: "finished", web: "finished" })
}, SLOW)

// ── 6. Stop ──────────────────────────────────────────────────────────────────────────────────

test("Stop on a scheduled run stops the run: the turn, and the subagent still working for it", async () => {
  const root = setup(scripted([add("api"), say("api is on it.")], { api: member("api") }))
  const { c, events, machine } = await link(root)
  const meta = { scheduled: sched() }
  const s: any = await c.request("session/new", { cwd: root, mcpServers: [], _meta: { lembas: meta } })
  const sid = s.sessionId as string
  let answered = false
  const run = go(c, sid, "check", { turnId: "run7", ...meta }).then((r) => ((answered = true), r))
  await until(() => answered || waitingForSubagents(events))
  expect(answered).toBe(false)
  c.notify("session/cancel", { sessionId: sid })
  const r = await run
  expect(r.stopReason).toBe("cancelled")
  expect(r._meta.lembas.scheduled.status).toBe("cancelled")
  // The member left with the run: stopped, and nothing of it starts a turn afterwards.
  const tree = (await c.request<any>("_lembas/session/status", { sessionId: sid })).tree
  expect(tree.agents.map((a: any) => a.name)).toEqual(["lead"])
  expect(tree.ended.map((a: any) => `${a.name} ${a.state}`)).toEqual(["api stopped"])
  const asked = fake!.requests.length
  writeFileSync(join(root, "f-api"), "")
  await Bun.sleep(300)
  expect(fake!.requests).toHaveLength(asked)
  expect(machine()).toHaveLength(0)
}, SLOW)

test("Stop in a chat stops the turn that runs and no subagent: the next report starts a turn as any does", async () => {
  const root = setup(scripted([add("api"), add("web"), say("Both are on it."), slow("Looking at the API.", 5000), say("And the web is in.")], { api: member("api"), web: member("web") }))
  const { c, events, machine, ended } = await link(root)
  const s: any = await c.request("session/new", { cwd: root, mcpServers: [] })
  const sid = s.sessionId as string
  await go(c, sid)
  writeFileSync(join(root, "f-api"), "")
  // Stopped once its reply has begun: the model was asked, so the next turn gets the next reply.
  expect(await until(() => machine().length === 1 && events.some((e) => e.type === "text" && e.text === "… "))).toBe(true)
  c.notify("session/cancel", { sessionId: sid })
  expect(await until(() => ended(machine()[0].turnId))).toBe(true)
  expect(events.some((e) => e.type === "done" && e.reason === "cancelled")).toBe(true)
  // web was not stopped with the lead's turn.
  const tree = (await c.request<any>("_lembas/session/status", { sessionId: sid })).tree
  expect(tree.agents.find((a: any) => a.name === "web").state).toBe("working")
  writeFileSync(join(root, "f-web"), "")
  expect(await until(() => machine().length === 2 && ended(machine()[1].turnId))).toBe(true)
  expect(machine()[1].text).toBe("⏎ [Team report from web to lead:]")
}, SLOW)

// ── 3. Stop while a wake turn waits for a model slot ─────────────────────────────────────────

test("Stop while a wake turn waits for a slot: its note stays in the history under the turn's id, and the model reads it next", async () => {
  const root = setup(
    scripted([call("j1", "bash", { command: waitFor("f1"), background: true, description: "wait for f1" }), add("api"), add("web"), say("Waiting."), say("All in.")], { api: member("api"), web: member("web") }),
    { models: "{ f/m: { parallel: 2 } }" },
  )
  const { c, events, machine, ended } = await link(root)
  const s: any = await c.request("session/new", { cwd: root, mcpServers: [] })
  const sid = s.sessionId as string
  await go(c, sid, "go", { turnId: "web-1" })
  // Both slots are the members'. The job ends: its note wakes the lead, which waits for a slot.
  writeFileSync(join(root, "f1"), "")
  expect(await until(() => machine().length === 1 && events.some((e) => e.type === "notice" && String(e.message).startsWith("waiting for a free slot")))).toBe(true)
  const m = machine()[0]
  c.notify("session/cancel", { sessionId: sid })
  expect(await until(() => ended(m.turnId))).toBe(true)
  // The client was told the turn began: the history has it, as it has any stopped turn.
  const h: any = await c.request("_lembas/session/history", { sessionId: sid })
  const note = h.turns.find((t: any) => t.turnId === m.turnId)
  expect(note).toBeDefined()
  expect(note.machine).toBe(true)
  expect(note.text).toStartWith(`${MARKS.command}\njob1 (${waitFor("f1")}) exited with 0`)
  // …and the model reads it with what comes next.
  writeFileSync(join(root, "f-api"), "")
  writeFileSync(join(root, "f-web"), "")
  expect(await until(() => leads().some((r) => users(r).includes("[Team report from")))).toBe(true)
  expect(users(leads().at(-1))).toContain(`job1 (${waitFor("f1")}) exited with 0`)
}, SLOW)

// ── 4, 7. A message steered into a turn the harness started ──────────────────────────────────

test("a steer a wake turn never took in comes back on the turn's end — said before the queue is said empty", async () => {
  const root = setup([call("j1", "bash", { command: waitFor("f1"), background: true, description: "wait for f1" }), say("Started."), slow("Never finished.", 5000)])
  const { c, events, machine, ended } = await link(root)
  const s: any = await c.request("session/new", { cwd: root, mcpServers: [] })
  const sid = s.sessionId as string
  await go(c, sid)
  writeFileSync(join(root, "f1"), "")
  expect(await until(() => machine().length === 1)).toBe(true)
  const m = machine()[0]
  await c.request("_lembas/steer", { sessionId: sid, text: "one more thing" })
  const steered = events.length
  c.notify("session/cancel", { sessionId: sid })
  expect(await until(() => ended(m.turnId), 3000)).toBe(true)
  await Bun.sleep(50)
  const end = events.findIndex((e) => e.type === "task" && e.state === "end" && e.turnId === m.turnId)
  expect(events[end].unsent).toEqual(["one more thing"])
  const emptied = events.findIndex((e, i) => i >= steered && e.type === "inbox" && e.texts.length === 0)
  expect(emptied === -1 || emptied > end).toBe(true)
}, SLOW)

test("a steer left over with no client listening is kept with the session — across a restart — and goes in at the next turn's first step, once", async () => {
  // busy_input: queue — the mode in which nothing went in at a step by itself.
  const root = setup([call("j1", "bash", { command: waitFor("f1"), background: true, description: "wait for f1" }), say("Started."), slow("Seen the end.", 1500), say("And that too.")], { config: "busy_input: queue\n" })
  const hub = await service(root)
  const first = await link(root, hub)
  const s: any = await first.c.request("session/new", { cwd: root, mcpServers: [] })
  const sid = s.sessionId as string
  await go(first.c, sid, "go", { turnId: "web-1" })
  writeFileSync(join(root, "f1"), "")
  expect(await until(() => first.machine().length === 1)).toBe(true)
  expect(await first.c.request<any>("_lembas/steer", { sessionId: sid, text: "and one more thing", messageId: "web-2" })).toEqual({ queued: 1 })
  // The link goes; the turn ends with nobody to hand the message back to.
  first.drop()
  const held = hub.held.get(sid)!
  expect(await until(() => held.own === undefined && !held.app.engine.busy)).toBe(true)
  // The device starts again: the session is opened from the store, by another process's agent.
  await held.app.close()
  hub.held.delete(sid)
  const again = await link(root)
  const r = await go(again.c, sid, "next", { turnId: "web-3" })
  expect(r.stopReason).toBe("end_turn")
  // In at the first step of the next turn, said with its id — and not handed back as well.
  expect(again.events.find((e) => e.type === "steered")).toMatchObject({ texts: ["and one more thing"], ids: ["web-2"] })
  expect(users(fake!.requests.at(-1))).toContain("and one more thing")
  expect(r._meta.lembas.unsent).toBeUndefined()
  // Once: the turn after it does not carry it again.
  const h: any = await again.c.request("_lembas/session/history", { sessionId: sid })
  expect(JSON.stringify(h.turns).split("and one more thing")).toHaveLength(2)
  // The harness's turn is still marked as one after the restart (the store keeps `machine`).
  expect(h.turns.filter((t: any) => t.machine).map((t: any) => t.turnId)).toEqual([first.machine()[0].turnId])
}, SLOW)

// ── 5. A wake that is refused leaves the lead idle, and the note waits ───────────────────────

test("a report that may not start a turn (a schedule's session on an interactive-only model): the lead is idle again, and the report goes in with the person's next message", async () => {
  const root = setup(scripted([add("api"), say("api is on it."), say("Here it is.")], { api: member("api") }), { model: "open/flash", models: "{ open/flash: {}, plan/coder: { interactive_only: true } }" })
  const yes = { ask: async (): Promise<AskReply> => ({ kind: "once" }) }
  const app: App = createApp({ cwd: root, asker: yes, snapshots: false, modelTitles: false, kind: "scheduled" })
  stops.push(() => app.close())
  const notices: string[] = []
  app.bus.on((e) => e.type === "notice" && notices.push(e.message))
  // The person writes into the run's chat, and the lead starts a subagent.
  await app.turns.prompt("build it")
  // Between turns the session's model is changed to the plan's.
  app.chooseModel("plan/coder")
  writeFileSync(join(root, "f-api"), "")
  expect(await until(() => notices.some((n) => n.includes("did not start a turn")))).toBe(true)
  expect(app.engine.busy).toBe(false)
  expect(app.team.team.get("lead")!.state).toBe("idle")
  // The person's next turn carries the report.
  await app.turns.prompt("and?")
  expect(users(leads().at(-1))).toContain("[Team report from api to lead:]\nThe api is done.")
  expect(LOOP.interactive.texts.scheduled).toContain("interactive use only")
}, SLOW)
