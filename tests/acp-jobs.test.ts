// The `jobs` capability over ACP (harness/acp.md, spec 2.0.0): the capability is listed; the
// `job` and `job_note` events and a note's `machine` prompt are forwarded; `_lembas/jobs`,
// `_lembas/job/output`, `/stop`, `/send`, `/transcript` answer as the spec says, with -32602 where it
// says; `jobs` rides on `_lembas/session/status`.
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AcpAgent } from "../src/acp/agent.ts"
import { Peer, RpcError, type Transport } from "../src/acp/rpc.ts"
import { paths } from "../src/config/paths.ts"
import { MARKS } from "../src/jobs/note.ts"
import { setTrust } from "../src/project/root.ts"
import { delta, fakeProvider, toolCall, type Fake } from "./fake-provider.ts"

let fake: Fake | undefined
let other: Fake | undefined
afterEach(() => {
  fake?.stop()
  other?.stop()
  other = undefined
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

/** The parent's model on `f`; a second connection `g` for a subagent's model, when given. */
function config(url: string, childUrl?: string) {
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(
    join(paths.config, "connections.yaml"),
    `connections:\n  f:\n    dialect: openai-chat\n    base_url: ${url}\n    models: { m: {} }\n${childUrl ? `  g:\n    dialect: openai-chat\n    base_url: ${childUrl}\n    models: { m: {} }\n` : ""}`,
    { mode: 0o600 },
  )
  writeFileSync(join(paths.config, "config.yaml"), "model: f/m\nmode: auto\n")
}

function project(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ph-acp-jobs-")))
  setTrust(dir, "trusted")
  writeFileSync(join(dir, "calc.py"), "def average(v):\n    return sum(v) / (len(v) - 1)\n")
  return dir
}

async function client(open = true) {
  const [ta, tb] = pair()
  new AcpAgent(new Peer(ta))
  const c = new Peer(tb)
  const events: any[] = []
  c.on("_lembas/event", (p) => void events.push(p.event))
  c.handle("session/request_permission", () => ({ outcome: { outcome: "selected", optionId: "once" } }))
  const init: any = await c.request("initialize", { protocolVersion: 1, clientCapabilities: { _meta: { lembas: { protocol: 2 } } } })
  const s: any = open ? await c.request("session/new", { cwd: project(), mcpServers: [] }) : {}
  return { c, events, init, sid: s.sessionId as string }
}

// Bun's per-test timeout is 5 s (bunfig's `[test] timeout` is not read by bun 1.4.2); a session, a
// prompt and a process take longer on a small machine.
const SLOW = 20_000

const code = (p: Promise<unknown>) => p.then(() => undefined, (e) => (e instanceof RpcError ? e.code : e))
const until = async (ok: () => boolean, ms = 6000) => {
  const end = Date.now() + ms
  while (Date.now() < end && !ok()) await Bun.sleep(20)
  return ok()
}

test("initialize lists the jobs capability", async () => {
  fake = fakeProvider([])
  config(fake.url)
  const { init } = await client(false)
  expect(init._meta.lembas.capabilities).toContain("jobs")
}, SLOW)

test("a background command: listed, read from `since`, in status; its events and its note's machine turn are forwarded", async () => {
  fake = fakeProvider([
    { chunks: [toolCall(0, "t1", "bash", JSON.stringify({ command: "echo out; sleep 2; echo later", background: true, description: "later" }))] },
    { chunks: [delta({ content: "Started it." })] },
    { chunks: [delta({ content: "Seen the end." })] },
  ])
  config(fake.url)
  const { c, events, sid } = await client()
  await c.request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "go" }] })
  const listed: any = await c.request("_lembas/jobs", { sessionId: sid })
  expect(listed.jobs).toHaveLength(1)
  expect(listed.jobs[0]).toMatchObject({ id: "job1", kind: "command", state: "running", description: "later", command: "echo out; sleep 2; echo later" })
  expect(typeof listed.jobs[0].started).toBe("number")
  const out: any = await c.request("_lembas/job/output", { sessionId: sid, id: "job1" })
  expect(out.text).toBe("out\n")
  expect(out).toMatchObject({ length: 4, state: "running" })
  // Reading here moves no mark of the model's (the start result had already handed it "out").
  expect((await c.request<any>("_lembas/jobs", { sessionId: sid })).jobs[0].unread).toBe(listed.jobs[0].unread)
  const status: any = await c.request("_lembas/session/status", { sessionId: sid })
  expect(status.held).toBe("here")
  expect(status.jobs).toHaveLength(1)
  expect(status.jobs[0]).toMatchObject({ id: "job1", state: "running" })
  // The end: a `job` end event, the note given as a `job_note`, and the turn it starts marked machine.
  expect(await until(() => events.some((e) => e.type === "prompt" && e.machine === true))).toBe(true)
  const machine = events.find((e) => e.type === "prompt" && e.machine)
  expect(machine.text).toStartWith("⏎ job1 (echo out; sleep 2; echo later) exited with 0")
  expect(events.some((e) => e.type === "job" && e.state === "start" && e.job.id === "job1")).toBe(true)
  expect(events.some((e) => e.type === "job" && e.state === "end" && e.job.id === "job1" && e.job.state === "done" && e.job.exit === 0)).toBe(true)
  const note = events.find((e) => e.type === "job_note")
  expect(note).toMatchObject({ jobId: "job1" })
  expect(note.text).toStartWith(MARKS.command)
  expect(note.text).toContain("later")
  await until(() => fake!.requests.length >= 3)
  const later: any = await c.request("_lembas/job/output", { sessionId: sid, id: "job1", since: out.length })
  expect(later).toMatchObject({ text: "later\n", length: 10, state: "done" })
  expect((await c.request<any>("_lembas/jobs", { sessionId: sid })).jobs[0]).toMatchObject({ id: "job1", state: "done", exit: 0 })
}, SLOW)

test("job/stop stops a command and answers once it has; the -32602 cases: a command sent to or transcribed, an id the session lacks", async () => {
  fake = fakeProvider([
    { chunks: [toolCall(0, "t1", "bash", JSON.stringify({ command: "sleep 30", background: true, description: "a server" }))] },
    { chunks: [delta({ content: "Running." })] },
    { chunks: [delta({ content: "Noted the stop." })] },
  ])
  config(fake.url)
  const { c, events, sid } = await client()
  await c.request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "go" }] })
  expect(await c.request<any>("_lembas/job/stop", { sessionId: sid, id: "job1" })).toEqual({ state: "stopped" })
  // Again: the state it already had.
  expect(await c.request<any>("_lembas/job/stop", { sessionId: sid, id: "job1" })).toEqual({ state: "stopped" })
  // The person's stop is told to the model as any end is.
  expect(await until(() => events.some((e) => e.type === "job_note" && e.jobId === "job1"))).toBe(true)
  expect(events.find((e) => e.type === "job_note").text).toContain("stopped (SIGTERM)")
  expect(await code(c.request("_lembas/job/send", { sessionId: sid, id: "job1", text: "hello" }))).toBe(-32602)
  expect(await code(c.request("_lembas/job/transcript", { sessionId: sid, id: "job1" }))).toBe(-32602)
  expect(await code(c.request("_lembas/job/output", { sessionId: sid, id: "job9" }))).toBe(-32602)
  expect(await code(c.request("_lembas/job/stop", { sessionId: sid, id: "job9" }))).toBe(-32602)
  expect(await code(c.request("_lembas/job/send", { sessionId: sid, id: "job9", text: "x" }))).toBe(-32602)
  expect(await code(c.request("_lembas/job/transcript", { sessionId: sid, id: "job9" }))).toBe(-32602)
  await until(() => fake!.requests.length >= 3)
}, SLOW)

test("a background subagent: its transcript as history turns; send to a finished one starts it again under the same id", async () => {
  fake = fakeProvider([
    { chunks: [toolCall(0, "t1", "task", JSON.stringify({ description: "find the bug", prompt: "Find why average is wrong", model: "g/m", background: true }))] },
    { chunks: [delta({ content: "Started it." })] },
    { chunks: [delta({ content: "Got the report." })] },
    { chunks: [delta({ content: "Got the second report." })] },
  ])
  other = fakeProvider([{ chunks: [delta({ content: "calc.py:2 divides by len(v) - 1." })] }, { chunks: [delta({ content: "The tests cover it." })] }])
  config(fake.url, other.url)
  const { c, events, sid } = await client()
  await c.request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "go" }] })
  expect(await until(() => events.some((e) => e.type === "job" && e.state === "end"))).toBe(true)
  const listed: any = await c.request("_lembas/jobs", { sessionId: sid })
  expect(listed.jobs[0]).toMatchObject({ id: "job1", kind: "subagent", state: "done", agent: "explore", description: "find the bug", model: "g/m" })
  const tr: any = await c.request("_lembas/job/transcript", { sessionId: sid, id: "job1" })
  expect(tr.id).toBe("job1")
  expect(tr.turns).toEqual([
    { role: "user", text: "Find why average is wrong" },
    { role: "assistant", text: "calc.py:2 divides by len(v) - 1.", reasoning: "", tools: [] },
  ])
  // Its progress as the model would read it: what it wrote.
  expect((await c.request<any>("_lembas/job/output", { sessionId: sid, id: "job1" })).text).toContain("calc.py:2 divides")
  await until(() => fake!.requests.length >= 3)
  // Finished: the message starts it again, a new `job` start event follows, and the transcript grows.
  const starts = () => events.filter((e) => e.type === "job" && e.state === "start").length
  expect(await c.request<any>("_lembas/job/send", { sessionId: sid, id: "job1", text: "Do the tests cover it?" })).toEqual({ state: "running" })
  expect(await until(() => starts() === 2)).toBe(true)
  expect(await until(() => events.filter((e) => e.type === "job" && e.state === "end").length === 2)).toBe(true)
  const again: any = await c.request("_lembas/job/transcript", { sessionId: sid, id: "job1" })
  expect(again.turns.map((t: any) => t.text)).toEqual(["Find why average is wrong", "calc.py:2 divides by len(v) - 1.", "Do the tests cover it?", "The tests cover it."])
  expect(await code(c.request("_lembas/job/send", { sessionId: sid, id: "job1", text: "" }))).toBe(-32602)
  await until(() => fake!.requests.length >= 4)
  expect(fake!.requests[3].messages.at(-1).content).toContain("The tests cover it.")
}, SLOW)
