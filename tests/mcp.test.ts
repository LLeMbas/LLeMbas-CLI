import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../src/app.ts"
import type { AskReply } from "../src/bus/index.ts"
import { paths } from "../src/config/paths.ts"
import { loadConfig } from "../src/config/load.ts"
import { convertResult, McpManager, toolName, toolAllowed, type ServerConfig } from "../src/mcp/index.ts"
import { delta, fakeProvider, toolCall, usage, type Fake } from "./fake-provider.ts"

const SERVER = join(import.meta.dir, "fixtures", "mcp", "server.ts")
const BUN = process.execPath
const local = (extra: Partial<ServerConfig> = {}): ServerConfig => ({ command: [BUN, SERVER], source: "global", ...extra })
const ctx = () => ({ root: "/", cwd: "/", signal: new AbortController().signal, readFiles: new Set<string>(), fileStamps: new Map(), bashTimeoutMs: 1000 }) as any

let managers: McpManager[] = []
let stops: (() => void)[] = []
afterEach(async () => {
  for (const m of managers) await m.close()
  for (const s of stops) s()
  managers = []
  stops = []
})
const manager = (servers: Record<string, ServerConfig>) => {
  const m = new McpManager(servers, { root: tmpdir(), version: "test" })
  managers.push(m)
  return m
}
const freePort = () => {
  const s = Bun.serve({ port: 0, fetch: () => new Response() })
  const p = s.port
  s.stop(true)
  return p
}
async function httpFixture(token?: string) {
  const port = freePort()
  const p = Bun.spawn([BUN, SERVER, "--http", String(port)], { env: { ...process.env, ...(token ? { TOKEN: token } : {}) }, stdout: "pipe", stderr: "inherit" })
  stops.push(() => p.kill())
  const reader = p.stdout.getReader()
  await reader.read() // "ready"
  return `http://127.0.0.1:${port}/mcp`
}

describe("names and results", () => {
  test("tool names: mcp__server__tool, unsafe characters replaced, never over 64", () => {
    expect(toolName("git hub", "create.issue")).toBe("mcp__git_hub__create_issue")
    const long = toolName("a-very-long-server-name-indeed", "and_an_even_longer_tool_name_that_goes_on")
    expect(long.length).toBe(64)
    expect(long).toMatch(/^mcp__a-very-long-server-name-indeed__and_an_even_long.*_[0-9a-f]{8}$/)
  })

  test("include wins over exclude; globs work", () => {
    expect(toolAllowed("create_issue", { include: ["create_*"] })).toBe(true)
    expect(toolAllowed("delete_repo", { include: ["create_*"], exclude: [] })).toBe(false)
    expect(toolAllowed("delete_repo", { exclude: ["delete_*"] })).toBe(false)
    expect(toolAllowed("read", {})).toBe(true)
  })

  test("content blocks: text, image for the model, resources and links named, structured when nothing else, errors", () => {
    const r = convertResult("s", {
      content: [
        { type: "text", text: "one" },
        { type: "image", mimeType: "image/png", data: "AAAA" },
        { type: "resource", resource: { uri: "file:///a", text: "inline" } },
        { type: "resource", resource: { uri: "file:///b", mimeType: "application/pdf", blob: "AAAAAAAA" } },
        { type: "resource_link", uri: "file:///c", name: "c" },
      ],
    })
    expect(r.output).toContain("one")
    expect(r.images).toEqual([{ type: "image", mime: "image/png", data: "AAAA" }])
    expect(r.output).toContain("[resource file:///a]\ninline")
    expect(r.output).toContain("binary resource file:///b (application/pdf, 6 bytes)")
    expect(r.output).toContain("read it with mcp__s__read_resource")
    expect(convertResult("s", { content: [], structuredContent: { n: 1 } }).output).toBe('{\n  "n": 1\n}')
    expect(convertResult("s", { isError: true, content: [{ type: "text", text: "bad" }] })).toMatchObject({ output: "bad", isError: true })
  })
})

describe("a local server (stdio)", () => {
  test("connects; its tools run; errors, images and structured output come back; read-only tools are read-class", async () => {
    const m = manager({ fix: local() })
    await m.start()
    const s = m.servers.get("fix")!
    expect(s.status).toBe("connected")
    const tools = new Map(m.tools().map((t) => [t.name, t]))
    expect([...tools.keys()].sort()).toEqual(["mcp__fix__echo", "mcp__fix__env", "mcp__fix__fail", "mcp__fix__list_resources", "mcp__fix__picture", "mcp__fix__read_resource", "mcp__fix__structured"])
    const echo = tools.get("mcp__fix__echo")!
    expect(echo.permission({ text: "x" }, ctx()).class).toBe("read")
    expect(tools.get("mcp__fix__fail")!.permission({}, ctx()).class).toBe("execute")
    expect(echo.jsonSchema).toMatchObject({ type: "object", properties: { text: { type: "string" } }, required: ["text"] })
    expect((await echo.run({ text: "hi" }, ctx())).output).toBe("echo: hi")
    expect(await tools.get("mcp__fix__fail")!.run({}, ctx())).toMatchObject({ output: "it broke", isError: true })
    expect((await tools.get("mcp__fix__picture")!.run({}, ctx())).images?.[0]?.mime).toBe("image/png")
    expect((await tools.get("mcp__fix__structured")!.run({}, ctx())).output).toContain('"n": 42')
    expect((await tools.get("mcp__fix__list_resources")!.run({}, ctx())).output).toContain("note://one — note (text/plain): A note")
    expect((await tools.get("mcp__fix__read_resource")!.run({ uri: "note://one" }, ctx())).output).toContain("the note's text")
  })

  test("the process gets a minimal environment plus what its config names — not the shell's secrets", async () => {
    process.env.PH_TEST_SECRET_KEY = "sk-do-not-leak"
    const m = manager({ fix: local({ env: { WANTED: "yes" } }) })
    await m.start()
    const env = m.tools().find((t) => t.name === "mcp__fix__env")!
    expect((await env.run({ name: "PH_TEST_SECRET_KEY" }, ctx())).output).toBe("PH_TEST_SECRET_KEY=(unset)")
    expect((await env.run({ name: "WANTED" }, ctx())).output).toBe("WANTED=yes")
    expect((await env.run({ name: "PATH" }, ctx())).output).not.toContain("(unset)")
    delete process.env.PH_TEST_SECRET_KEY
  })

  test("prompts become /server:prompt with the typed words as arguments; instructions are collected", async () => {
    const m = manager({ fix: local() })
    await m.start()
    const [greet] = m.prompts()
    expect(greet).toMatchObject({ name: "fix:greet", args: ["name", "style"] })
    expect(await m.promptText(greet!, "Jaro very warmly")).toBe("Say hello to Jaro, very warmly.")
    expect(m.instructions()).toContain('<server name="fix">\nUse echo to repeat things back. The secret word is lantern.\n</server>')
  })

  test("filters, switched off, a broken command, reconnect after the process dies", async () => {
    const m = manager({ fix: local({ tools: { include: ["echo"] }, resources: false, prompts: false }), off: local({ enabled: false }), bad: { command: ["/nonexistent/server"], source: "global" } })
    await m.start()
    expect(m.tools().map((t) => t.name)).toEqual(["mcp__fix__echo"])
    expect(m.prompts()).toEqual([])
    expect(m.servers.get("off")!.status).toBe("disabled")
    expect(m.servers.get("bad")!.status).toBe("failed")
    // kill the process: the next call reconnects once
    const s = m.servers.get("fix")!
    const pid = (s.transport as any).pid as number
    process.kill(pid)
    const until = Date.now() + 5000
    while (s.status === "connected" && Date.now() < until) await Bun.sleep(50)
    expect(s.status).toBe("failed")
    const echo = m.tools()
    expect(echo).toEqual([]) // not offered while down
    const again = await m.connect("fix")
    expect(again.status).toBe("connected")
  })
})

describe("a remote server (streamable HTTP)", () => {
  test("headers reach it; without them it is refused and the server is marked failed", async () => {
    const url = await httpFixture("tok123")
    const m = manager({ ok: { url, headers: { Authorization: "Bearer tok123" }, source: "global" }, no: { url, oauth: false, source: "global", connect_timeout: 5 } })
    await m.start()
    expect(m.servers.get("ok")!.status).toBe("connected")
    expect((await m.tools().find((t) => t.name === "mcp__ok__echo")!.run({ text: "remote" }, ctx())).output).toBe("echo: remote")
    expect(m.servers.get("no")!.status).toBe("failed")
  })
})

describe("config", () => {
  test("{env:} is filled in per server: a missing variable turns off that server only", () => {
    mkdirSync(paths.config, { recursive: true })
    process.env.PH_MCP_TOKEN = "t1"
    writeFileSync(
      join(paths.config, "config.yaml"),
      `model: x/y\nmcp:\n  good:\n    url: http://127.0.0.1:1/mcp\n    headers: { Authorization: "Bearer {env:PH_MCP_TOKEN}" }\n  missing:\n    url: http://127.0.0.1:1/mcp\n    headers: { Authorization: "Bearer {env:PH_MCP_NOPE}" }\n  both:\n    command: x\n    url: http://x\n`,
    )
    expect(() => loadConfig()).toThrow("give either command")
    writeFileSync(
      join(paths.config, "config.yaml"),
      `model: x/y\nmcp:\n  good:\n    url: http://127.0.0.1:1/mcp\n    headers: { Authorization: "Bearer {env:PH_MCP_TOKEN}" }\n  missing:\n    url: http://127.0.0.1:1/mcp\n    headers: { Authorization: "Bearer {env:PH_MCP_NOPE}" }\n`,
    )
    const l = loadConfig()
    expect(l.mcp.good!.headers!.Authorization).toBe("Bearer t1")
    expect(l.mcp.missing).toBeUndefined()
    expect(l.broken["mcp:missing"]).toContain("PH_MCP_NOPE")
    expect(l.config.model).toBe("x/y")
    writeFileSync(join(paths.config, "config.yaml"), "")
  })
})

describe("through the engine", () => {
  let fake: Fake | undefined
  afterEach(() => fake?.stop())

  test("the model calls an MCP tool: it asks first (manual), the result goes back; instructions are in the system prompt", async () => {
    fake = fakeProvider([
      { chunks: [toolCall(0, "c1", "mcp__fix__echo", '{"text":"via engine"}'), usage(10, 5)] },
      { chunks: [delta({ content: "It said it." }, "stop"), usage(20, 5)] },
    ])
    mkdirSync(paths.config, { recursive: true })
    writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  fake:\n    type: webui\n    url: ${fake.url}\n    models:\n      fake/m: { context: 32768 }\n`, { mode: 0o600 })
    writeFileSync(join(paths.config, "config.yaml"), `model: fake/m\nmcp:\n  fix:\n    command: ["${BUN}", "${SERVER}"]\n`)
    const dir = mkdtempSync(join(tmpdir(), "lembas-mcp-"))
    const asked: string[] = []
    const app = createApp({ cwd: dir, mode: "manual", asker: { ask: async (req): Promise<AskReply> => (asked.push(req.request.permission), { kind: "once" }) }, store: false, snapshots: false })
    await app.mcpReady
    await app.engine.prompt("echo something")
    expect(asked.join()).toContain("mcp__fix__echo")
    expect(fake.requests[0].tools.map((t: any) => t.function.name)).toContain("mcp__fix__echo")
    expect(fake.requests[0].messages[0].content).toContain("<mcp_instructions>")
    expect(fake.requests[1].messages.at(-1)).toMatchObject({ role: "tool", content: "[#0001]\necho: via engine" })
    await app.close()
    writeFileSync(join(paths.config, "config.yaml"), "")
  })
})
