// The account on a LLeMbas instance: /v1/usage for the status bar and /usage, the
// personalization read from /v1/me/personalization in place of the local keys and written back by
// /settings, and the account's library as the default when the login may read it. A fake instance;
// the instance index, keys and caches are removed after each test (the suite shares one home).
import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createApp } from "../src/app.ts"
import { loadConfig } from "../src/config/load.ts"
import { paths } from "../src/config/paths.ts"
import { personalization, savePersonalization, usage, type Personalization, type Usage } from "../src/lembas/client.ts"
import { accountUsage, defaultLibrary, spendLabel, usageLines } from "../src/lembas/personal.ts"
import { fetchWebui } from "../src/lembas/webui.ts"
import { fakeProvider, type Fake } from "./fake-provider.ts"

interface Instance {
  url: string
  usage: Usage | null
  personal: Personalization | null
  puts: unknown[]
  forbid: boolean
  stop(): void
}

let inst: Instance | undefined
let model: Fake | undefined

function instance(o: Partial<Pick<Instance, "usage" | "personal" | "forbid">> = {}): Instance {
  const state: Instance = {
    url: "",
    // The server's 2.0 answer: the credit fields null, `windows` empty, money per currency.
    usage: o.usage === undefined ? ({ plan: null, balance: null, balance_money: null, month: { from: "2026-10-01T00:00:00Z", tokens_in: 120000, tokens_out: 30000, cost: null, cost_money: 3.7656, cost_by_currency: { USD: 3.7656 } }, device: { tokens_in: 1000, tokens_out: 500, cost: null, cost_money: null }, windows: [], currency: "USD", admin: false, unit: "money" } as Usage) : o.usage,
    personal: o.personal === undefined ? { enabled: true, available: true, personality: "funny", personality_custom: "", instructions: "Answer in Slovak." } : o.personal,
    puts: [],
    forbid: o.forbid ?? false,
    stop: () => {},
  }
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url)
      if (req.headers.get("authorization") !== "Bearer lmb_key") return new Response("no", { status: 401 })
      if (u.pathname === "/v1/models") return Response.json({ data: [{ id: "big", context: 8192 }] })
      if (u.pathname === "/api/v1/instance") return Response.json({ name: "Example", connection: "example", default_model: "big", services: {} })
      if (u.pathname === "/v1/usage") return state.usage ? Response.json(state.usage) : new Response("not found", { status: 404 })
      if (u.pathname === "/v1/me/personalization") {
        if (!state.personal) return new Response("not found", { status: 404 })
        if (req.method === "PUT") {
          if (state.forbid) return new Response("no", { status: 403 })
          const body = (await req.json()) as Personalization
          state.puts.push(body)
          state.personal = { ...state.personal!, ...body, available: true }
        }
        return Response.json(state.personal)
      }
      return new Response("not found", { status: 404 })
    },
  })
  state.url = `http://127.0.0.1:${server.port}`
  state.stop = () => server.stop(true)
  return state
}

/** This machine logged in to it, as `lembas login` leaves things. */
function loggedIn(i: Instance, scope = "models library link") {
  mkdirSync(join(paths.config, "lembas"), { recursive: true })
  writeFileSync(join(paths.config, "lembas", "example.key"), "lmb_key\n", { mode: 0o600 })
  writeFileSync(join(paths.config, "lembas.json"), JSON.stringify({ instances: { example: { base_url: i.url, connection: "example", scope, logged_in_at: new Date().toISOString() } } }))
}

beforeEach(() => {
  rmSync(join(paths.config, "lembas.json"), { force: true })
  rmSync(join(paths.config, "lembas"), { recursive: true, force: true })
  rmSync(join(paths.state, "webui"), { recursive: true, force: true })
})
afterEach(() => {
  inst?.stop()
  model?.stop()
  inst = undefined
  model = undefined
  rmSync(join(paths.config, "lembas.json"), { force: true })
  rmSync(join(paths.config, "lembas"), { recursive: true, force: true })
  rmSync(join(paths.state, "webui"), { recursive: true, force: true })
})

test("/v1/usage: read, as the month's cost for the status bar and lines for /usage", async () => {
  inst = instance()
  const u = await usage(inst.url, "lmb_key", undefined)
  expect(spendLabel(u)).toBe("$3.77 this month")
  expect(usageLines("example", u!)).toEqual([
    "example",
    "this month (since 2026-10-01): 120,000 tokens in, 30,000 out — $3.77",
    "this device: 1,000 in, 500 out",
  ])
  // Nothing priced: the tokens alone, and nothing in the status bar.
  const free: Usage = { ...u!, month: { ...u!.month, cost_money: 0, cost_by_currency: {} } }
  expect(usageLines("example", free)).toEqual([
    "example",
    "this month (since 2026-10-01): 120,000 tokens in, 30,000 out",
    "this device: 1,000 in, 500 out",
  ])
  expect(spendLabel(free)).toBe("")
  expect(spendLabel(undefined)).toBe("")
  loggedIn(inst)
  expect((await accountUsage())?.usage.month.tokens_in).toBe(120000)
})

test("an instance without the endpoints: no usage, no personalization, no error", async () => {
  inst = instance({ usage: null, personal: null })
  expect(await usage(inst.url, "lmb_key", undefined)).toBeUndefined()
  expect(await personalization(inst.url, "lmb_key", undefined)).toBeUndefined()
  loggedIn(inst)
  expect(await accountUsage()).toBeUndefined()
})

test("logged in, the account's personalization is used instead of the local keys", async () => {
  inst = instance()
  writeFileSync(join(paths.config, "config.yaml"), "personality: formal\ninstructions: local words\n")
  // Logged out: the local keys.
  expect(loadConfig().config).toMatchObject({ personality: "formal", instructions: "local words" })
  loggedIn(inst)
  await fetchWebui("example", inst.url, "lmb_key", undefined)
  const loaded = loadConfig()
  expect(loaded.config).toMatchObject({ personality: "funny", instructions: "Answer in Slovak." })
  expect(loaded.personalFrom).toBe("example")
  // Switched off there by the person: none of it.
  inst.personal = { ...inst.personal!, enabled: false }
  await fetchWebui("example", inst.url, "lmb_key", undefined)
  expect(loadConfig().config).toMatchObject({ personality: "", instructions: "" })
  // Not allowed by the administrator: the local keys again.
  inst.personal = { ...inst.personal!, available: false }
  await fetchWebui("example", inst.url, "lmb_key", undefined)
  expect(loadConfig().config).toMatchObject({ personality: "formal", instructions: "local words" })
  expect(loadConfig().personalFrom).toBeUndefined()
})

test("/settings writes the personalization to the account, not to config.yaml", async () => {
  inst = instance()
  model = fakeProvider([])
  writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  f:\n    type: webui\n    url: ${model.url}\n    models: { f/m: {} }\n`, { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), "model: f/m\nlibrary: local\n")
  loggedIn(inst)
  await fetchWebui("example", inst.url, "lmb_key", undefined)
  const app = createApp({ cwd: paths.config, asker: { ask: async () => ({ kind: "once" }) }, store: false })
  const r = app.settings.set("personality", "socratic", "global")
  expect(r.message).toContain("on example")
  for (let i = 0; i < 100 && !inst.puts.length; i++) await Bun.sleep(10)
  // Only the field set, and on: never the session's copy of the other two.
  expect(inst.puts[0]).toEqual({ enabled: true, personality: "socratic" })
  expect(readFileSync(join(paths.config, "config.yaml"), "utf8")).not.toContain("socratic")
  // The session has it at once.
  expect(app.loaded.config.personality).toBe("socratic")
  await app.close()
})

test("a PUT the instance refuses is said, not swallowed", async () => {
  inst = instance({ forbid: true })
  await expect(savePersonalization(inst.url, "lmb_key", undefined, { enabled: true, personality: "" })).rejects.toThrow("not allowed")
  // The instance's own words where it says which of its two 403s it is, and a 422's.
  const said = Bun.serve({
    port: 0,
    async fetch(req) {
      const b = (await req.json()) as { enabled?: unknown }
      return typeof b.enabled !== "boolean" ? Response.json({ detail: "enabled must be true or false" }, { status: 422 }) : Response.json({ detail: "only a device's token may change this" }, { status: 403 })
    },
  })
  const url = `http://127.0.0.1:${said.port}`
  await expect(savePersonalization(url, "k", undefined, { enabled: true })).rejects.toThrow("the instance did not allow it: only a device's token may change this")
  await expect(savePersonalization(url, "k", undefined, { enabled: "yes" as never })).rejects.toThrow("would not take that personalization: enabled must be true or false")
  said.stop(true)
})

test("the library: the account's by default when the login may read it; an explicit local stays", () => {
  inst = instance()
  expect(defaultLibrary()).toBeUndefined()
  loggedIn(inst, "models link")
  expect(defaultLibrary()).toBeUndefined()
  loggedIn(inst, "models library link")
  expect(defaultLibrary()).toBe("lembas")
  writeFileSync(join(paths.config, "config.yaml"), "mode: manual\n")
  expect(loadConfig().config.library).toBe("lembas")
  writeFileSync(join(paths.config, "config.yaml"), "library: local\n")
  expect(loadConfig().config.library).toBe("local")
  rmSync(join(paths.config, "config.yaml"))
  expect(existsSync(join(paths.config, "config.yaml"))).toBe(false)
})

test("opted out on the web, or a preset the CLI does not know: setting one key here wipes nothing there", async () => {
  inst = instance({ personal: { enabled: false, available: true, personality: "pirate", personality_custom: "Arr.", instructions: "Answer in Slovak." } })
  model = fakeProvider([])
  writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  f:\n    type: webui\n    url: ${model.url}\n    models: { f/m: {} }\n`, { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), "model: f/m\nlibrary: local\n")
  loggedIn(inst)
  await fetchWebui("example", inst.url, "lmb_key", undefined)
  const app = createApp({ cwd: paths.config, asker: { ask: async () => ({ kind: "once" }) }, store: false })
  // Off there: none of it here.
  expect(app.loaded.config.instructions).toBe("")
  app.settings.set("instructions", "Be brief.", "global")
  for (let i = 0; i < 100 && !inst.puts.length; i++) await Bun.sleep(10)
  expect(inst.puts[0]).toEqual({ enabled: true, instructions: "Be brief." })
  // The instance kept what it had, the unknown preset included.
  expect(inst.personal).toMatchObject({ enabled: true, personality: "pirate", personality_custom: "Arr.", instructions: "Be brief." })
  // And the session now uses what the account has on (an unknown preset is none here).
  for (let i = 0; i < 100 && app.loaded.config.personality_custom !== "Arr."; i++) await Bun.sleep(10)
  expect(app.loaded.config).toMatchObject({ personality: "", personality_custom: "Arr.", instructions: "Be brief." })
  await app.close()
})

test("money per currency, never added together, and no credit wording", () => {
  const base: Usage = { month: { from: "2026-10-01T00:00:00Z", tokens_in: 1000, tokens_out: 200, cost_money: null, cost_by_currency: { USD: 0.75, EUR: 2 } }, device: { tokens_in: 10, tokens_out: 5 }, currency: "USD", unit: "money" }
  // Two currencies: each its own amount, `cost_money` null.
  expect(spendLabel(base)).toBe("€2.00 · $0.75 this month")
  expect(usageLines("example", base)).toEqual([
    "example",
    "this month (since 2026-10-01): 1,000 tokens in, 200 out — €2.00 · $0.75",
    "this device: 10 in, 5 out",
  ])
  // One currency, as `cost_money` alone (no breakdown sent): in `currency`.
  expect(spendLabel({ ...base, currency: "GBP", month: { ...base.month, cost_money: 1234.5, cost_by_currency: undefined } })).toBe("£1,234.50 this month")
  // An administrator is said so; the spend is the same.
  const admin: Usage = { ...base, admin: true }
  expect(usageLines("example", admin)[0]).toBe("example (administrator)")
  for (const line of [...usageLines("example", admin), spendLabel(admin)]) expect(line).not.toMatch(/credit|balance|plan|unlimited|window/)
})
