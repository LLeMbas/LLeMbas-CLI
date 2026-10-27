// ACP: the JSON-RPC peer, LLeMbas CLI as an agent (serve --stdio and the LLeMbas link
// share it), the device's own limits on remote work, the link itself against a fake LLeMbas, the
// service unit, and library: lembas.
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AcpAgent, clampMode, underRoots, type Limits } from "../src/acp/agent.ts"
import { runLink } from "../src/acp/link.ts"
import { Peer, type Transport } from "../src/acp/rpc.ts"
import { paths } from "../src/config/paths.ts"
import { setTrust } from "../src/project/root.ts"
import { unitText } from "../src/service.ts"
import { delta, fakeProvider, toolCall, type Fake } from "./fake-provider.ts"

let fake: Fake | undefined
const stops: (() => void)[] = []
afterEach(() => {
  fake?.stop()
  for (const s of stops.splice(0)) s()
})

/** Two transports wired to each other, as a pipe would be. */
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
  writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  f:\n    type: webui\n    url: ${url}\n    models: { f/m: {} }\n`, { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), `model: f/m\n${extra}`)
}

function project(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ph-acp-")))
  setTrust(dir, "trusted")
  return dir
}

test("the peer: requests both ways, notifications, errors, and a close", async () => {
  const [ta, tb] = pair()
  const a = new Peer(ta)
  const b = new Peer(tb)
  b.handle("add", (p) => p.x + p.y)
  b.handle("boom", () => {
    throw new Error("no")
  })
  const heard: unknown[] = []
  b.on("note", (p) => void heard.push(p))
  expect(await a.request<number>("add", { x: 2, y: 3 })).toBe(5)
  await expect(a.request("boom")).rejects.toThrow("no")
  await expect(a.request("missing")).rejects.toThrow("Method not found")
  a.notify("note", { n: 1 })
  await Bun.sleep(5)
  expect(heard).toEqual([{ n: 1 }])
  a.handle("slow", () => new Promise(() => {}))
  const pending = b.request("slow")
  ta.close()
  await expect(pending).rejects.toThrow("closed")
})

test("limits: roots, and a mode never above the device's", () => {
  expect(underRoots("/srv/app/src", ["/srv/app"])).toBe(true)
  expect(underRoots("/srv/application", ["/srv/app"])).toBe(false)
  expect(underRoots("/etc", [])).toBe(false)
  expect(clampMode("auto", "edit")).toBe("edit")
  expect(clampMode("plan", "edit")).toBe("plan")
  expect(clampMode("manual", "edit")).toBe("manual")
})

async function client(limits?: Limits, answer?: (p: any) => unknown, instanceConnection?: string) {
  const [ta, tb] = pair()
  const agentSide = new Peer(ta)
  new AcpAgent(agentSide, limits, instanceConnection)
  const c = new Peer(tb)
  const updates: any[] = []
  const events: any[] = []
  c.on("session/update", (p) => void updates.push(p.update))
  c.on("_lembas/event", (p) => void events.push(p.event))
  c.handle("session/request_permission", (p) => answer?.(p) ?? { outcome: { outcome: "selected", optionId: "once" } })
  const init: any = await c.request("initialize", { protocolVersion: 1, clientCapabilities: { _meta: { lembas: true } } })
  return { c, updates, events, init }
}

test("a prompt streams its reply and ends with a stop reason", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "Hello from " }), delta({ content: "the device." })] }])
  config(fake.url)
  const { c, updates, events, init } = await client()
  expect(init.protocolVersion).toBe(1)
  expect(init.agentInfo.name).toBe("LLeMbas CLI")
  const s: any = await c.request("session/new", { cwd: project(), mcpServers: [] })
  const r: any = await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "hi" }] })
  expect(r.stopReason).toBe("end_turn")
  const text = updates.filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.content.text).join("")
  expect(text).toBe("Hello from the device.")
  // LLeMbas asked for the full events, and got them.
  expect(events.some((e) => e.type === "done")).toBe(true)
})

test("an approval is asked of the client, and its answer decides", async () => {
  fake = fakeProvider([
    { chunks: [toolCall(0, "t1", "bash", JSON.stringify({ command: "echo approved-run", description: "say it" }))] },
    { chunks: [delta({ content: "done" })] },
    { chunks: [toolCall(0, "t2", "bash", JSON.stringify({ command: "echo denied-run", description: "say it" }))] },
    { chunks: [delta({ content: "fine" })] },
  ])
  config(fake.url, "mode: manual\n")
  let asked = 0
  const { c, updates } = await client(undefined, (p) => {
    asked++
    expect(p.toolCall.title).toContain("echo")
    return asked === 1 ? { outcome: { outcome: "selected", optionId: "once" } } : { outcome: { outcome: "selected", optionId: "deny" } }
  })
  const s: any = await c.request("session/new", { cwd: project() })
  await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "run it" }] })
  const done = updates.find((u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === "t1")
  expect(done.status).toBe("completed")
  expect(done.content[0].content.text).toContain("approved-run")
  await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "again" }] })
  const refused = updates.find((u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === "t2")
  expect(refused.status).toBe("failed")
  expect(asked).toBe(2)
})

test("the device's limits: outside the roots, untrusted, a higher mode", async () => {
  fake = fakeProvider([])
  config(fake.url)
  const root = project()
  const limits: Limits = { roots: [root], maxMode: "edit", approvalTimeoutMs: 50, requireTrust: true }
  const { c, init } = await client(limits)
  expect(init._meta.lembas.limits).toEqual({ roots: [root], max_mode: "edit" })
  await expect(c.request("session/new", { cwd: tmpdir() })).rejects.toThrow("outside the directories")
  const untrusted = join(root, "..", `ph-untrusted-${Date.now()}`)
  mkdirSync(untrusted)
  await expect(c.request("session/new", { cwd: untrusted })).rejects.toThrow("outside")
  const s: any = await c.request("session/new", { cwd: root, _meta: { mode: "auto" } })
  expect(s.modes.currentModeId).toBe("edit")
  expect(s.modes.availableModes.map((m: any) => m.id).sort()).toEqual(["edit", "manual", "plan"])
  await c.request("session/set_mode", { sessionId: s.sessionId, modeId: "auto" })
})

test("inside a trusted directory is trusted for remote work, a git repository in it too", async () => {
  fake = fakeProvider([])
  config(fake.url)
  const home = project()
  const repo = join(home, "Ambitious")
  mkdirSync(join(repo, ".git", "objects"), { recursive: true })
  writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n")
  const { c } = await client({ roots: [home], maxMode: "auto", approvalTimeoutMs: 50, requireTrust: true })
  const s: any = await c.request("session/new", { cwd: repo })
  expect(s.sessionId).toBeTruthy()
})

test("_lembas/directories: the trusted places, then what is in one, each said accepted or not", async () => {
  fake = fakeProvider([])
  config(fake.url)
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "ph-dirs-")))
  const home = join(parent, "home")
  const other = join(parent, "elsewhere")
  for (const d of [join(home, "Ambitious", "src"), join(home, ".hidden"), join(home, "node_modules"), other]) mkdirSync(d, { recursive: true })
  writeFileSync(join(home, "a-file.txt"), "x")
  setTrust(home, "trusted")
  setTrust(other, "trusted") // trusted, but not under the roots: never offered
  const { c } = await client({ roots: [home], maxMode: "auto", approvalTimeoutMs: 50, requireTrust: true })

  const places: any = await c.request("_lembas/directories", {})
  expect(places.places).toEqual([{ path: home, name: "home", accepted: true }])

  const inside: any = await c.request("_lembas/directories", { path: home })
  expect(inside.accepted).toBe(true)
  expect(inside.parent).toBe("")
  // Directories only, no hidden ones, no node_modules.
  expect(inside.entries).toEqual([{ path: join(home, "Ambitious"), name: "Ambitious", accepted: true }])

  const deeper: any = await c.request("_lembas/directories", { path: join(home, "Ambitious") })
  expect(deeper.parent).toBe(home)
  expect(deeper.entries.map((e: any) => e.name)).toEqual(["src"])

  await expect(c.request("_lembas/directories", { path: other })).rejects.toThrow("outside the directories")
  await expect(c.request("_lembas/directories", { path: "relative/path" })).rejects.toThrow("absolute")
})

test("_lembas/directories: an untrusted directory is listed, and said to be refused", async () => {
  fake = fakeProvider([])
  config(fake.url)
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ph-dirs-untrusted-")))
  mkdirSync(join(root, "sub"))
  const { c } = await client({ roots: [root], maxMode: "edit", approvalTimeoutMs: 50, requireTrust: true })
  const places: any = await c.request("_lembas/directories", {})
  expect(places.places[0].accepted).toBe(false)
  expect(places.places[0].reason).toContain("not in a trusted project")
  const inside: any = await c.request("_lembas/directories", { path: root })
  expect(inside.entries[0]).toMatchObject({ name: "sub", accepted: false })
})

test("_lembas/directories is for the link only: an editor's ACP session has no roots to offer", async () => {
  const { c } = await client()
  await expect(c.request("_lembas/directories", {})).rejects.toThrow("LLeMbas link only")
})

test("the chat's model and effort: named by the instance, at the start and between prompts", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "one" })] }, { chunks: [delta({ content: "two" })] }])
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  example:\n    type: webui\n    url: ${fake.url}\n    models: { bonsai: {}, deepseek-flash: { efforts: [low, medium, high] } }\n`, { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), "model: bonsai\n")
  const root = project()
  const { c } = await client({ roots: [root], maxMode: "auto", approvalTimeoutMs: 50, requireTrust: true }, undefined, "example")
  // Not the device's own default: the model the chat was started on there.
  const s: any = await c.request("session/new", { cwd: root, _meta: { mode: "auto", lembas_model: "deepseek-flash", effort: "high" } })
  expect(s._meta.lembas).toMatchObject({ model: "deepseek-flash", effort: "high" })
  await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "hi" }] })
  expect(fake.requests[0].model).toBe("deepseek-flash")
  expect(JSON.stringify(fake.requests[0])).toContain('"reasoning_effort":"high"')
  // Changed in the web UI between two prompts.
  const changed: any = await c.request("_lembas/configure", { sessionId: s.sessionId, model: "bonsai", effort: "off" })
  expect(changed).toEqual({ model: "bonsai", effort: "off" })
  await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "again" }] })
  expect(fake.requests.at(-1).model).toBe("bonsai")
  expect(JSON.stringify(fake.requests.at(-1))).not.toContain("reasoning_effort")
})

test("the terminal: a real shell through the link, only where remote.terminal says so", async () => {
  fake = fakeProvider([])
  config(fake.url)
  const root = project()
  const off = await client({ roots: [root], maxMode: "edit", approvalTimeoutMs: 50, requireTrust: true })
  expect(off.init._meta.lembas.capabilities).toEqual(["directories", "configure", "steer", "sessions", "status", "delete", "compact", "title", "files", "commands", "attachments", "ask", "plan", "model", "turns", "context", "library", "prototypes", "plan_state", "rewind", "jobs", "show"])
  await expect(off.c.request("_lembas/terminal/open", { cwd: root })).rejects.toThrow("remote.terminal is off")

  const { c, init } = await client({ roots: [root], maxMode: "edit", approvalTimeoutMs: 50, requireTrust: true, terminal: true })
  expect(init._meta.lembas.capabilities).toContain("terminal")
  expect(init._meta.lembas.capabilities).toContain("shell")
  await expect(c.request("_lembas/terminal/open", { cwd: tmpdir() })).rejects.toThrow("outside")
  let out = ""
  let exited: any
  c.on("_lembas/terminal/output", (p) => void (out += Buffer.from(p.data, "base64").toString()))
  c.on("_lembas/terminal/exit", (p) => void (exited = p))
  const t: any = await c.request("_lembas/terminal/open", { cwd: root, cols: 100, rows: 30 })
  expect(t.cwd).toBe(root)
  // Which shell, and whether its prompts are marked: bash, zsh and fish are, by default.
  const kind = ["bash", "zsh", "fish"].includes((process.env.SHELL || "/bin/bash").split("/").pop()!) ? (process.env.SHELL || "/bin/bash").split("/").pop() : "other"
  expect(t.shell).toBe(kind)
  expect(t.integration).toBe(kind !== "other")
  c.notify("_lembas/terminal/input", { terminalId: t.terminalId, data: Buffer.from("pwd; stty size; exit\n").toString("base64") })
  for (let i = 0; i < 100 && !exited; i++) await Bun.sleep(50)
  expect(out).toContain(root)
  expect(out).toContain("30 100")
  expect(exited.terminalId).toBe(t.terminalId)
})

test("a message sent mid-task reaches the model at its next step, as in the TUI", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "done" })] }, { chunks: [delta({ content: "and that too" })] }])
  config(fake.url)
  const root = project()
  const { c } = await client({ roots: [root], maxMode: "edit", approvalTimeoutMs: 50, requireTrust: true })
  const s: any = await c.request("session/new", { cwd: root })
  await expect(c.request("_lembas/steer", { sessionId: s.sessionId, text: "also this" })).rejects.toThrow("not working on anything")
  const running = c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "hi" }] })
  const queued: any = await c.request("_lembas/steer", { sessionId: s.sessionId, text: "also this" })
  expect(queued.queued).toBe(1)
  const r: any = await running
  // Taken in at the next step boundary — the first one, here, or after the answer — never lost.
  expect(r._meta.lembas.unsent).toBeUndefined()
  expect(fake.requests.some((q: any) => JSON.stringify(q.messages).includes("also this"))).toBe(true)
})

test("with busy_input: queue, a message the task never took is handed back as unsent", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "done" })] }])
  config(fake.url, "busy_input: queue\n")
  const root = project()
  const { c } = await client({ roots: [root], maxMode: "edit", approvalTimeoutMs: 50, requireTrust: true })
  const s: any = await c.request("session/new", { cwd: root })
  const running = c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "hi" }] })
  await c.request("_lembas/steer", { sessionId: s.sessionId, text: "later" })
  const r: any = await running
  expect(r._meta.lembas.unsent).toEqual(["later"])
})

test("an approval nobody answers is a denial", async () => {
  fake = fakeProvider([
    { chunks: [toolCall(0, "t1", "bash", JSON.stringify({ command: "echo never", description: "x" }))] },
    { chunks: [delta({ content: "ok" })] },
  ])
  config(fake.url, "mode: manual\n")
  const root = project()
  const { c, updates } = await client({ roots: [root], maxMode: "manual", approvalTimeoutMs: 50, requireTrust: true }, () => new Promise(() => {}))
  const s: any = await c.request("session/new", { cwd: root })
  await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "x" }] })
  const u = updates.find((x) => x.sessionUpdate === "tool_call_update" && x.toolCallId === "t1")
  expect(u.status).toBe("failed")
  expect(fake.requests[1].messages.at(-1).content).toContain("Nobody answered")
})

test("the link dials out with the token, says hello, is driven, and stops when refused", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "linked reply" })] }])
  const root = project()
  config(fake.url, `remote:\n  enabled: true\n  roots: [${root}]\n  max_mode: edit\n`)
  let hello: any
  let authorization = ""
  let connections = 0
  let reply = ""
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      const base = `http://${new URL(req.url).host}`
      // A discovery saying protocol 1 for older CLIs, protocols [1, 2] for this one.
      if (new URL(req.url).pathname === "/.well-known/lembas.json")
        return Response.json({ service: "lembas", version: "2.2.0", protocol: 1, protocols: [1, 2], harness_spec: "2.1.0", base_url: base, api: { openai: `${base}/v1` }, login: { device: { code: `${base}/c`, token: `${base}/t`, verify: `${base}/d` } } })
      authorization = req.headers.get("authorization") ?? ""
      if (new URL(req.url).pathname === "/api/devices/link" && srv.upgrade(req)) return
      return new Response("no", { status: 404 })
    },
    websocket: {
      async open(ws) {
        connections++
        if (connections > 1) return ws.close(4401, "revoked")
        const [mine, theirs] = pair()
        // Bridge: the fake instance is an ACP client over this socket.
        ;(ws as any).data = theirs
        const peer = new Peer({ send: (t) => ws.send(t), onMessage: (fn) => ((ws as any).recv = fn), onClose: () => {}, close: () => ws.close() })
        void mine
        peer.on("_lembas/hello", (p) => void (hello = p))
        peer.on("session/update", (p) => {
          if (p.update.sessionUpdate === "agent_message_chunk") reply += p.update.content.text
        })
        await peer.request("initialize", { protocolVersion: 1, clientCapabilities: {} })
        const s: any = await peer.request("session/new", { cwd: root })
        await peer.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "go" }] })
        ws.close(1000, "done")
      },
      message(ws, msg) {
        ;(ws as any).recv?.(typeof msg === "string" ? msg : new TextDecoder().decode(msg))
      },
    },
  })
  stops.push(() => server.stop(true))
  const base = `http://127.0.0.1:${server.port}`
  writeFileSync(join(paths.config, "lembas.json"), JSON.stringify({ instances: { fake: { base_url: base, connection: "fake", logged_in_at: "" } } }))
  mkdirSync(join(paths.config, "lembas"), { recursive: true })
  writeFileSync(join(paths.config, "lembas", "fake.key"), "lmb_device\n", { mode: 0o600 })
  const states: string[] = []
  const end = await runLink({ backoffMs: [10, 20], onStatus: (s) => states.push(s.state) })
  expect(authorization).toBe("Bearer lmb_device")
  expect(hello.protocol).toBe(2)
  expect(hello.limits.max_mode).toBe("edit")
  expect(reply).toBe("linked reply")
  expect(end.state).toBe("stopped")
  expect(end.detail).toContain("revoked")
  expect(states).toContain("linked")
  expect(states).toContain("waiting")
})

test("the service unit runs the link as the user, restarted on failure", () => {
  const unit = unitText("/usr/local/bin/lembas service run")
  expect(unit).toContain("ExecStart=/usr/local/bin/lembas service run")
  expect(unit).toContain("Restart=on-failure")
  expect(unit).toContain("WantedBy=default.target")
  expect(unit).not.toContain("User=")
})

test("the link says protocol 1 to an instance that lists only 1, and stops on 4400 instead of redialling", async () => {
  const root = project()
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(join(paths.config, "config.yaml"), `remote:\n  enabled: true\n  roots: [${root}]\n`)
  const hellos: number[] = []
  let dials = 0
  let lists = [1]
  let everything4400 = false
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      const u = new URL(req.url)
      const base = `http://${u.host}`
      if (u.pathname === "/.well-known/lembas.json")
        return Response.json({ service: "lembas", version: "2.1.0", protocol: 1, ...(lists.length > 1 ? { protocols: lists } : {}), harness_spec: "2.0.1", base_url: base, api: { openai: `${base}/v1` }, login: { device: { code: `${base}/c`, token: `${base}/t`, verify: `${base}/d` } } })
      if (u.pathname === "/api/devices/link" && srv.upgrade(req)) return
      return new Response("no", { status: 404 })
    },
    websocket: {
      open() {
        dials++
      },
      message(ws, msg) {
        const m = JSON.parse(String(msg))
        if (m.method !== "_lembas/hello") return
        hellos.push(m.params.protocol)
        // LLeMbas 2.1.0: a hello saying a protocol it does not speak is closed with 4400.
        if (m.params.protocol !== 1 || everything4400) ws.close(4400, "protocol")
        else ws.close(4401, "revoked")
      },
    },
  })
  stops.push(() => server.stop(true))
  writeFileSync(join(paths.config, "lembas.json"), JSON.stringify({ instances: { fake: { base_url: `http://127.0.0.1:${server.port}`, connection: "fake", logged_in_at: "" } } }))
  mkdirSync(join(paths.config, "lembas"), { recursive: true })
  writeFileSync(join(paths.config, "lembas", "fake.key"), "lmb_device\n", { mode: 0o600 })
  const one = await runLink({ backoffMs: [10, 20] })
  expect(hellos).toEqual([1])
  expect(one.detail).toContain("revoked")
  // The instance updated since: discovery lists 2 now, the next link says 2 (and the index keeps it).
  lists = [1, 2]
  const old = (await import("../src/lembas/login.ts")).instances().fake
  expect(old?.protocols).toEqual([1])
  // An instance that closes a hello of 2 with 4400 anyway (discovery said more than its link takes):
  // one dial again at once, saying 1 — here refused for the token, which stops it as usual.
  const two = await runLink({ backoffMs: [10, 20] })
  expect(hellos).toEqual([1, 2, 1])
  expect(two.state).toBe("stopped")
  expect(two.detail).toContain("revoked")
  expect(dials).toBe(3)
  expect((await import("../src/lembas/login.ts")).instances().fake?.protocols).toEqual([1, 2])
  // A 4400 to protocol 1 as well: stopped, said plainly, not dialled again.
  everything4400 = true
  const three = await runLink({ backoffMs: [10, 20] })
  expect(hellos).toEqual([1, 2, 1, 2, 1])
  expect(three.detail).toBe("the instance and this CLI speak different link protocols — update one of them")
  expect(dials).toBe(5)
})

test("a link that cannot dial says why: a CA file gone since the login, and what discovery met", async () => {
  mkdirSync(paths.config, { recursive: true })
  const closed = Bun.serve({ port: 0, fetch: () => new Response("no") })
  const port = closed.port
  closed.stop(true)
  writeFileSync(join(paths.config, "lembas.json"), JSON.stringify({ instances: { fake: { base_url: `http://127.0.0.1:${port}`, connection: "fake", ca: "gone/ca.crt", logged_in_at: "" } } }))
  mkdirSync(join(paths.config, "lembas"), { recursive: true })
  writeFileSync(join(paths.config, "lembas", "fake.key"), "lmb_device\n", { mode: 0o600 })
  const stop = new AbortController()
  const waits: string[] = []
  await runLink({
    backoffMs: [10, 20],
    signal: stop.signal,
    onStatus: (s) => {
      if (s.state !== "waiting") return
      waits.push(s.detail ?? "")
      stop.abort()
    },
  })
  expect(waits[0]).toContain(`the CA file given at login, ${join(process.cwd(), "gone/ca.crt")}, is not there`)
  expect(waits[0]).not.toContain("could not reach the instance;")
})
