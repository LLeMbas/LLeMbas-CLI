// library: lembas: the account's library through the instance's /mcp, in place of this
// machine's — the tools under their own names, as a LLeMbas chat has them, with the device token.
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

function fakeLembasMcp() {
  const calls: { auth: string; name?: string; args?: unknown }[] = []
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
      if (msg.method === "initialize") return reply({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "lembas", version: "1.18.0" } })
      if (msg.method === "tools/list")
        return reply({
          tools: [
            { name: "memory_add", description: "Remember one fact.", inputSchema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] }, annotations: { readOnlyHint: false } },
            { name: "notes_search", description: "Search notes.", inputSchema: { type: "object", properties: { query: { type: "string" } } }, annotations: { readOnlyHint: true } },
          ],
        })
      if (msg.method === "tools/call") {
        calls.push({ auth, name: msg.params.name, args: msg.params.arguments })
        return reply({ content: [{ type: "text", text: `ok: ${msg.params.name}` }], isError: false })
      }
      return Response.json({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no" } })
    },
  })
  stops.push(() => server.stop(true))
  return { base: `http://127.0.0.1:${server.port}`, calls }
}

test("the instance's library replaces this machine's, under the tools' own names", async () => {
  const lembas = fakeLembasMcp()
  mkdirSync(join(paths.config, "lembas"), { recursive: true })
  writeFileSync(join(paths.config, "lembas.json"), JSON.stringify({ instances: { ai: { base_url: lembas.base, connection: "ai", logged_in_at: "" } } }))
  writeFileSync(join(paths.config, "lembas", "ai.key"), "lmb_lib\n", { mode: 0o600 })
  writeFileSync(join(paths.config, "connections.yaml"), "connections:\n  f:\n    dialect: openai-chat\n    base_url: http://127.0.0.1:1/v1\n    models: { m: {} }\n", { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), "model: f/m\nlibrary: lembas\n")
  const app = createApp({ cwd: mkdtempSync(join(tmpdir(), "ph-lib-")), store: false, asker: { ask: async (): Promise<AskReply> => ({ kind: "once" }) } })
  await app.mcpReady
  await Bun.sleep(50)
  const names = app.engine.o.tools.map((t) => t.name)
  expect(names).toContain("memory_add")
  expect(names).toContain("notes_search")
  // This machine's library tools are gone; notes_search is the instance's, once.
  for (const local of ["memory", "note_view", "note_manage", "skills_list", "skill_manage", "knowledge_search"]) expect(names).not.toContain(local)
  expect(names.filter((n) => n === "notes_search").length).toBe(1)
  const add = app.engine.o.tools.find((t) => t.name === "memory_add")!
  expect(add.permission({ content: "x" } as never, { ...app.engine.o.toolCtx, signal: new AbortController().signal }).class).toBe("interact")
  const out = await add.run({ content: "Prefers tabs." } as never, { ...app.engine.o.toolCtx, signal: new AbortController().signal })
  expect(out.output).toContain("ok: memory_add")
  expect(lembas.calls).toEqual([{ auth: "Bearer lmb_lib", name: "memory_add", args: { content: "Prefers tabs." } }])
})

test("without a login it says so and keeps this machine's library", () => {
  writeFileSync(join(paths.config, "lembas.json"), JSON.stringify({ instances: {} }))
  writeFileSync(join(paths.config, "connections.yaml"), "connections:\n  f:\n    dialect: openai-chat\n    base_url: http://127.0.0.1:1/v1\n    models: { m: {} }\n", { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), "model: f/m\nlibrary: lembas\n")
  const app = createApp({ cwd: mkdtempSync(join(tmpdir(), "ph-lib-")), store: false, asker: { ask: async (): Promise<AskReply> => ({ kind: "once" }) } })
  expect(app.loaded.warnings.join(" ")).toContain("not logged in")
  expect(app.engine.o.tools.map((t) => t.name)).toContain("memory")
})
