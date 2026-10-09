// OAuth against a real authorisation server: the SDK's own example server with --oauth (discovery,
// dynamic client registration, PKCE, tokens), which approves every sign-in at once — so fetching
// the authorisation page and following its redirect plays the browser.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { paths } from "../src/config/paths.ts"
import { McpManager } from "../src/mcp/index.ts"
import { codeFrom } from "../src/mcp/oauth.ts"

const node = Bun.which("node")
const example = join(import.meta.dir, "..", "node_modules/@modelcontextprotocol/sdk/dist/esm/examples/server/simpleStreamableHttp.js")
const free = () => {
  const s = Bun.serve({ port: 0, fetch: () => new Response() })
  const p = s.port
  s.stop(true)
  return p
}
const [MCP, AUTH, CB] = [free(), free(), free()]
let server: ReturnType<typeof Bun.spawn> | undefined

beforeAll(async () => {
  if (!node) return
  server = Bun.spawn([node, example, "--oauth"], { env: { ...process.env, MCP_PORT: String(MCP), MCP_AUTH_PORT: String(AUTH) }, stdout: "pipe", stderr: "pipe" })
  const until = Date.now() + 15_000
  while (Date.now() < until) {
    if (await fetch(`http://localhost:${MCP}/mcp`, { method: "POST" }).then(() => true, () => false)) break
    await Bun.sleep(100)
  }
})
afterAll(() => server?.kill())

test.skipIf(!node)("sign in: needs_auth first, then the redirect is caught, tokens stored (0600) and reused", async () => {
  const cfg = { demo: { url: `http://localhost:${MCP}/mcp`, source: "global" as const, oauth: { callback_port: CB } } }
  const m = new McpManager(cfg, { root: "/tmp", version: "t" })
  await m.start()
  expect(m.servers.get("demo")!.status).toBe("needs_auth")
  let shown = ""
  const s = await m.auth("demo", async (url) => {
    shown = url
    const r = await fetch(url, { redirect: "manual" })
    await fetch(r.headers.get("location")!)
  })
  expect(new URL(shown).searchParams.get("code_challenge_method")).toBe("S256")
  expect(s.status).toBe("connected")
  expect((await m.tools().find((t) => t.name === "mcp__demo__greet")!.run({ name: "Jaro" }, { signal: new AbortController().signal } as any)).output).toBe("Hello, Jaro!")
  await m.close()
  const file = join(paths.data, "mcp-auth.json")
  expect(statSync(file).mode & 0o777).toBe(0o600)
  // Stored under the name and the URL together (a project's "demo" elsewhere cannot replace it).
  const stored = JSON.parse(readFileSync(file, "utf8")) as Record<string, { url: string; tokens?: { access_token?: string } }>
  const key = Object.keys(stored).find((k) => k.startsWith("demo "))!
  expect(stored[key]!.tokens?.access_token).toBeTruthy()
  const again = new McpManager(cfg, { root: "/tmp", version: "t" })
  await again.start()
  expect(again.servers.get("demo")!.status).toBe("connected")
  again.logout("demo")
  expect(JSON.parse(readFileSync(file, "utf8")).demo).toBeUndefined()
  await again.close()
})

test.skipIf(!node)("a pasted redirect address works when the browser cannot reach this machine", async () => {
  const cfg = { paste: { url: `http://localhost:${MCP}/mcp`, source: "global" as const, oauth: { callback_port: free() } } }
  const m = new McpManager(cfg, { root: "/tmp", version: "t" })
  let give: (s: string) => void = () => {}
  const pasted = new Promise<string>((r) => (give = r))
  const s = await m.auth(
    "paste",
    async (url) => {
      // the browser ends on the redirect address; it never reaches our listener
      const r = await fetch(url, { redirect: "manual" })
      give(r.headers.get("location")!)
    },
    pasted,
  )
  expect(s.status).toBe("connected")
  await m.close()
})

test("the code from a pasted address or a bare code", () => {
  expect(codeFrom("http://127.0.0.1:19876/mcp/oauth/callback?code=abc&state=xyz")).toEqual({ code: "abc", state: "xyz", fromUrl: true })
  expect(codeFrom("  abc  ")).toEqual({ code: "abc" })
})
