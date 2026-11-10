// Subagents v2 (harness spec 3.4.0, subagents.md §5–§14; progress.md) through the whole app: a
// subagent's team_finish ends its turn, a narrowed one is refused what only the main agent may
// allow and asks for it, a call nobody in the tree can allow reaches the person naming the
// subagent, a subagent whose context fills gets one final turn and ends, every engine says its
// progress as phase events, and an agent chat's tree goes over the link. The rules themselves are
// conformance/team.json's and delegation.json's.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp, type App } from "../src/app.ts"
import type { AskReply, Event } from "../src/bus/index.ts"
import { paths } from "../src/config/paths.ts"
import { LOOP } from "../src/harness.ts"
import { AcpAgent } from "../src/acp/agent.ts"
import { Peer, type Transport } from "../src/acp/rpc.ts"
import { setTrust } from "../src/project/root.ts"
import { delta, fakeProvider, toolCall, type Fake, type Scripted } from "./fake-provider.ts"

let fake: Fake | undefined
let app: App | undefined
afterEach(async () => {
  await app?.close()
  app = undefined
  fake?.stop()
})

const T = LOOP.team
const say = (text: string): Scripted => ({ chunks: [delta({ content: text }, "stop")] })
const call = (id: string, name: string, args: unknown, usage?: { prompt_tokens: number; completion_tokens: number }): Scripted => ({
  chunks: [toolCall(0, id, name, JSON.stringify(args)), delta({}, "tool_calls"), ...(usage ? [{ choices: [], usage }] : [])],
})
const system = (body: any): string => body.messages[0].content
const memberName = (body: any): string | undefined => /You are "([a-z0-9-]+)" \(s\d+\), a subagent/.exec(system(body))?.[1]
const lastUser = (body: any): string => {
  const u = [...body.messages].reverse().find((m: any) => m.role === "user")
  return typeof u.content === "string" ? u.content : u.content.map((p: any) => p.text ?? "").join("")
}
const toolResults = (body: any): string[] => body.messages.filter((m: any) => m.role === "tool").map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)).replace(/^\[#\d+\]\n/, ""))

function setup(answer: (body: any) => Scripted | undefined, spec = "{ context: 32768, parallel: 4 }") {
  fake = fakeProvider(answer)
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  fake:\n    type: webui\n    url: ${fake.url}\n    models:\n      fake/m: ${spec}\n`, { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), "model: fake/m\n")
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lembas-sub2-")))
  Bun.spawnSync(["git", "init", "-q", dir])
  setTrust(dir, "trusted")
  return dir
}

async function until(what: () => boolean, ms = 10000) {
  const end = Date.now() + ms
  while (!what()) {
    if (Date.now() > end) throw new Error("timed out")
    await Bun.sleep(20)
  }
}

/** The lead's script: the calls in order, then a closing line; each member's by its name. */
function scripted(lead: Scripted[], members: Record<string, Scripted[]>) {
  const at: Record<string, number> = {}
  return (body: any): Scripted => {
    const who = memberName(body) ?? "lead"
    const list = who === "lead" ? lead : (members[who] ?? [])
    const n = (at[who] = (at[who] ?? -1) + 1)
    return list[n] ?? say(`${who} is done.`)
  }
}

describe("subagents v2 (spec 3.4.0)", () => {
  test("team_finish reports to the parent and ends the subagent: nothing runs after that call", async () => {
    const dir = setup(
      scripted([call("a1", "team_add", { name: "api", role: "the API", task: "Write the API.", goal: "a service" }), say("api is on it.")], {
        api: [call("f1", "team_finish", { report: "The API is done: src/api.ts." }), call("x1", "write", { path: "late.txt", content: "x" })],
      }),
    )
    app = createApp({ cwd: dir, mode: "edit", asker: { ask: async (): Promise<AskReply> => ({ kind: "once" }) }, store: false })
    await app.engine.prompt("build it")
    await until(() => app!.team.team.ended.length === 1)
    await until(() => !app!.engine.busy)
    const t = app.team.team
    expect(t.ended[0]).toMatchObject({ id: "s1", name: "api", state: "done" })
    expect(t.room.find((m) => m.report)?.text).toBe("The API is done: src/api.ts.")
    // Its one request: nothing after the team_finish call.
    expect(fake!.requests.filter((r) => memberName(r) === "api")).toHaveLength(1)
    expect(await Bun.file(join(dir, "late.txt")).exists()).toBe(false)
  }, 20000)

  test("permissions: a narrowed subagent is told to ask the main agent; a call nobody in the tree can allow reaches the person, naming the subagent", async () => {
    const asked: any[] = []
    const dir = setup(
      scripted(
        [
          call("a1", "team_add", { name: "docs", role: "the docs", task: "Write the docs.", goal: "docs", mode: "manual", request: ["write"] }),
          call("a2", "team_add", { name: "ops", role: "the release", task: "Push it." }),
          say("Both are on it."),
        ],
        {
          docs: [call("w1", "write", { path: "README.md", content: "# Docs\n" }), say("asked")],
          ops: [call("b1", "bash", { command: "git push origin main" }), say("pushed or not")],
        },
      ),
    )
    app = createApp({ cwd: dir, mode: "edit", asker: { ask: async (req): Promise<AskReply> => (asked.push(req), { kind: "deny" }) }, store: false })
    await app.engine.prompt("go")
    await until(() => fake!.requests.filter((r) => memberName(r) === "docs").length >= 2 && fake!.requests.filter((r) => memberName(r) === "ops").length >= 2)
    const docs = fake!.requests.filter((r) => memberName(r) === "docs")
    expect(toolResults(docs[1])[0]).toBe(T.texts.requestable)
    // The docs subagent has team_request (it has request options); the ops subagent does not.
    expect(docs[0].tools.map((x: any) => x.function.name)).toContain("team_request")
    const ops = fake!.requests.filter((r) => memberName(r) === "ops")
    expect(ops[0].tools.map((x: any) => x.function.name)).not.toContain("team_request")
    expect(ops[0].tools.map((x: any) => x.function.name)).not.toContain("team_add")
    // An all-edit tree: the subagent's push reaches the person, not the main agent.
    expect(asked.map((r) => [r.tool, r.source?.subagent?.name])).toEqual([["bash", "ops"]])
    expect(asked[0].source.subagent).toEqual({ id: "s2", name: "ops", position: "the release" })
    expect(await Bun.file(join(dir, "README.md")).exists()).toBe(false)
  }, 20000)

  test("a subagent whose context fills is paused, gets one final turn, and ends; its parent gets the notice and its last reply", async () => {
    const dir = setup(
      scripted([call("a1", "team_add", { name: "scan", role: "scans the code", task: "Scan everything.", goal: "a map" }), say("scan is on it.")], {
        scan: [
          call("n1", "team_findings", { action: "write", text: "src/ has 12 modules." }, { prompt_tokens: 3700, completion_tokens: 20 }),
          say("Saved my findings; the tests are left."),
        ],
      }),
      "{ context: 4096, parallel: 4 }",
    )
    app = createApp({ cwd: dir, mode: "edit", asker: { ask: async (): Promise<AskReply> => ({ kind: "once" }) }, store: false })
    await app.engine.prompt("map it")
    await until(() => app!.team.team.ended.length === 1)
    const t = app.team.team
    expect(t.ended[0]).toMatchObject({ name: "scan", state: "out_of_context" })
    expect(t.ended[0]!.findings.map((f) => f.text)).toEqual(["src/ has 12 modules."])
    const scans = fake!.requests.filter((r) => memberName(r) === "scan")
    // The final turn: its user message is the notice, under its mark.
    expect(lastUser(scans[1])).toContain(T.texts.context_full.replace("{{steps}}", String(T.context.final_steps)))
    const report = t.room.find((m) => m.report)!
    expect(report.text).toBe(`${T.texts.gone.replace("{{name}}", "scan").replace("{{id}}", "s1").replace("{{name}}", "scan")}\n\nSaved my findings; the tests are left.`)
  }, 20000)

  test("every engine says its progress: reading the prompt, a tool, writing, and nothing once the turn is done", async () => {
    const dir = setup(() => undefined)
    let n = 0
    fake!.stop()
    fake = fakeProvider(() => (n++ === 0 ? call("l1", "list", {}) : say("Listed.")))
    writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  fake:\n    type: webui\n    url: ${fake.url}\n    models:\n      fake/m: { context: 32768 }\n`, { mode: 0o600 })
    app = createApp({ cwd: dir, mode: "edit", asker: { ask: async (): Promise<AskReply> => ({ kind: "once" }) }, store: false })
    const phases: (string | null)[] = []
    app.bus.on((e: Event) => e.type === "phase" && phases.push(e.progress?.phase ?? null))
    await app.engine.prompt("list it")
    expect(phases).toContain("reading_prompt")
    expect(phases).toContain("running_tool")
    expect(phases).toContain("writing")
    expect(phases.at(-1)).toBeNull()
    expect(app.engine.progress.current).toBeNull()
  }, 20000)
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

test("an agent chat's tree over the link: the setting comes down with the turn; the tree, progress, findings and transcript come up", async () => {
  const dir = setup(
    scripted([call("a1", "team_add", { name: "api", role: "the API", task: "Write the API.", goal: "a service" }), say("api is on it.")], {
      api: [call("n1", "team_findings", { action: "write", text: "Login is POST /session." }), say("API done.")],
    }),
  )
  const [ta, tb] = pair()
  new AcpAgent(new Peer(ta))
  const c = new Peer(tb)
  const events: any[] = []
  c.on("_lembas/event", (p) => void events.push(p.event))
  c.handle("session/request_permission", () => ({ outcome: { outcome: "selected", optionId: "once" } }))
  const init: any = await c.request("initialize", { protocolVersion: 1, clientCapabilities: { _meta: { lembas: { protocol: 3 } } } })
  expect(init._meta.lembas.capabilities).toEqual(expect.arrayContaining(["progress", "tree", "agents"]))
  const s: any = await c.request("session/new", { cwd: dir, mcpServers: [], _meta: { lembas: { agents: { min: 1, max: 3 }, said: ["Use the main model only."] } } })
  await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "build it" }], _meta: { lembas: { agents: { min: 1, max: 3 } } } })
  await until(() => events.some((e) => e.type === "team" && e.tree?.agents.some((a: any) => a.name === "api" && a.state === "finished")))
  const view: any = await c.request("_lembas/team", { sessionId: s.sessionId })
  expect(view.tree).toMatchObject({ min: 1, max: 3, size: 2 })
  expect(view.tree.agents.map((a: any) => [a.id, a.name, a.parent])).toEqual([
    ["lead", "lead", null],
    ["s1", "api", "lead"],
  ])
  expect(view.room.map((m: any) => [m.from, m.kind])).toEqual([["api", "report"]])
  expect(await c.request("_lembas/team/findings", { sessionId: s.sessionId, id: "s1" })).toMatchObject({ id: "s1", findings: [{ n: 1, text: "Login is POST /session." }] })
  const tr: any = await c.request("_lembas/team/transcript", { sessionId: s.sessionId, id: "s1" })
  expect(tr.turns[0]).toMatchObject({ role: "user" })
  expect(JSON.stringify(tr.turns)).toContain("Write the API.")
  expect(events.some((e) => e.type === "phase")).toBe(true)
  const st: any = await c.request("_lembas/session/status", { sessionId: s.sessionId })
  expect(st.tree.agents).toHaveLength(2)
  expect("progress" in st).toBe(true)
}, 20000)
