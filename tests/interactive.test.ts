// Interactive-only models (harness spec 3.9.0, interactive.md): the field as the server sends it,
// scheduled work that never runs on such a model, and a session's background calls — its title,
// its compaction — asked of another model. A fake LLeMbas is the client; the model is a scripted
// endpoint that records which model each request named.
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AcpAgent, type Limits } from "../src/acp/agent.ts"
import { Peer, type Transport } from "../src/acp/rpc.ts"
import { createApp, InteractiveOnlyError } from "../src/app.ts"
import { paths } from "../src/config/paths.ts"
import { LOOP } from "../src/harness.ts"
import { nobodyAtIt, RUN_HINT } from "../src/provider/interactive.ts"
import { specFor } from "../src/lembas/webui.ts"
import { setTrust } from "../src/project/root.ts"
import { rememberModel, lastModelFile } from "../src/session/lastmodel.ts"
import { delta, fakeProvider, toolCall, type Fake } from "./fake-provider.ts"

let fake: Fake | undefined
const closing: (() => unknown)[] = []
afterEach(async () => {
  for (const c of closing.splice(0)) await c()
  fake?.stop()
  rmSync(lastModelFile(), { force: true })
})

/** A plan's model, its pay-as-you-go twin, and one more — or without the twin. */
function config(url: string, o: { model?: string; twin?: boolean; other?: boolean; extra?: string; window?: number; twinWindow?: number; otherTools?: boolean } = {}) {
  mkdirSync(paths.config, { recursive: true })
  const models = [`plan/coder: { interactive_only: true${o.window ? `, context: ${o.window}` : ""} }`, "plan/max: { interactive_only: true }", ...(o.twin === false ? [] : [`payg/coder: {${o.twinWindow ? ` context: ${o.twinWindow} ` : ""}}`]), ...(o.other === false ? [] : [`open/flash: {${o.otherTools === false ? " tools: false " : ""}}`])]
  writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  f:\n    type: webui\n    url: ${url}\n    models:\n${models.map((m) => `      ${m}`).join("\n")}\n`, { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), `model: ${o.model ?? "plan/coder"}\n${o.extra ?? ""}`)
}

function project(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ph-interactive-")))
  Bun.spawnSync(["git", "init", "-q", dir])
  setTrust(dir, "trusted")
  return dir
}

const asker = { ask: async () => ({ action: "deny" as const }) } as never
function app(cwd: string, extra: Record<string, unknown> = {}) {
  const a = createApp({ cwd, asker, snapshots: false, ...extra })
  closing.push(() => a.close())
  return a
}
const reply = (text = "ok") => ({ chunks: [delta({ content: text })] })
const asked = () => fake!.requests.map((r) => r.model as string)
const SENTENCE = (model: string) => LOOP.interactive.texts.scheduled.replace("{{model}}", model)

test("the field: read from /v1/models only when the server says true", () => {
  expect(specFor({ id: "plan/coder", interactive_only: true }, "f").interactive_only).toBe(true)
  expect("interactive_only" in specFor({ id: "payg/coder" }, "f")).toBe(false)
  expect("interactive_only" in specFor({ id: "payg/coder", interactive_only: false }, "f")).toBe(false)
})

test("a person's turn runs on the interactive-only model; its title is asked of the twin", async () => {
  fake = fakeProvider([reply("Hello."), reply("A greeting")])
  config(fake.url)
  const a = app(project())
  const notices: string[] = []
  a.bus.on((e) => e.type === "notice" && notices.push(e.message))
  await a.turns.prompt("hello there")
  for (let i = 0; i < 100 && fake.requests.length < 2; i++) await Bun.sleep(10)
  expect(asked()).toEqual(["plan/coder", "payg/coder"])
  expect(notices.filter((n) => n.includes("title is asked of payg/coder"))).toHaveLength(1)
})

test("no twin: the title goes to the default that is not interactive-only; with none, it is not asked for at all", async () => {
  fake = fakeProvider([reply("Hello."), reply("A greeting")])
  // The session is on plan/max (asked for); the global setting is a model that may take it.
  config(fake.url, { model: "open/flash" })
  const a = app(project(), { model: "plan/max" })
  await a.turns.prompt("hello there")
  for (let i = 0; i < 100 && fake.requests.length < 2; i++) await Bun.sleep(10)
  expect(asked()).toEqual(["plan/max", "open/flash"])
  fake.stop()

  fake = fakeProvider([reply("Hello.")])
  config(fake.url, { twin: false, other: false })
  const root = project()
  const b = app(root)
  await b.turns.prompt("hello there")
  await Bun.sleep(150)
  expect(asked()).toEqual(["plan/coder"])
  // The name made from the first prompt stays.
  expect(b.store!.session(b.engine.sessionId!)!.title).toBe("hello there")
})

test("compaction the person asks for is the twin's work, and the session stays on its model", async () => {
  fake = fakeProvider([reply("Hello."), reply("We said hello."), reply("Carrying on.")])
  config(fake.url)
  const a = app(project(), { modelTitles: false })
  await a.turns.prompt("hello there")
  const notices: string[] = []
  a.bus.on((e) => e.type === "notice" && notices.push(e.message))
  expect(await a.engine.compact()).toContain("We said hello.")
  expect(a.engine.model.ref).toBe("plan/coder")
  // The model that was asked is named, and its tokens are counted under it.
  expect(notices.filter((n) => n.includes("the summary is asked of payg/coder"))).toHaveLength(1)
  expect(a.store!.requests(a.engine.sessionId!).map((r) => `${r.kind} ${r.model}`)).toEqual(["step plan/coder", "compaction payg/coder"])
  await a.turns.prompt("and now?")
  expect(asked()).toEqual(["plan/coder", "payg/coder", "plan/coder"])
})

test("with nowhere to go, compaction asked for is refused in the spec's words and nothing is sent", async () => {
  fake = fakeProvider([reply("Hello.")])
  config(fake.url, { twin: false, other: false })
  const a = app(project(), { modelTitles: false })
  await a.turns.prompt("hello there")
  await expect(a.engine.compact()).rejects.toThrow(LOOP.interactive.texts.compact)
  expect(asked()).toEqual(["plan/coder"])
  expect(a.engine.messages.length).toBeGreaterThan(1)
})

test("automatic compaction with nowhere to go is skipped, said once, and the turn goes on", async () => {
  const long = "word ".repeat(2500)
  fake = fakeProvider([{ chunks: [delta({ content: long })] }, reply("Second."), reply("Third.")])
  // A window the system prompt alone overflows: every step is past the automatic threshold.
  config(fake.url, { twin: false, other: false, window: 2000 })
  const a = app(project(), { modelTitles: false })
  const notices: string[] = []
  a.bus.on((e) => e.type === "notice" && notices.push(e.message))
  await a.turns.prompt("one")
  await a.turns.prompt("two")
  await a.turns.prompt("three")
  expect(asked()).toEqual(["plan/coder", "plan/coder", "plan/coder"])
  expect(notices.filter((n) => n.includes("interactive use only"))).toHaveLength(1)
  expect(notices.some((n) => n.includes("compacting the conversation"))).toBe(false)
})

test("automatic compaction with a twin is the twin's work", async () => {
  fake = fakeProvider([reply("First."), reply("A summary of it."), reply("Second.")])
  config(fake.url, { window: 2000 })
  const a = app(project(), { modelTitles: false })
  await a.turns.prompt("one")
  await a.turns.prompt("two")
  expect(asked().slice(0, 3)).toEqual(["plan/coder", "payg/coder", "plan/coder"])
  expect(a.engine.model.ref).toBe("plan/coder")
})

test("a subagent's own automatic compaction goes the same way: the twin's work; with nowhere to go, skipped and said once to the session", async () => {
  const task = { chunks: [toolCall(0, "t1", "task", JSON.stringify({ agent: "general", description: "look", prompt: "look around" }))] }
  const step = { chunks: [toolCall(0, "g1", "glob", JSON.stringify({ pattern: "*" }))] }
  fake = fakeProvider([task, step, reply("The subagent's summary."), reply("Found nothing."), reply("The session's summary."), reply("Done.")])
  config(fake.url, { window: 2000 })
  const a = app(project(), { modelTitles: false, mode: "auto" })
  await a.turns.prompt("have a subagent look")
  // The session's step, the subagent's first, its summary on the twin, its second, then the
  // session's own summary on the twin and its reply.
  expect(asked()).toEqual(["plan/coder", "plan/coder", "payg/coder", "plan/coder", "payg/coder", "plan/coder"])
  fake.stop()

  fake = fakeProvider([task, step, reply("Found nothing."), reply("Done.")])
  config(fake.url, { twin: false, other: false, window: 2000 })
  const b = app(project(), { modelTitles: false, mode: "auto" })
  const notices: string[] = []
  b.bus.on((e) => e.type === "notice" && notices.push(e.message))
  await b.turns.prompt("have a subagent look")
  expect(asked()).toEqual(["plan/coder", "plan/coder", "plan/coder", "plan/coder"])
  expect(notices.filter((n) => n.includes("the subagent general is not compacting"))).toHaveLength(1)
})

test("a model that cannot take the summary is nowhere to go: a twin with too small a window and a default without tools", async () => {
  fake = fakeProvider([reply("Hello.")])
  // The twin's window is far below the conversation; the default takes no tools.
  config(fake.url, { twinWindow: 50, otherTools: false })
  const a = app(project(), { modelTitles: false })
  await a.turns.prompt("hello there")
  await expect(a.engine.compact()).rejects.toThrow(LOOP.interactive.texts.compact)
  expect(asked()).toEqual(["plan/coder"])
})

test("what a schedule's session does when no person's turn runs is the schedule's: a subagent, a turn a job wakes", async () => {
  fake = fakeProvider([])
  config(fake.url, { model: "open/flash" })
  const a = app(project(), { kind: "scheduled", modelTitles: false })
  // Between turns the session's model is changed to the plan's (as a person may in the run's chat).
  a.chooseModel("plan/coder")
  const notices: string[] = []
  a.bus.on((e) => e.type === "notice" && notices.push(e.message))
  // A subagent started with no turn running — one of the run's jobs carrying on — is the run's.
  await expect(a.engine.o.spawn!("general", "look around", { description: "look", background: true } as never)).rejects.toThrow(SENTENCE("plan/coder"))
  // A turn a job's note would wake is not started on it.
  a.wake("[job j1 finished]", "[job j1 finished]")
  await Bun.sleep(50)
  expect(fake.requests).toHaveLength(0)
  expect(notices.filter((n) => n.includes(SENTENCE("plan/coder")))).toHaveLength(1)
})

test("a one-shot run with no terminal at all is scheduled work; any terminal makes it a person's", () => {
  expect(nobodyAtIt({ stdin: false, stdout: false, stderr: false })).toBe(true)
  expect(nobodyAtIt({})).toBe(true)
  // A prompt piped in at a terminal, output redirected: stderr is still the terminal.
  expect(nobodyAtIt({ stdin: false, stdout: false, stderr: true })).toBe(false)
  expect(nobodyAtIt({ stdin: true, stdout: false, stderr: false })).toBe(false)
})

test("lembas run with no terminal refuses an interactive-only model, and says the way forward", async () => {
  fake = fakeProvider([reply("Hi.")])
  config(fake.url)
  const dir = project()
  const run = async (...args: string[]) => {
    const p = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), "run", "--no-store", ...args, "hello"], { cwd: dir, env: { ...process.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
    return { out, err, code }
  }
  const no = await run()
  expect(no.code).toBe(1)
  expect(no.err).toContain(SENTENCE("plan/coder"))
  expect(no.err).toContain(RUN_HINT)
  expect(fake.requests).toHaveLength(0)
  // The way forward it names works.
  const yes = await run("-m", "open/flash")
  expect(yes.code).toBe(0)
  expect(yes.out).toBe("Hi.\n")
}, 60_000)

// ── scheduled work ──────────────────────────────────────────────────────────────────────────

test("scheduled work never starts on one: asked for, it is refused; remembered for the directory, it is skipped", () => {
  fake = fakeProvider([])
  config(fake.url, { model: "open/flash" })
  const root = project()
  expect(() => app(root, { model: "plan/coder", automated: true })).toThrow(SENTENCE("plan/coder"))
  expect(() => app(root, { model: "plan/coder", automated: true })).toThrow(InteractiveOnlyError)
  rememberModel(root, "plan/coder")
  expect(app(root, { automated: true }).engine.model.ref).toBe("open/flash")
  // A person's session there starts on it.
  expect(app(root).engine.model.ref).toBe("plan/coder")
  // And scheduled work cannot switch to one.
  const a = app(root, { automated: true })
  expect(() => a.switchModel("plan/max")).toThrow(SENTENCE("plan/max"))
  expect(a.engine.model.ref).toBe("open/flash")
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

const limitsFor = (root: string): Limits => ({ roots: [root], maxMode: "auto", approvalTimeoutMs: 3000, requireTrust: true, enabled: true, scheduled: true })

async function client(limits: Limits) {
  const [ta, tb] = pair()
  new AcpAgent(new Peer(ta), limits, "f")
  const c = new Peer(tb)
  c.on("_lembas/event", () => {})
  c.on("session/update", () => {})
  c.handle("session/request_permission", () => ({ outcome: { outcome: "selected", optionId: "once" } }))
  await c.request("initialize", { protocolVersion: 1, clientCapabilities: { _meta: { lembas: { protocol: 3 } } } })
  return c
}

const refusal = async (p: Promise<unknown>) => p.then(() => undefined, (e) => ({ message: (e as Error).message, data: (e as { data?: unknown }).data }))
const scheduled = { schedule_id: "sched1", run_id: "run7", title: "Check" }
const say = (sessionId: string, text: string, lembas: Record<string, unknown> = {}) => ({ sessionId, prompt: [{ type: "text", text }], _meta: { lembas } })

test("a scheduled session on an interactive-only model is refused by the device, with the sentence and the reason; an agent chat on it is not", async () => {
  fake = fakeProvider([reply("Hello.")])
  config(fake.url, { model: "open/flash" })
  const root = project()
  const c = await client(limitsFor(root))
  const no = await refusal(c.request("session/new", { cwd: root, _meta: { lembas_model: "plan/coder", lembas: { scheduled } } }))
  expect(no).toEqual({ message: SENTENCE("plan/coder"), data: { reason: "interactive_only" } })
  expect(fake.requests).toHaveLength(0)
  // A person's agent chat on the same model: theirs to use.
  const s: any = await c.request("session/new", { cwd: root, _meta: { lembas_model: "plan/coder" } })
  expect(s._meta.lembas.model).toBe("plan/coder")
  await c.request("session/prompt", say(s.sessionId, "hello"))
  expect(asked()).toEqual(["plan/coder"])
})

test("a continuing schedule whose session has since come to be on one: the scheduled turn is refused before anything is sent, the person's own turn runs", async () => {
  fake = fakeProvider([reply("Checked."), reply("It was fine.")])
  config(fake.url, { model: "open/flash" })
  const root = project()
  const c = await client(limitsFor(root))
  const s: any = await c.request("session/new", { cwd: root, _meta: { lembas_model: "open/flash", lembas: { scheduled } } })
  await c.request("session/prompt", say(s.sessionId, "check", { scheduled, turnId: "run7" }))
  // Between runs the chat's model is changed to the plan's.
  await c.request("_lembas/configure", { sessionId: s.sessionId, model: "plan/coder" })
  const no = await refusal(c.request("session/prompt", say(s.sessionId, "check", { scheduled: { ...scheduled, run_id: "run8" }, turnId: "run8" })))
  expect(no).toEqual({ message: SENTENCE("plan/coder"), data: { reason: "interactive_only" } })
  expect(asked()).toEqual(["open/flash"])
  await c.request("session/prompt", say(s.sessionId, "what did you find?"))
  expect(asked()).toEqual(["open/flash", "plan/coder"])
})

test("a scheduled run's subagent is not started on one: the call answers the sentence and the run goes on", async () => {
  fake = fakeProvider([
    { chunks: [toolCall(0, "t1", "task", JSON.stringify({ agent: "general", description: "look", prompt: "look around", model: "plan/coder" }))] },
    reply("Done without it."),
  ])
  config(fake.url, { model: "open/flash" })
  const root = project()
  const c = await client(limitsFor(root))
  const s: any = await c.request("session/new", { cwd: root, _meta: { lembas_model: "open/flash", lembas: { scheduled: { ...scheduled, mode: "auto" } } } })
  const r: any = await c.request("session/prompt", say(s.sessionId, "use plan/coder for a subagent and check", { scheduled: { ...scheduled, mode: "auto" }, turnId: "run7" }))
  expect(r._meta.lembas.scheduled.status).toBe("ok")
  expect(asked()).toEqual(["open/flash", "open/flash"])
  const result = JSON.stringify(fake.requests[1].messages.at(-1))
  expect(result).toContain("for interactive use only")
})

test("a command's own model in a scheduled prompt, when it is interactive-only: the same refusal with its reason, and the session is as it was", async () => {
  fake = fakeProvider([reply("It was fine.")])
  config(fake.url, { model: "open/flash" })
  const root = project()
  mkdirSync(join(root, ".agent", "commands"), { recursive: true })
  writeFileSync(join(root, ".agent", "config.yaml"), "")
  writeFileSync(join(root, ".agent", "commands", "quick.md"), "---\nmodel: plan/coder\n---\nQuick.")
  const c = await client(limitsFor(root))
  const s: any = await c.request("session/new", { cwd: root, _meta: { lembas_model: "open/flash", lembas: { scheduled } } })
  const no = await refusal(c.request("session/prompt", say(s.sessionId, "/quick", { scheduled, turnId: "run7" })))
  expect(no).toEqual({ message: SENTENCE("plan/coder"), data: { reason: "interactive_only" } })
  expect(fake.requests).toHaveLength(0)
  // The person's own turn afterwards runs, on the session's model.
  await c.request("session/prompt", say(s.sessionId, "what happened?"))
  expect(asked()).toEqual(["open/flash"])
})
