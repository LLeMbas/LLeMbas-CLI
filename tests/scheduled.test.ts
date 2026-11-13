// Scheduled work on a linked computer (harness spec 3.5.0, acp.md): Accept scheduled work, a
// scheduled turn's mode, approvals that wait the schedule's wait, the run's outcome in the answer,
// and `_lembas/monitor`. A fake LLeMbas is the client; the model is a scripted endpoint.
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AcpAgent, type Limits } from "../src/acp/agent.ts"
import { Peer, type Transport } from "../src/acp/rpc.ts"
import { approvalWait, deniedText, monitorHash, runMonitor, SCHEDULED } from "../src/acp/scheduled.ts"
import { paths } from "../src/config/paths.ts"
import { remoteState } from "../src/config/remote.ts"
import { setTrust } from "../src/project/root.ts"
import { remoteCommand } from "../src/remote.ts"
import { TOOL_SPECS } from "../src/harness.ts"
import { delta, fakeProvider, toolCall, type Fake } from "./fake-provider.ts"

let fake: Fake | undefined
afterEach(() => fake?.stop())

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
  writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  f:\n    type: webui\n    url: ${url}\n    models: { f/m: {} }\n`, { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), "model: f/m\n")
}

function project(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ph-sched-")))
  Bun.spawnSync(["git", "init", "-q", dir])
  setTrust(dir, "trusted")
  return dir
}

const limitsFor = (root: string, extra: Partial<Limits> = {}): Limits => ({ roots: [root], maxMode: "auto", approvalTimeoutMs: 3000, requireTrust: true, enabled: true, scheduled: true, ...extra })

async function client(limits: Limits, answer?: (p: any) => unknown) {
  const [ta, tb] = pair()
  new AcpAgent(new Peer(ta), limits)
  const c = new Peer(tb)
  const asked: any[] = []
  const settled: any[] = []
  c.on("_lembas/permission/settled", (p) => void settled.push(p))
  c.on("_lembas/event", () => {})
  c.handle("session/request_permission", (p) => (asked.push(p), answer ? answer(p) : { outcome: { outcome: "selected", optionId: "once" } }))
  const init: any = await c.request("initialize", { protocolVersion: 1, clientCapabilities: { _meta: { lembas: { protocol: 3 } } } })
  return { c, init, asked, settled }
}

const sched = (extra: Record<string, unknown> = {}) => ({ schedule_id: "sched1", run_id: "run7", title: "Check", ...extra })

test("capability scheduled and limits.scheduled in initialize", async () => {
  fake = fakeProvider([])
  config(fake.url)
  const root = project()
  const on = await client(limitsFor(root))
  expect(on.init._meta.lembas.capabilities).toContain("scheduled")
  expect(on.init._meta.lembas.limits.scheduled).toBe(true)
  const off = await client(limitsFor(root, { scheduled: false }))
  expect(off.init._meta.lembas.capabilities).toContain("scheduled")
  expect(off.init._meta.lembas.limits.scheduled).toBe(false)
})

test("off: a scheduled session, prompt and monitor are refused with the fixed text and data.reason", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "hi" })] }])
  config(fake.url)
  const root = project()
  const { c } = await client(limitsFor(root, { scheduled: false }))
  const err: any = await c.request("session/new", { cwd: root, _meta: { lembas: { scheduled: sched() } } }).catch((e: any) => e)
  expect(err.message).toBe(SCHEDULED.texts.off)
  expect(err.data).toEqual({ reason: "scheduled_off" })
  const m: any = await c.request("_lembas/monitor", { cwd: root, command: "true" }).catch((e: any) => e)
  expect(m.data).toEqual({ reason: "scheduled_off" })
  // An ordinary agent chat is not affected.
  const s: any = await c.request("session/new", { cwd: root })
  const p: any = await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "go" }], _meta: { lembas: { scheduled: sched() } } }).catch((e: any) => e)
  expect(p.data).toEqual({ reason: "scheduled_off" })
})

test("the mode: Edit when none chosen, Auto only when the schedule says it, Plan refused, _meta.mode ignored", async () => {
  fake = fakeProvider([])
  config(fake.url)
  const root = project()
  const { c } = await client(limitsFor(root))
  const none: any = await c.request("session/new", { cwd: root, _meta: { mode: "auto", lembas: { scheduled: sched() } } })
  expect(none.modes.currentModeId).toBe("edit")
  const auto: any = await c.request("session/new", { cwd: root, _meta: { lembas: { scheduled: sched({ mode: "auto" }) } } })
  expect(auto.modes.currentModeId).toBe("auto")
  const plan: any = await c.request("session/new", { cwd: root, _meta: { lembas: { scheduled: sched({ mode: "plan" }) } } }).catch((e: any) => e)
  expect(plan.message).toBe(SCHEDULED.texts.plan)
  const { c: c2 } = await client(limitsFor(root, { maxMode: "manual" }))
  const low: any = await c2.request("session/new", { cwd: root, _meta: { lembas: { scheduled: sched({ mode: "auto" }) } } })
  expect(low.modes.currentModeId).toBe("manual")
  // A folder outside the roots: the usual reason, marked.
  const out: any = await c.request("session/new", { cwd: tmpdir(), _meta: { lembas: { scheduled: sched() } } }).catch((e: any) => e)
  expect(out.data).toEqual({ reason: "folder" })
})

test("a scheduled turn reports ok, silent, and the final reply", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "All the waybread is wrapped." })] }, { chunks: [delta({ content: "Nothing new.\n[silent]." })] }])
  config(fake.url)
  const root = project()
  const { c } = await client(limitsFor(root))
  const s: any = await c.request("session/new", { cwd: root, _meta: { lembas: { scheduled: sched() } } })
  const r1: any = await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "check" }], _meta: { lembas: { turnId: "run7", scheduled: sched() } } })
  expect(r1._meta.lembas.scheduled).toEqual({ run_id: "run7", status: "ok", text: "All the waybread is wrapped.", error: null })
  const r2: any = await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "check" }], _meta: { lembas: { turnId: "run8", scheduled: sched({ run_id: "run8" }) } } })
  expect(r2._meta.lembas.scheduled.status).toBe("silent")
  expect(r2._meta.lembas.scheduled.run_id).toBe("run8")
  // Sent again after a dropped link: the run's answer, not a second run.
  const again: any = await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "check" }], _meta: { lembas: { turnId: "run7", scheduled: sched() } } })
  expect(again._meta.lembas.scheduled.text).toBe("All the waybread is wrapped.")
})

test("approvals in a scheduled turn carry `scheduled` and the schedule's wait; unanswered, the model reads the fixed text", async () => {
  fake = fakeProvider([{ chunks: [toolCall(0, "b1", "bash", JSON.stringify({ command: "rm -rf build" }))] }, { chunks: [delta({ content: "could not clean" })] }])
  config(fake.url)
  const root = project()
  const { c, asked } = await client(limitsFor(root), () => ({ outcome: { outcome: "selected", optionId: "deny" } }))
  const s: any = await c.request("session/new", { cwd: root, _meta: { lembas: { scheduled: sched({ mode: "edit" }) } } })
  const r: any = await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "clean" }], _meta: { lembas: { turnId: "run9", scheduled: sched({ run_id: "run9", approval_wait_s: 90 }) } } })
  expect(asked[0]._meta.lembas.scheduled).toEqual({ schedule_id: "sched1", run_id: "run9", wait_s: 90 })
  expect(asked[0]._meta.lembas.patient).toBeUndefined()
  expect(r._meta.lembas.scheduled.status).toBe("ok")
  expect(deniedText(30 * 60_000)).toBe("Nobody answered this approval within 30 minutes, so it counts as denied.")
  expect(approvalWait(undefined)).toBe(1800)
})

test("ask_user in a scheduled turn: nobody to ask", async () => {
  const ASK = JSON.stringify({ questions: [{ header: "DB", question: "Which?", options: [{ label: "A" }, { label: "B" }] }] })
  fake = fakeProvider([{ chunks: [toolCall(0, "q1", "ask_user", ASK)] }, { chunks: [delta({ content: "assumed A" })] }])
  config(fake.url)
  const root = project()
  const { c } = await client(limitsFor(root))
  let questioned = false
  c.handle("_lembas/question", () => ((questioned = true), { outcome: "dismissed" }))
  const s: any = await c.request("session/new", { cwd: root, _meta: { lembas: { scheduled: sched() } } })
  const r: any = await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "pick" }], _meta: { lembas: { turnId: "r1", scheduled: sched() } } })
  expect(questioned).toBe(false)
  expect(r._meta.lembas.scheduled.text).toBe("assumed A")
})

test("_lembas/monitor: runs what the mode allows, refuses what it would ask about, hashes the output", async () => {
  fake = fakeProvider([])
  config(fake.url)
  const root = project()
  writeFileSync(join(root, "feed.txt"), "one\n")
  const { c } = await client(limitsFor(root))
  const r: any = await c.request("_lembas/monitor", { cwd: root, command: "cat feed.txt", mode: "edit" })
  expect(r).toMatchObject({ exit: 0, timed_out: false, excerpt: "one\n", truncated: false, bytes: 4 })
  expect(r.hash).toBe(monitorHash(0, "one\n"))
  const asks: any = await c.request("_lembas/monitor", { cwd: root, command: "rm -rf build", mode: "edit" }).catch((e: any) => e)
  expect(asks.data).toEqual({ reason: "permission" })
  expect(asks.message).toContain("edit mode")
  const plan: any = await c.request("_lembas/monitor", { cwd: root, command: "cat feed.txt", mode: "plan" }).catch((e: any) => e)
  expect(plan.data).toEqual({ reason: "plan" })
})

test("runMonitor: a timeout stops the group and has no hash; a long output is hashed whole", async () => {
  const root = project()
  const slow = await runMonitor("echo start; sleep 5", root, 1)
  expect(slow).toMatchObject({ hash: null, exit: null, timed_out: true })
  expect(slow.excerpt).toBe("start\n")
  const big = await runMonitor(`head -c ${SCHEDULED.monitor.output_max_bytes + 10} /dev/zero`, root, 10)
  expect(big.bytes).toBe(SCHEDULED.monitor.output_max_bytes + 10)
  expect(big.hash).toBe(monitorHash(0, new Uint8Array(SCHEDULED.monitor.output_max_bytes + 10)))
  expect(big.truncated).toBe(true)
}, 20_000)

test("lembas remote scheduled on|off writes remote.scheduled, and --json says it", () => {
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(join(paths.config, "config.yaml"), "remote:\n  enabled: true\n")
  const out: string[] = []
  expect(remoteCommand(["scheduled", "on", "--json"], { out: (l) => out.push(l), err: () => {} })).toBe(0)
  expect(JSON.parse(out.at(-1)!).scheduled).toBe(true)
  expect(remoteState().scheduled).toBe(true)
  expect(remoteCommand(["scheduled", "off"], { out: () => {}, err: () => {} })).toBe(0)
  expect(remoteState().scheduled).toBe(false)
  expect(remoteCommand(["scheduled", "maybe"], { out: () => {}, err: () => {} })).toBe(2)
})

// ---- Reports (harness spec 3.8.0, reports.md) ----

/** A tool result without the id every result carries (context.md). */
const bare = (text: string) => text.replace(/^\[#\d+\]\n/, "")
const toolNames = (i: number) => ((fake!.requests[i].tools ?? []) as { function: { name: string } }[]).map((t) => t.function.name)
const R = (extra: Record<string, unknown> = {}) => JSON.stringify({ title: "Disk almost full", body: "## What\n\n`/var` is at 94%.", summary: "The log partition is at 94%.", importance: "high", ...extra })

test("capability reports; a run that notifies is offered report_write, and the report it writes travels in the answer", async () => {
  fake = fakeProvider([{ chunks: [toolCall(0, "c1", "report_write", R())] }, { chunks: [delta({ content: "Filed a report: the disk is almost full." })] }])
  config(fake.url)
  const root = project()
  const { c, init, asked } = await client(limitsFor(root))
  expect(init._meta.lembas.capabilities).toContain("reports")
  const meta = { lembas: { scheduled: sched({ notify: "when" }) } }
  const s: any = await c.request("session/new", { cwd: root, _meta: meta })
  const r: any = await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "check the disks" }], _meta: { lembas: { turnId: "run7", ...meta.lembas } } })
  expect(toolNames(0)).toContain("report_write")
  // Allowed without asking: it writes nothing here.
  expect(asked).toEqual([])
  expect(r._meta.lembas.scheduled).toEqual({
    run_id: "run7",
    status: "ok",
    text: "Filed a report: the disk is almost full.",
    error: null,
    report: { title: "Disk almost full", body: "## What\n\n`/var` is at 94%.", summary: "The log partition is at 94%.", importance: "high" },
  })
  // The model was told the report is filed and to end with one line.
  expect(bare(fake.requests[1].messages.at(-1).content)).toBe(SCHEDULED.notify.result.filed)
})

test("one report per run: a second call replaces the first; the next run starts with none; the sentinel is no status any more", async () => {
  fake = fakeProvider([
    { chunks: [toolCall(0, "c1", "report_write", R()), toolCall(1, "c2", "report_write", R({ title: "Disk fine again", importance: undefined }))] },
    { chunks: [delta({ content: "Done." })] },
    { chunks: [delta({ content: "Nothing needs attention.\n[SILENT]" })] },
  ])
  config(fake.url)
  const root = project()
  const { c } = await client(limitsFor(root))
  const meta = (run: string) => ({ lembas: { turnId: run, scheduled: sched({ run_id: run, notify: "always" }) } })
  const s: any = await c.request("session/new", { cwd: root, _meta: meta("run7") })
  const r1: any = await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "check" }], _meta: meta("run7") })
  expect(r1._meta.lembas.scheduled.report).toMatchObject({ title: "Disk fine again", importance: "normal" })
  const results = (fake.requests[1].messages as { role: string; content: string }[]).filter((m) => m.role === "tool").map((m) => bare(m.content))
  expect(results).toEqual([SCHEDULED.notify.result.filed, SCHEDULED.notify.result.replaced])
  // The schedule's next run, in the same session: no report of its own, so none in its answer —
  // and `silent` is not a status for a turn whose request said notify.
  const r2: any = await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "check" }], _meta: meta("run8") })
  expect(r2._meta.lembas.scheduled.report).toBeUndefined()
  expect(r2._meta.lembas.scheduled.status).toBe("ok")
})

test("notify never, and a server that says no notify at all: the tool is not in the list; the person's own turn in a run's session finds it unavailable", async () => {
  fake = fakeProvider([
    { chunks: [delta({ content: "ok" })] },
    { chunks: [delta({ content: "ok" })] },
    { chunks: [delta({ content: "run" })] },
    { chunks: [toolCall(0, "c9", "report_write", R())] },
    { chunks: [delta({ content: "I cannot file one here." })] },
  ])
  config(fake.url)
  const root = project()
  const { c } = await client(limitsFor(root))
  const run = async (scheduled: Record<string, unknown>, id: string) => {
    const s: any = await c.request("session/new", { cwd: root, _meta: { lembas: { scheduled } } })
    const r: any = await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "check" }], _meta: { lembas: { turnId: id, scheduled } } })
    return { s, r }
  }
  await run(sched({ notify: "never" }), "a")
  expect(toolNames(0)).not.toContain("report_write")
  // A server before 3.8.0 sends no notify: as before, and the tool is not offered.
  await run(sched(), "b")
  expect(toolNames(1)).not.toContain("report_write")
  // A run that notifies, then the person writes into its session: the list is the session's,
  // and the tool answers the spec's unavailable text.
  const { s } = await run(sched({ notify: "always" }), "c")
  expect(toolNames(2)).toContain("report_write")
  const mine: any = await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "and file that for me" }] })
  expect(toolNames(3)).toContain("report_write")
  expect(bare(fake.requests[4].messages.at(-1).content)).toBe(TOOL_SPECS.report_write!.unavailable!)
  expect(mine._meta.lembas.scheduled).toBeUndefined()
})
