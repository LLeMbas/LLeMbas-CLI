// Models of the LLeMbas server named by the id it serves them under: `deepseek/deepseek-flash`, not
// `example/deepseek-flash`. LLeMbas CLI 2.0 talks to one server, so the id is the ref; the older
// forms still resolve and a config naming one is rewritten; a custom connection beside the login is
// read past. On the link, the model event and the announcement say whether the session's model is
// this link's instance's.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AcpAgent } from "../src/acp/agent.ts"
import { Hub } from "../src/acp/hub.ts"
import { Share } from "../src/acp/share.ts"
import { Peer, type Transport } from "../src/acp/rpc.ts"
import { createApp } from "../src/app.ts"
import { loadConfig } from "../src/config/load.ts"
import { paths } from "../src/config/paths.ts"
import { writeCache } from "../src/lembas/webui.ts"
import { setTrust } from "../src/project/root.ts"
import { resolveModel } from "../src/provider/index.ts"
import { findRef, modelRefs } from "../src/provider/refs.ts"
import { embedderFor } from "../src/library/embed.ts"
import { delta, fakeProvider, type Fake } from "./fake-provider.ts"

let fake: Fake | undefined
beforeEach(() => clean())
afterEach(() => {
  fake?.stop()
  fake = undefined
  clean()
})
function clean() {
  rmSync(join(paths.state, "migrations.json"), { force: true })
  rmSync(join(paths.config, "lembas.json"), { force: true })
  rmSync(join(paths.config, "lembas"), { recursive: true, force: true })
  rmSync(join(paths.state, "webui"), { recursive: true, force: true })
}

const conns = (o: Record<string, { models: string[] }>) =>
  Object.fromEntries(Object.entries(o).map(([n, c]) => [n, { base_url: "http://x/v1", models: Object.fromEntries(c.models.map((m) => [m, {}])), webui: { url: "http://x" } }])) as never

test("refs: the served id; the older forms name the same model", () => {
  const c = conns({ example: { models: ["deepseek/deepseek-flash", "llama/bonsai", "old"] } })
  const refs = modelRefs(c)
  expect(refs.map((r) => r.ref)).toEqual(["deepseek/deepseek-flash", "llama/bonsai", "old"])
  expect(findRef(c, refs, "example/deepseek-flash")).toMatchObject({ ref: "deepseek/deepseek-flash", old: true })
  expect(findRef(c, refs, "example/deepseek/deepseek-flash")).toMatchObject({ ref: "deepseek/deepseek-flash", old: true })
  expect(findRef(c, refs, "example/bonsai")?.ref).toBe("llama/bonsai")
  expect(findRef(c, refs, "example/old")?.ref).toBe("old")
  expect(findRef(c, refs, "llama/bonsai")?.old).toBeUndefined()
  expect(findRef(c, refs, "other/bonsai")).toBeUndefined()
})

/** Logged in to an instance served by `fake`, whose models are `models` (as /v1/models said them;
 *  `provider` given for an id with a `/` unless `o.noProvider`, and `o.protocols` as discovery said). */
function loggedIn(models: string[], extra = "", o: { noProvider?: boolean; protocols?: number[] } = {}) {
  mkdirSync(join(paths.config, "lembas"), { recursive: true })
  const key = join(paths.config, "lembas", "example.key")
  writeFileSync(key, "lmb_key\n", { mode: 0o600 })
  const url = fake!.url.replace(/\/v1$/, "")
  writeFileSync(join(paths.config, "lembas.json"), JSON.stringify({ instances: { example: { base_url: url, connection: "example", logged_in_at: "", ...(o.protocols ? { protocols: o.protocols } : {}) } } }))
  writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  example:\n    type: webui\n    url: ${url}\n    api_key: "{file:${key}}"\n${extra}`, { mode: 0o600 })
  writeCache("example", { fetched_at: new Date().toISOString(), url, models: models.map((id) => ({ id, ...(id.includes("/") && !o.noProvider ? { provider: id.split("/")[0] } : {}) })) })
}

test("logged in: the model is deepseek/deepseek-flash everywhere, requests go to the instance with the served id", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "from the instance" })] }])
  loggedIn(["deepseek/deepseek-flash", "llama/bonsai"])
  // An old config's ref: still the same model, and the file says the new one now.
  writeFileSync(join(paths.config, "config.yaml"), "# mine\nmodel: example/deepseek-flash\n")
  const loaded = loadConfig()
  expect(loaded.config.model).toBe("deepseek/deepseek-flash")
  expect(readFileSync(join(paths.config, "config.yaml"), "utf8")).toBe("# mine\nmodel: deepseek/deepseek-flash\n")
  const m = resolveModel(loaded, "deepseek/deepseek-flash")
  expect(m).toMatchObject({ ref: "deepseek/deepseek-flash", connectionName: "example", id: "deepseek/deepseek-flash" })
  expect(resolveModel(loaded, "example/deepseek/deepseek-flash").ref).toBe("deepseek/deepseek-flash")
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ph-refs-")))
  const app = createApp({ cwd, asker: { ask: async () => ({ kind: "once" }) }, store: false })
  expect(app.engine.model.ref).toBe("deepseek/deepseek-flash")
  expect(app.modelRefs()).toEqual(["deepseek/deepseek-flash", "llama/bonsai"])
  app.switchModel("example/bonsai")
  expect(app.engine.model.ref).toBe("llama/bonsai")
  app.switchModel("deepseek/deepseek-flash")
  await app.engine.prompt("hi")
  expect(fake.requests[0].model).toBe("deepseek/deepseek-flash")
  expect(fake.calls.at(-1)!.headers.authorization).toBe("Bearer lmb_key")
  await app.close()
})

test("a custom connection beside the login is read past, and said (2.0 has none)", () => {
  fake = fakeProvider([])
  loggedIn(["deepseek/deepseek-flash"], `  deepseek:\n    dialect: openai-chat\n    base_url: ${"http://127.0.0.1:9/v1"}\n    models: { deepseek-flash: {} }\n`)
  const loaded = loadConfig()
  expect(loaded.refs.map((r) => r.ref)).toEqual(["deepseek/deepseek-flash"])
  expect(resolveModel(loaded, "deepseek/deepseek-flash").connectionName).toBe("example")
  expect(loaded.warnings.some((w) => w.includes("deepseek is a custom connection"))).toBe(true)
})

function pair(): [Transport, Transport] {
  const make = () => ({ msg: (_: string) => {}, end: () => {} })
  const a = make()
  const b = make()
  const side = (me: typeof a, other: typeof a): Transport => ({ send: (t) => queueMicrotask(() => other.msg(t)), onMessage: (fn) => (me.msg = fn), onClose: (fn) => (me.end = fn), close: () => (me.end(), other.end()) })
  return [side(a, b), side(b, a)]
}

test("on the link: the instance names its model as served, the session reports the provider ref, and says it is the instance's", async () => {
  fake = fakeProvider([])
  loggedIn(["deepseek/deepseek-flash", "llama/bonsai"], `  local:\n    dialect: openai-chat\n    base_url: http://127.0.0.1:9/v1\n    models: { m: {} }\n`)
  writeFileSync(join(paths.config, "config.yaml"), "")
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ph-refs-")))
  setTrust(root, "trusted")
  const [ta, tb] = pair()
  new AcpAgent(new Peer(ta), { roots: [root], maxMode: "edit", approvalTimeoutMs: 1000, requireTrust: true }, "example")
  const c = new Peer(tb)
  const events: any[] = []
  c.on("_lembas/event", (p) => void events.push(p.event))
  c.on("session/update", () => {})
  const init: any = await c.request("initialize", { protocolVersion: 1, clientCapabilities: { _meta: { lembas: { protocol: 2 } } } })
  expect(init._meta.lembas.connection).toBe("example")
  const s: any = await c.request("session/new", { cwd: root, _meta: { lembas_model: "deepseek/deepseek-flash" } })
  expect(s._meta.lembas.model).toBe("deepseek/deepseek-flash")
  // An older instance's bare name, the same model.
  expect(await c.request<any>("_lembas/configure", { sessionId: s.sessionId, model: "bonsai" })).toMatchObject({ model: "llama/bonsai" })
  for (let i = 0; i < 50 && !events.some((e) => e.type === "model"); i++) await Bun.sleep(10)
  expect(events.find((e) => e.type === "model")).toMatchObject({ ref: "llama/bonsai", connection: "example", instance: true })
})

// The audit of 568923c.

test("an older form is rewritten, once, in place: anchors and comments stay", () => {
  fake = fakeProvider([])
  loggedIn(["deepseek/deepseek-flash", "llama/nomic-embed"])
  // The login's name in front: one server, so it is the same model, written the old way.
  writeFileSync(join(paths.config, "config.yaml"), "model: example/deepseek/deepseek-flash\n")
  expect(loadConfig().config.model).toBe("deepseek/deepseek-flash")
  expect(readFileSync(join(paths.config, "config.yaml"), "utf8")).toBe("model: deepseek/deepseek-flash\n")
  // The old form behind an anchor, with a comment: the scalar changes, nothing else.
  writeFileSync(join(paths.config, "config.yaml"), "model: &m example/deepseek-flash # my pick\nsmall_model: *m\nembedding: example/nomic-embed\n")
  const l = loadConfig()
  expect(readFileSync(join(paths.config, "config.yaml"), "utf8")).toBe("model: &m deepseek/deepseek-flash # my pick\nsmall_model: *m\nembedding: example/nomic-embed\n")
  expect(l.config.small_model).toBe("deepseek/deepseek-flash")
  // embedding as written (its name keys the stored vectors), and it still resolves.
  expect(l.config.embedding).toBe("example/nomic-embed")
  expect(embedderFor(l, l.config.embedding)?.model).toBe("example/nomic-embed")
  expect(embedderFor(l, "llama/nomic-embed")).toBeDefined()
  // Once: written back the old way by hand, it is not rewritten again (it still resolves).
  writeFileSync(join(paths.config, "config.yaml"), "model: example/deepseek-flash\n")
  expect(loadConfig().config.model).toBe("deepseek/deepseek-flash")
  expect(readFileSync(join(paths.config, "config.yaml"), "utf8")).toBe("model: example/deepseek-flash\n")
  expect(existsSync(join(paths.state, "migrations.json"))).toBe(true)
})

test("a models: override keyed by the old bare name lands on the served model; no phantom appears", () => {
  fake = fakeProvider([])
  loggedIn(["deepseek/deepseek-flash"], "    models: { deepseek-flash: { context: 1000 }, upcoming: { context: 5 } }\n")
  writeFileSync(join(paths.config, "config.yaml"), "model: example/deepseek-flash\n")
  const l = loadConfig()
  expect(l.refs.map((r) => r.ref)).toEqual(["deepseek/deepseek-flash", "upcoming"])
  const m = resolveModel(l, l.config.model)
  expect(m).toMatchObject({ id: "deepseek/deepseek-flash", spec: { context: 1000 } })
})

test("_lembas/configure naming a terminal session's own model (as the instance serves it) keeps its effort", async () => {
  fake = fakeProvider([])
  mkdirSync(join(paths.config, "lembas"), { recursive: true })
  const key = join(paths.config, "lembas", "example.key")
  writeFileSync(key, "lmb_key\n", { mode: 0o600 })
  const url = fake.url.replace(/\/v1$/, "")
  writeFileSync(join(paths.config, "lembas.json"), JSON.stringify({ instances: { example: { base_url: url, connection: "example", logged_in_at: "" } } }))
  writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  example:\n    type: webui\n    url: ${url}\n    api_key: "{file:${key}}"\n`, { mode: 0o600 })
  writeCache("example", { fetched_at: new Date().toISOString(), url, models: [{ id: "deepseek/deepseek-flash", provider: "deepseek", efforts: ["low", "high"], effort: "low" }] })
  writeFileSync(join(paths.config, "config.yaml"), "model: deepseek/deepseek-flash\n")
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ph-refs-")))
  Bun.spawnSync(["git", "init", "-q", root])
  setTrust(root, "trusted")
  const limits = { roots: [root], maxMode: "auto" as const, approvalTimeoutMs: 3000, requireTrust: true }
  const hub = new Hub({ service: true, limits: { ...limits, enabled: true } })
  expect(await hub.listen()).toBe(true)
  const [ta, tb] = pair()
  new AcpAgent(new Peer(ta), limits, "example", hub)
  const c = new Peer(tb)
  const heard: any[] = []
  c.on("_lembas/session/announce", (p) => void heard.push(p))
  c.on("_lembas/event", () => {})
  c.on("session/update", () => {})
  await c.request("initialize", { protocolVersion: 1, clientCapabilities: { _meta: { lembas: { protocol: 2 } } } })
  const app = createApp({ cwd: root, modelTitles: false, asker: { ask: async () => ({ kind: "once" }) } })
  const share = new Share(app, { prompt: async () => "stop", compact: async () => "", deleted: () => {}, notice: () => {}, changed: () => {} })
  await share.start()
  try {
    for (let i = 0; i < 300 && !heard.length; i++) await Bun.sleep(10)
    expect(heard[0]).toMatchObject({ model: "deepseek/deepseek-flash", instance: true })
    app.engine.effort = "high"
    const r: any = await c.request("_lembas/configure", { sessionId: app.engine.sessionId, model: "deepseek/deepseek-flash" })
    expect(r).toEqual({ model: "deepseek/deepseek-flash", effort: "high" })
  } finally {
    share.close()
    hub.close()
    await app.close()
  }
})
