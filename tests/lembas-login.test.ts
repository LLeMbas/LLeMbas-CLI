// /login against a fake LLeMbas, and the webui connection it writes: found by its
// discovery document, signed in by device code, one connection named after the instance with the key
// in a 0600 file — and the models, their settings, the voice and the search read from the instance
// at every start rather than copied into the config. `logout` revokes and removes exactly that.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parse } from "yaml"
import { loadConfig } from "../src/config/load.ts"
import { paths } from "../src/config/paths.ts"
import { normalise, PROTOCOL } from "../src/lembas/client.ts"
import { codeEvent, codeInstructions, doneEvent, instances, keyFile, login, logout, specFor, sync } from "../src/lembas/login.ts"
import { cacheFile, refreshWebui } from "../src/lembas/webui.ts"
import { resolveModel } from "../src/provider/index.ts"
import { search } from "../src/search/index.ts"
import { webuiFetch } from "../src/search/webui.ts"
import { wav } from "../src/voice/audio.ts"
import { synthesize, transcribe } from "../src/voice/speech.ts"

interface Fake {
  url: string
  stop(): void
  polls: number
  revoked: string[]
  /** What each DELETE /api/v1/token said it was replaced by. */
  replacedBy: (string | undefined)[]
  models: unknown[]
  approveAfter: number
  deny?: boolean
  protocol: number
  /** As an instance that gives no name and has no /api/v1/instance. */
  old?: boolean
  services: { stt?: boolean; tts?: boolean; search?: boolean; fetch?: boolean }
  heard: { path: string; auth: string | null; body?: any; fields?: Record<string, string> }[]
  token: string
}

let fake: Fake | undefined
let others: { stop(b?: boolean): void }[] = []
afterEach(() => {
  fake?.stop()
  for (const s of others) s.stop(true)
  others = []
})
beforeEach(() => {
  rmSync(paths.config, { recursive: true, force: true })
  rmSync(paths.state, { recursive: true, force: true })
  mkdirSync(paths.config, { recursive: true })
})

function lembas(o: Partial<Pick<Fake, "approveAfter" | "deny" | "protocol" | "models" | "old" | "services">> = {}): Fake {
  const state: Fake = {
    url: "",
    stop: () => {},
    polls: 0,
    revoked: [],
    replacedBy: [],
    approveAfter: o.approveAfter ?? 1,
    deny: o.deny,
    protocol: o.protocol ?? PROTOCOL,
    old: o.old,
    services: o.services ?? { stt: true, tts: true, search: true, fetch: true },
    heard: [],
    token: "lmb_secret",
    models: o.models ?? [
      { id: "gemma", object: "model", context: 32768, vision: true, capacity: { group: "gpu", single_session: true } },
      { id: "qwen", object: "model", name: "Qwen", context: 131072, temperature: 0.6, top_p: 0.95, efforts: ["low", "high"], tools: true, capacity: { group: "gpu" }, default: true },
    ],
  }
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url)
      const base = `http://${u.host}`
      const auth = req.headers.get("authorization")
      const ours = auth === `Bearer ${state.token}`
      if (u.pathname === "/.well-known/lembas.json")
        return Response.json({
          service: "lembas",
          version: state.old ? "1.20.0" : "1.21.0",
          ...(state.old ? {} : { name: "Example", connection: "example" }),
          protocol: state.protocol,
          harness_spec: "1.3.0",
          base_url: base,
          api: { openai: `${base}/v1` },
          login: { device: { code: `${base}/api/device/code`, token: `${base}/api/device/token`, verify: `${base}/device` } },
        })
      if (u.pathname === "/api/device/code") {
        const body = (await req.json()) as Record<string, string>
        expect(body.client_id).toStartWith("lembas-cli ")
        expect(body.scope).toBe("models library link")
        return Response.json({ device_code: "dev-123", user_code: "CDFG-HJKM", verification_uri: `${base}/device`, verification_uri_complete: `${base}/device?code=CDFG-HJKM`, expires_in: 600, interval: 1 })
      }
      if (u.pathname === "/api/device/token") {
        const body = (await req.json()) as Record<string, string>
        expect(body.device_code).toBe("dev-123")
        state.polls++
        if (state.deny) return Response.json({ error: "access_denied" }, { status: 400 })
        if (state.polls <= state.approveAfter) return Response.json({ error: "authorization_pending" }, { status: 400 })
        return Response.json({ access_token: state.token, token_type: "Bearer", scope: "models", account: { email: "frodo@shire.test", name: "Frodo" } })
      }
      if (u.pathname === "/api/v1/token" && req.method === "DELETE") {
        state.revoked.push(auth ?? "")
        const text = await req.text()
        state.replacedBy.push(text ? (JSON.parse(text) as { replaced_by?: string }).replaced_by : undefined)
        return new Response(null, { status: 204 })
      }
      if (!ours) return new Response("no", { status: 401 })
      if (u.pathname === "/v1/models") return Response.json({ object: "list", data: state.models })
      if (u.pathname === "/api/v1/instance") {
        if (state.old) return new Response("not found", { status: 404 })
        const def = (state.models as { id: string; default?: boolean }[]).find((m) => m.default)?.id ?? null
        return Response.json({ service: "lembas", version: "1.21.0", name: "Example", connection: "example", default_model: def, services: state.services })
      }
      if (u.pathname === "/v1/audio/transcriptions") {
        const f = await req.formData()
        const fields: Record<string, string> = {}
        for (const [k, v] of f.entries()) fields[k] = typeof v === "string" ? v : `file:${(v as File).size}`
        state.heard.push({ path: u.pathname, auth, fields })
        return Response.json({ text: "Speak friend and enter." })
      }
      if (u.pathname === "/v1/audio/speech") {
        state.heard.push({ path: u.pathname, auth, body: await req.json() })
        return new Response(wav(new Uint8Array(320)))
      }
      if (u.pathname === "/api/v1/search") {
        state.heard.push({ path: u.pathname, auth, body: await req.json() })
        return Response.json({ provider: "searxng", results: [{ title: "Lembas", url: "https://example.org/l", snippet: "Waybread." }] })
      }
      if (u.pathname === "/api/v1/fetch") {
        state.heard.push({ path: u.pathname, auth, body: await req.json() })
        return Response.json({ url: "https://example.org/l", title: "Lembas", text: "Waybread of the elves." })
      }
      return new Response("not found", { status: 404 })
    },
  })
  state.url = `http://127.0.0.1:${server.port}`
  state.stop = () => server.stop(true)
  return state
}

const quick = { sleep: () => Promise.resolve() }
const conns = () => parse(readFileSync(join(paths.config, "connections.yaml"), "utf8")).connections
const cfg = () => (existsSync(join(paths.config, "config.yaml")) ? (parse(readFileSync(join(paths.config, "config.yaml"), "utf8")) ?? {}) : {})

test("an address becomes a base: https unless it says http, no path", () => {
  expect(normalise("ai.example.org")).toBe("https://ai.example.org")
  expect(normalise("http://10.1.2.5:8080/chat/x")).toBe("http://10.1.2.5:8080")
  expect(() => normalise("")).toThrow()
})

test("the code is shown as a link and as a code for User → Security → Devices", async () => {
  fake = lembas()
  let shown = ""
  await login(fake.url, { ...quick, onCode: (s, d) => (shown = codeInstructions(s, d)) })
  expect(shown).toContain(`Found Example (LLeMbas 1.21.0) at ${fake.url}`)
  expect(shown).toContain(`1. Click the link: ${fake.url}/device?code=CDFG-HJKM`)
  expect(shown).toContain("2. Copy the code CDFG-HJKM into User → Security → Devices")
})

test("--json: the code and the outcome, each one line a program can read", async () => {
  fake = lembas()
  const lines: string[] = []
  const r = await login(fake.url, { ...quick, onCode: (s, d) => lines.push(JSON.stringify(codeEvent(s, d))) })
  lines.push(JSON.stringify(doneEvent(r, true)))
  const [code, done] = lines.map((l) => JSON.parse(l))
  expect(lines.every((l) => !l.includes("\n"))).toBe(true)
  expect(code).toMatchObject({ event: "code", user_code: "CDFG-HJKM", verification_uri_complete: `${fake.url}/device?code=CDFG-HJKM` })
  expect(code.instance).toEqual({ name: "Example", version: "1.21.0", base_url: fake.url })
  expect(done).toMatchObject({ event: "done", fresh: true, connection: "example", base_url: fake.url, models: 2 })
  // The key never appears in what is printed.
  expect(lines.join("")).not.toContain("lmb_secret")
})

test("login writes one webui connection named after the instance, and no models", async () => {
  fake = lembas()
  const r = await login(fake.url, { ...quick, onCode: () => {} })
  expect(fake.polls).toBe(2) // pending once, then the token
  expect(r.connection).toBe("example")
  expect(conns().example).toEqual({ type: "webui", url: fake.url, api_key: `{file:${keyFile("example")}}` })
  expect(readFileSync(keyFile("example"), "utf8").trim()).toBe("lmb_secret")
  expect(statSync(keyFile("example")).mode & 0o777).toBe(0o600)
  // No model was pinned: sessions start on the instance's default.
  expect(cfg().model).toBeUndefined()
  expect(r.instanceDefault).toBe("qwen")
  expect(instances().example!.instance_name).toBe("Example")

  const loaded = loadConfig()
  const c = loaded.connections.example!
  expect(c.dialect).toBe("openai-chat")
  expect(c.base_url).toBe(`${fake.url}/v1`)
  expect(c.api_key).toBe("lmb_secret")
  // The instance's models with its settings, the default first; the group named after the connection.
  expect(Object.keys(c.models)).toEqual(["qwen", "gemma"])
  expect(c.models.qwen).toEqual({ name: "Qwen", context: 131072, temperature: 0.6, top_p: 0.95, efforts: ["low", "high"], tools: true, group: "example:gpu" })
  expect(c.models.gemma).toEqual({ context: 32768, vision: true, single_session: true, group: "example:gpu" })
  expect(resolveModel(loaded, undefined).ref).toBe("example/qwen")
})

test("a model changed on the instance is here at the next start, without logging in again", async () => {
  fake = lembas()
  await login(fake.url, { ...quick, onCode: () => {} })
  fake.models = [{ id: "llama", object: "model", context: 8192, default: true }]
  const r = await refreshWebui()
  expect(r).toEqual([{ name: "example", ok: true, models: 1 }])
  const loaded = loadConfig()
  expect(Object.keys(loaded.connections.example!.models)).toEqual(["llama"])
  expect(resolveModel(loaded, undefined).ref).toBe("example/llama")
  // A model the instance does not list yet is still asked for, not refused here.
  expect(resolveModel(loaded, "example/brand-new").id).toBe("brand-new")
})

test("an instance that does not answer leaves what it said last, and says so", async () => {
  fake = lembas()
  await login(fake.url, { ...quick, onCode: () => {} })
  fake.stop()
  const r = await refreshWebui({ timeoutMs: 1000 })
  expect(r[0]!.ok).toBe(false)
  const loaded = loadConfig()
  expect(Object.keys(loaded.connections.example!.models)).toEqual(["qwen", "gemma"])
  expect(loaded.warnings.join("\n")).toContain("example: the instance could not be asked for its models")
  fake = undefined
})

test("the entry's own models: go over the instance's", async () => {
  fake = lembas()
  await login(fake.url, { ...quick, onCode: () => {} })
  const text = readFileSync(join(paths.config, "connections.yaml"), "utf8").replace(`url: ${fake.url}`, `url: ${fake.url}\n    models:\n      qwen: { context: 65536 }`)
  writeFileSync(join(paths.config, "connections.yaml"), text, { mode: 0o600 })
  const c = loadConfig().connections.example!
  expect(c.models.qwen!.context).toBe(65536)
  expect(c.models.qwen!.tools).toBe(true)
})

test("an instance that gives no name is named after its host", async () => {
  fake = lembas({ old: true })
  const r = await login(fake.url, { ...quick, onCode: () => {} })
  expect(r.connection).toBe("127-0-0-1")
  expect(r.changes).toEqual([])
  // Its default comes from /v1/models: still first.
  expect(Object.keys(loadConfig().connections["127-0-0-1"]!.models)).toEqual(["qwen", "gemma"])
})

test("a hand-written connection of the same name is never overwritten", async () => {
  writeFileSync(join(paths.config, "connections.yaml"), "connections:\n  example:\n    dialect: ollama\n    base_url: http://x\n    models: {}\n", { mode: 0o600 })
  fake = lembas()
  const r = await login(fake.url, { ...quick, onCode: () => {} })
  expect(r.connection).toBe("example-lembas")
  expect(conns().example.dialect).toBe("ollama")
})

test("an older kind of login is replaced: the old connection, its key and its pinned default go", async () => {
  fake = lembas()
  writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  ai:\n    dialect: openai-chat\n    base_url: ${fake.url}/v1\n    api_key: "{file:${keyFile("ai")}}"\n    models: { qwen: {}, gemma: {} }\n  local:\n    dialect: openai-chat\n    base_url: http://x/v1\n    models: { m: {} }\n`, { mode: 0o600 })
  mkdirSync(join(paths.config, "lembas"), { recursive: true })
  writeFileSync(keyFile("ai"), "lmb_old\n", { mode: 0o600 })
  writeFileSync(join(paths.config, "lembas.json"), JSON.stringify({ instances: { ai: { base_url: fake.url, connection: "ai", logged_in_at: "2026-10-07T10:00:00Z" } } }))
  writeFileSync(join(paths.config, "config.yaml"), "model: ai/qwen\nsmall_model: ai/gemma\n")

  const r = await login(fake.url, { ...quick, onCode: () => {} })
  expect(r.connection).toBe("example")
  expect(Object.keys(conns()).sort()).toEqual(["example", "local"])
  expect(existsSync(keyFile("ai"))).toBe(false)
  expect(fake.revoked).toEqual(["Bearer lmb_old"])
  expect(Object.keys(instances())).toEqual(["example"])
  const c = cfg()
  // It was the instance's default, so the instance decides it now; the rest follow the new name.
  expect(c.model).toBeUndefined()
  expect(c.small_model).toBe("example/gemma")
  expect(r.changes.join("\n")).toContain("the connection ai from an earlier login is now example")
})

test("voice and search go through the instance, and what was set up becomes the fallback", async () => {
  writeFileSync(join(paths.config, "config.yaml"), "voice:\n  stt:\n    provider: openai\n    base_url: http://stt.local/v1\nsearch:\n  searxng:\n    base_url: http://search.local\n")
  fake = lembas()
  const r = await login(fake.url, { ...quick, onCode: () => {} })
  const c = cfg()
  expect(c.voice.stt).toEqual({ provider: "webui", fallback: { provider: "openai", base_url: "http://stt.local/v1" } })
  expect(c.voice.tts).toEqual({ provider: "webui" })
  expect(c.search.order).toEqual(["webui", "searxng", "ddg"])
  expect(r.changes.some((x) => x.startsWith("voice input through example"))).toBe(true)

  // Loaded, webui is the instance's /v1 with this machine's key.
  const v = loadConfig().config.voice!
  expect(v.stt!.base_url).toBe(`${fake.url}/v1`)
  expect(v.stt!.api_key).toBe("lmb_secret")
  expect(await transcribe(v, wav(new Uint8Array(3200)))).toBe("Speak friend and enter.")
  const heard = fake.heard.find((h) => h.path === "/v1/audio/transcriptions")!
  expect(heard.auth).toBe("Bearer lmb_secret")
  // The instance's own model, whatever: none is sent.
  expect(heard.fields!.model).toBeUndefined()

  await synthesize(v, "Mellon.")
  const said = fake.heard.find((h) => h.path === "/v1/audio/speech")!.body
  // The account's own voice and speed, on the instance.
  expect(said).toEqual({ input: "Mellon.", response_format: "wav" })
})

test("an instance that is down falls back to the voice that was there before", async () => {
  const local = Bun.serve({ port: 0, fetch: () => Response.json({ text: "from the fallback" }) })
  others.push(local)
  writeFileSync(join(paths.config, "config.yaml"), `voice:\n  stt:\n    provider: openai\n    base_url: http://127.0.0.1:${local.port}/v1\n`)
  fake = lembas()
  await login(fake.url, { ...quick, onCode: () => {} })
  const v = loadConfig().config.voice!
  fake.stop()
  fake = undefined
  expect(await transcribe(v, wav(new Uint8Array(3200)))).toBe("from the fallback")
})

test("web search and fetch through the instance", async () => {
  fake = lembas()
  await login(fake.url, { ...quick, onCode: () => {} })
  const s = loadConfig().config.search!
  const r = await search("lembas", s, new AbortController().signal)
  expect(r.provider).toBe("webui")
  expect(r.results).toEqual([{ title: "Lembas", url: "https://example.org/l", snippet: "Waybread." }])
  expect(fake.heard.find((h) => h.path === "/api/v1/search")!.auth).toBe("Bearer lmb_secret")
  const page = await webuiFetch("https://example.org/l", s, new AbortController().signal)
  expect(page.text).toBe("Waybread of the elves.")
})

test("what the instance does not offer is left alone", async () => {
  fake = lembas({ services: { stt: false, tts: false, search: false, fetch: false } })
  const r = await login(fake.url, { ...quick, onCode: () => {} })
  expect(cfg().voice).toBeUndefined()
  expect(cfg().search).toBeUndefined()
  expect(r.changes).toEqual([])
})

test("webui with no webui connection is off, with a warning", () => {
  writeFileSync(join(paths.config, "config.yaml"), "voice:\n  tts:\n    provider: webui\nsearch:\n  order: [webui, ddg]\n")
  const loaded = loadConfig()
  expect(loaded.config.voice?.tts).toBeUndefined()
  expect(loaded.config.search?.webui).toBeUndefined()
  expect(loaded.warnings.join("\n")).toContain("there is no webui connection (lembas login)")
})

test("login again reads the models now", async () => {
  fake = lembas()
  await login(fake.url, { ...quick, onCode: () => {} })
  fake.models = [{ id: "llama", object: "model", context: 8192 }]
  const again = await sync("example")
  expect(again.models.map((m) => m.id)).toEqual(["llama"])
  expect(JSON.parse(readFileSync(cacheFile("example"), "utf8")).models[0].id).toBe("llama")
})

test("login again signs the old token out, naming the new one, so its chats follow", async () => {
  fake = lembas()
  await login(fake.url, { ...quick, onCode: () => {} })
  fake.token = "lmb_newer"
  fake.polls = 0
  const r = await login(fake.url, { ...quick, onCode: () => {} })
  expect(fake.revoked).toEqual(["Bearer lmb_secret"])
  expect(fake.replacedBy).toEqual(["lmb_newer"])
  expect(readFileSync(keyFile(r.connection), "utf8").trim()).toBe("lmb_newer")
  expect(r.changes.join("\n")).not.toContain("could not be signed out")
})

test("a CA given as a relative path is kept as a full one", async () => {
  fake = lembas()
  const dir = join(paths.config, "certs")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "ca.crt"), "-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n")
  const cwd = process.cwd()
  process.chdir(paths.config)
  try {
    const r = await login(fake.url, { ...quick, ca: "certs/ca.crt", onCode: () => {} })
    expect(instances()[r.connection]!.ca).toBe(join(dir, "ca.crt"))
  } finally {
    process.chdir(cwd)
  }
})

test("logout revokes the token and removes exactly what login wrote", async () => {
  writeFileSync(join(paths.config, "connections.yaml"), "connections:\n  local:\n    dialect: openai-chat\n    base_url: http://x/v1\n    models: { m: {} }\n", { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), "voice:\n  stt:\n    provider: openai\n    base_url: http://stt.local/v1\n")
  fake = lembas()
  const r = await login(fake.url, { ...quick, onCode: () => {} })
  const out = await logout(r.connection)
  expect(out.revoked).toBe(true)
  expect(fake.revoked).toEqual(["Bearer lmb_secret"])
  expect(existsSync(keyFile(r.connection))).toBe(false)
  expect(existsSync(cacheFile(r.connection))).toBe(false)
  expect(Object.keys(conns())).toEqual(["local"])
  expect(instances()).toEqual({})
  // Voice is what it was before the login; search no longer asks the instance.
  const c = cfg()
  expect(c.voice.stt).toEqual({ provider: "openai", base_url: "http://stt.local/v1" })
  expect(c.voice.tts).toBeUndefined()
  expect(c.search.order).toEqual(["ddg"])
})

test("a denial, another service, and another protocol are each said plainly", async () => {
  fake = lembas({ deny: true })
  await expect(login(fake.url, { ...quick, onCode: () => {} })).rejects.toThrow("denied")
  fake.stop()

  fake = lembas({ protocol: PROTOCOL + 1 })
  await expect(login(fake.url, { ...quick, onCode: () => {} })).rejects.toThrow("device protocol")
  fake.stop()

  const other = Bun.serve({ port: 0, fetch: () => new Response("hello", { status: 404 }) })
  try {
    await expect(login(`http://127.0.0.1:${other.port}`, { ...quick, onCode: () => {} })).rejects.toThrow("not a LLeMbas instance")
  } finally {
    other.stop(true)
  }
  expect(existsSync(join(paths.config, "connections.yaml"))).toBe(false)
})

test("specFor leaves out what the instance did not say", () => {
  expect(specFor({ id: "x" }, "ai")).toEqual({})
  expect(specFor({ id: "x", name: "x", tools: false }, "ai")).toEqual({ tools: false })
  expect(specFor({ id: "x", temperature: 7 }, "ai")).toEqual({})
})

test("only chat models are models; the first embedding one becomes the library's, never over one set", async () => {
  fake = lembas({
    models: [
      { id: "llama/qwen", object: "model", kind: "chat", provider: "llama", default: true },
      { id: "llama/gemma", object: "model", provider: "llama" },
      { id: "llama/nomic-embed", object: "model", kind: "embedding", provider: "llama" },
      { id: "llama/bge", object: "model", kind: "embedding", provider: "llama" },
      { id: "llama/whisper", object: "model", kind: "stt", provider: "llama" },
      { id: "llama/kokoro", object: "model", kind: "tts", provider: "llama" },
      { id: "llama/flux", object: "model", kind: "image", provider: "llama" },
    ],
  })
  const r = await login(fake.url, { ...quick, onCode: () => {} })
  expect(r.models.map((m) => m.id)).toEqual(["llama/qwen", "llama/gemma"])
  expect(cfg().embedding).toBe("example/llama/nomic-embed")
  expect(r.changes).toContain("the library embeds with example/llama/nomic-embed (embedding:)")
  const loaded = loadConfig()
  expect(Object.keys(loaded.connections.example!.models)).toEqual(["llama/qwen", "llama/gemma"])
  expect(loaded.refs.map((x) => x.id)).not.toContain("llama/whisper")
  // The embedding model resolves, written either way.
  const { embedderFor } = await import("../src/library/embed.ts")
  expect(embedderFor(loaded, "example/llama/nomic-embed")?.model).toBe("example/llama/nomic-embed")
  expect(embedderFor(loaded, "llama/bge")?.model).toBe("llama/bge")
  // Set already — by hand, to something else: logging in again leaves it.
  writeFileSync(join(paths.config, "config.yaml"), "embedding: local/mine\n")
  const again = await sync("example")
  expect(cfg().embedding).toBe("local/mine")
  expect(again.changes).toEqual([])
  // Logout takes out only an embedding on its own connection.
  writeFileSync(join(paths.config, "config.yaml"), "embedding: example/llama/nomic-embed\n")
  await logout("example")
  expect(cfg().embedding).toBeUndefined()
})
