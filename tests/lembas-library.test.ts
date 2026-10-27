// library: lembas (harness spec 3.0.0, acp.md *Memory*): the account's memory through the server's
// /mcp — its `memory` tool in place of this machine's, and its entries for the prompt from the
// resource lembas://memory — with the device token. Notes, knowledge bases and skills stay local.
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../src/app.ts"
import type { AskReply } from "../src/bus/index.ts"
import { paths } from "../src/config/paths.ts"

const stops: (() => void)[] = []
afterEach(() => {
  for (const s of stops.splice(0)) s()
})

function fakeLembasMcp(memory = "MEMORY (the account's)\nPrefers tabs.") {
  const calls: { auth: string; name?: string; args?: unknown; meta?: unknown; uri?: string }[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url)
      if (u.pathname !== "/mcp") return new Response("no", { status: 404 })
      if (req.method !== "POST") return new Response(null, { status: 405 })
      const msg = (await req.json()) as any
      const auth = req.headers.get("authorization") ?? ""
      if (auth !== "Bearer lmb_lib") return new Response("no", { status: 401 })
      if (msg.id === undefined) return new Response(null, { status: 202 })
      const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: msg.id, result })
      if (msg.method === "initialize") return reply({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: "lembas", version: "2.0.0" } })
      if (msg.method === "resources/read") {
        calls.push({ auth, uri: msg.params.uri, ...(msg.params._meta?.lembas ? { meta: msg.params._meta.lembas } : {}) })
        return reply({ contents: [{ uri: msg.params.uri, mimeType: "text/plain", text: msg.params.uri === "lembas://memory" ? memory : "" }] })
      }
      if (msg.method === "resources/list") return reply({ resources: [{ uri: "lembas://memory", name: "memory" }] })
      if (msg.method === "tools/list")
        return reply({
          tools: [
            { name: "memory", description: "The account's memory.", inputSchema: { type: "object", properties: { action: { type: "string" }, content: { type: "string" } }, required: ["action"] }, annotations: { readOnlyHint: false } },
            { name: "notes_search", description: "Search notes.", inputSchema: { type: "object", properties: { query: { type: "string" } } }, annotations: { readOnlyHint: true } },
          ],
        })
      if (msg.method === "tools/call") {
        // `_meta.lembas` alone: the SDK adds a progress token of its own beside it.
        calls.push({ auth, name: msg.params.name, args: msg.params.arguments, ...(msg.params._meta?.lembas ? { meta: msg.params._meta.lembas } : {}) })
        return reply({ content: [{ type: "text", text: `ok: ${msg.params.name}` }], isError: false })
      }
      return Response.json({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no" } })
    },
  })
  stops.push(() => server.stop(true))
  return { base: `http://127.0.0.1:${server.port}`, calls }
}

function login(base: string) {
  mkdirSync(join(paths.config, "lembas"), { recursive: true })
  writeFileSync(join(paths.config, "lembas.json"), JSON.stringify({ instances: { ai: { base_url: base, connection: "ai", logged_in_at: "" } } }))
  writeFileSync(join(paths.config, "lembas", "ai.key"), "lmb_lib\n", { mode: 0o600 })
  writeFileSync(join(paths.config, "connections.yaml"), "connections:\n  f:\n    type: webui\n    url: http://127.0.0.1:1/v1\n    models: { f/m: {} }\n", { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), "model: f/m\nlibrary: lembas\n")
}

test("memory is the server's; notes, knowledge and skills stay this machine's", async () => {
  const lembas = fakeLembasMcp()
  login(lembas.base)
  const app = createApp({ cwd: mkdtempSync(join(tmpdir(), "ph-lib-")), store: false, asker: { ask: async (): Promise<AskReply> => ({ kind: "once" }) } })
  await app.mcpReady
  await Bun.sleep(50)
  const names = app.engine.o.tools.map((t) => t.name)
  // The server's memory, once; its notes_search is not taken (only memory comes from /mcp).
  expect(names.filter((n) => n === "memory").length).toBe(1)
  expect(names.filter((n) => n === "notes_search").length).toBe(1)
  for (const local of ["notes_search", "note_view", "note_manage", "skills_list", "skill_view", "skill_manage"]) expect(names).toContain(local)
  const local = (n: string) => app.engine.o.tools.find((t) => t.name === n)!
  expect(local("notes_search").description).not.toContain("Search notes.")
  const mem = app.engine.o.tools.find((t) => t.name === "memory")!
  expect(mem.description).toBe("The account's memory.")
  expect(mem.permission({ action: "add" } as never, { ...app.engine.o.toolCtx, signal: new AbortController().signal }).class).toBe("interact")
  const out = await mem.run({ action: "add", content: "Prefers tabs." } as never, { ...app.engine.o.toolCtx, signal: new AbortController().signal })
  expect(out.output).toContain("ok: memory")
  expect(lembas.calls.filter((c) => c.name)).toEqual([{ auth: "Bearer lmb_lib", name: "memory", args: { action: "add", content: "Prefers tabs." } }])
  // The entries for the prompt: read from the resource as the session started.
  for (let i = 0; i < 50 && !lembas.calls.some((c) => c.uri); i++) await Bun.sleep(10)
  expect(lembas.calls.find((c) => c.uri)).toEqual({ auth: "Bearer lmb_lib", uri: "lembas://memory" })
  for (let i = 0; i < 50 && !app.engine.o.system("manual", app.engine.model).includes("Prefers tabs."); i++) await Bun.sleep(10)
  expect(app.engine.o.system("manual", app.engine.model)).toContain("MEMORY (the account's)\nPrefers tabs.")
  await app.close()
})

test("a session the client opened sends its id on every memory call and on the resource read", async () => {
  const lembas = fakeLembasMcp()
  login(lembas.base)
  const app = createApp({ cwd: mkdtempSync(join(tmpdir(), "ph-lib-")), asker: { ask: async (): Promise<AskReply> => ({ kind: "once" }) } })
  stops.push(() => void app.close())
  await app.mcpReady
  await Bun.sleep(50)
  const mem = app.engine.o.tools.find((t) => t.name === "memory")!
  const ctx = () => ({ ...app.engine.o.toolCtx, signal: new AbortController().signal })
  // A session of this device's own: no scope.
  await mem.run({ action: "view" } as never, ctx())
  expect(lembas.calls.filter((c) => c.name)[0]).toEqual({ auth: "Bearer lmb_lib", name: "memory", args: { action: "view" } })
  // The client's chat (acp/agent.ts sets it): the id rides on the call, and the entries are read again in it.
  app.setScope(app.engine.sessionId)
  await mem.run({ action: "view" } as never, ctx())
  expect(lembas.calls.filter((c) => c.name)[1]).toEqual({ auth: "Bearer lmb_lib", name: "memory", args: { action: "view" }, meta: { scope: app.engine.sessionId } })
  for (let i = 0; i < 50 && !lembas.calls.some((c) => c.uri && c.meta); i++) await Bun.sleep(10)
  expect(lembas.calls.find((c) => c.uri && c.meta)).toEqual({ auth: "Bearer lmb_lib", uri: "lembas://memory", meta: { scope: app.engine.sessionId } })
  // Knowledge is this machine's: nothing the server holds is named to the model.
  expect(app.engine.o.system("manual", app.engine.model)).not.toContain("Knowledge searches here cover only")
})

test("without a login it says so and keeps this machine's memory", () => {
  writeFileSync(join(paths.config, "lembas.json"), JSON.stringify({ instances: {} }))
  writeFileSync(join(paths.config, "connections.yaml"), "connections:\n  f:\n    type: webui\n    url: http://127.0.0.1:1/v1\n    models: { f/m: {} }\n", { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), "model: f/m\nlibrary: lembas\n")
  const app = createApp({ cwd: mkdtempSync(join(tmpdir(), "ph-lib-")), store: false, asker: { ask: async (): Promise<AskReply> => ({ kind: "once" }) } })
  expect(app.loaded.warnings.join(" ")).toContain("not logged in")
  expect(app.engine.o.tools.map((t) => t.name)).toContain("memory")
})
