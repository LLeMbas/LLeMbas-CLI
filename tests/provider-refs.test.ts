// Models from a LLeMbas instance named by their provider: `deepseek/deepseek-flash`, not
// `example/deepseek-flash`. The old forms still resolve, a config naming one is rewritten, a
// connection of the user's own wins its name, two instances share a provider by login order, and an
// instance that does not speak protocol 2 (bare ids) keeps `<login>/<id>`. On the link, the model event and the
// announcement say whether the session's model is this link's instance's.
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

const conns = (o: Record<string, { webui?: boolean; models: string[] }>) =>
  Object.fromEntries(Object.entries(o).map(([n, c]) => [n, { dialect: "openai-chat", base_url: "http://x/v1", models: Object.fromEntries(c.models.map((m) => [m, {}])), ...(c.webui ? { webui: { url: "http://x", v2: true } } : {}) }])) as never

test("refs: by provider; a connection of the user's own wins its name; a bare id keeps the login", () => {
  const c = conns({ example: { webui: true, models: ["deepseek/deepseek-flash", "llama/bonsai", "old"] }, llama: { models: ["mine"] } })
  const refs = modelRefs(c, ["example"])
  expect(refs.map((r) => r.ref)).toEqual(["deepseek/deepseek-flash", "example/llama/bonsai", "example/old", "llama/mine"])
  // Every old way of writing them.
  expect(findRef(c, refs, "example/deepseek-flash")?.ref).toBe("deepseek/deepseek-flash")
  expect(findRef(c, refs, "example/deepseek/deepseek-flash")?.ref).toBe("deepseek/deepseek-flash")
  expect(findRef(c, refs, "example/bonsai")?.ref).toBe("example/llama/bonsai")
  expect(findRef(c, refs, "llama/mine")).toMatchObject({ connection: "llama", id: "mine" })
  expect(findRef(c, refs, "llama/bonsai")).toBeUndefined()
})

test("refs: two instances with one provider — the first logged in to keeps the short form", () => {
  const c = conns({ example: { webui: true, models: ["deepseek/a"] }, work: { webui: true, models: ["deepseek/a", "openai/b"] } })
  expect(modelRefs(c, ["example", "work"]).map((r) => r.ref)).toEqual(["deepseek/a", "work/deepseek/a", "openai/b"])
  expect(modelRefs(c, ["work", "example"]).map((r) => r.ref)).toEqual(["example/deepseek/a", "deepseek/a", "openai/b"])
  // A login named after its own provider: the same string either way.
  expect(modelRefs(conns({ llama: { webui: true, models: ["llama/bonsai"] } }), ["llama"]).map((r) => r.ref)).toEqual(["llama/bonsai"])
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

test("an instance that does not speak protocol 2 (bare ids): <login>/<id>", () => {
  fake = fakeProvider([])
  loggedIn(["deepseek-flash"])
  writeFileSync(join(paths.config, "config.yaml"), "model: example/deepseek-flash\n")
  const loaded = loadConfig()
  expect(loaded.refs.map((r) => r.ref)).toEqual(["example/deepseek-flash"])
  expect(resolveModel(loaded, undefined).ref).toBe("example/deepseek-flash")
  expect(readFileSync(join(paths.config, "config.yaml"), "utf8")).toBe("model: example/deepseek-flash\n")
})

test("a connection of the user's own named like a provider keeps it; the instance's is <login>/<provider>/<model>", () => {
  fake = fakeProvider([])
  loggedIn(["deepseek/deepseek-flash"], `  deepseek:\n    dialect: openai-chat\n    base_url: ${"http://127.0.0.1:9/v1"}\n    models: { deepseek-flash: {} }\n`)
  const loaded = loadConfig()
  expect(loaded.refs.map((r) => r.ref)).toEqual(["example/deepseek/deepseek-flash", "deepseek/deepseek-flash"])
  expect(resolveModel(loaded, "deepseek/deepseek-flash").connectionName).toBe("deepseek")
  expect(resolveModel(loaded, "example/deepseek/deepseek-flash").connectionName).toBe("example")
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

test("only the old <login>/<model> is rewritten, once, in place: a pinned long form, anchors and comments stay", () => {
  fake = fakeProvider([])
  loggedIn(["deepseek/deepseek-flash", "llama/nomic-embed"])
  // Pinned on purpose: means what it says, and is left alone.
  writeFileSync(join(paths.config, "config.yaml"), "model: example/deepseek/deepseek-flash\n")
  expect(loadConfig().config.model).toBe("example/deepseek/deepseek-flash")
  expect(readFileSync(join(paths.config, "config.yaml"), "utf8")).toBe("model: example/deepseek/deepseek-flash\n")
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

test("the provider: as the instance says it; from a protocol-2 instance, before the /; else the id is just an id", () => {
  fake = fakeProvider([])
  // Not protocol 2: an id with a / and no provider is `<login>/<id>`.
  loggedIn(["org/model-a"], "", { noProvider: true })
  expect(loadConfig().refs.map((r) => r.ref)).toEqual(["example/org/model-a"])
  // The instance speaks protocol 2: its ids are `<provider>/<model>`.
  loggedIn(["org/model-a"], "", { noProvider: true, protocols: [1, 2] })
  expect(loadConfig().refs.map((r) => r.ref)).toEqual(["org/model-a"])
  // `provider` said: used, whatever the protocol.
  loggedIn(["org/model-a"])
  expect(loadConfig().refs.map((r) => r.ref)).toEqual(["org/model-a"])
})

test("a models: override keyed by the old bare name lands on the served model; no phantom appears", () => {
  fake = fakeProvider([])
  loggedIn(["deepseek/deepseek-flash"], "    models: { deepseek-flash: { context: 1000 }, upcoming: { context: 5 } }\n")
  writeFileSync(join(paths.config, "config.yaml"), "model: example/deepseek-flash\n")
  const l = loadConfig()
  expect(l.refs.map((r) => r.ref)).toEqual(["deepseek/deepseek-flash", "example/upcoming"])
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
