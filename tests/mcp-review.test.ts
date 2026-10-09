// What a review of the MCP client found.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { paths } from "../src/config/paths.ts"
import { loadConfig } from "../src/config/load.ts"
import { McpManager, type ServerConfig } from "../src/mcp/index.ts"
import { waitForCallback } from "../src/mcp/oauth.ts"

const TRICKY = join(import.meta.dir, "fixtures", "mcp", "tricky.ts")
const BUN = process.execPath
const ctx = () => ({ root: "/", cwd: "/", signal: new AbortController().signal, readFiles: new Set<string>(), fileStamps: new Map(), bashTimeoutMs: 1000 }) as any

let managers: McpManager[] = []
afterEach(async () => {
  for (const m of managers) await m.close()
  managers = []
})
const manager = (servers: Record<string, ServerConfig>) => {
  const m = new McpManager(servers, { root: tmpdir(), version: "test" })
  managers.push(m)
  return m
}

describe("names", () => {
  test("tools whose names come out the same are all offered, each reaching its own tool", async () => {
    const m = manager({ x: { command: [BUN, TRICKY], source: "global" } })
    await m.start()
    const names = m.tools().map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toHaveLength(5) // three tools, list_resources, read_resource
    const outs = await Promise.all(m.tools().filter((t) => t.name.startsWith("mcp__x__get_user")).map(async (t) => (await t.run({}, ctx())).output))
    expect(outs.sort()).toEqual(["called get.user", "called get_user"])
  })
})

describe("connecting", () => {
  test("a tools list that never ends does not hang startup", async () => {
    const m = manager({ x: { command: [BUN, TRICKY, "--loop"], source: "global", connect_timeout: 5 } })
    const t0 = Date.now()
    await m.start()
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(m.servers.get("x")!.status).toBe("connected")
  })

  test("calls finding the server gone start one process between them, not one each", async () => {
    const pids = join(mkdtempSync(join(tmpdir(), "ph-mcp-")), "pids")
    const m = manager({ x: { command: [BUN, TRICKY], env: { PIDS: pids }, source: "global" } })
    await m.start()
    const s = m.servers.get("x")!
    process.kill((s.transport as any).pid)
    const until = Date.now() + 5000
    while (s.status === "connected" && Date.now() < until) await Bun.sleep(50)
    await Promise.all([m.connect("x"), m.connect("x"), m.connect("x")])
    expect(readFileSync(pids, "utf8").trim().split("\n")).toHaveLength(2)
  })

  test("switched off while connecting, it stays off", async () => {
    const m = manager({ x: { command: [BUN, TRICKY], source: "global" } })
    const going = m.connect("x")
    await m.setEnabled("x", false)
    await going
    expect(m.servers.get("x")!.status).toBe("disabled")
    expect(m.servers.get("x")!.client).toBeUndefined()
  })
})

describe("the sign-in redirect", () => {
  const port = () => {
    const s = Bun.serve({ port: 0, fetch: () => new Response() })
    const p = s.port!
    s.stop(true)
    return p
  }

  test("only a request with this sign-in's state is acted on; pages are escaped", async () => {
    const p = port()
    const cb = waitForCallback(p, () => "st4te")
    try {
      const stray = await fetch(`http://127.0.0.1:${p}/mcp/oauth/callback?error=<script>x</script>`)
      expect(stray.status).toBe(400)
      const err = await fetch(`http://127.0.0.1:${p}/mcp/oauth/callback?state=st4te&error=${encodeURIComponent("<b>no</b>")}`)
      expect(await err.text()).toContain("&#60;b&#62;no")
      await expect(cb.code).rejects.toThrow("the server refused")
    } finally {
      cb.stop()
    }
    const cb2 = waitForCallback(p, () => "st4te")
    try {
      await fetch(`http://127.0.0.1:${p}/mcp/oauth/callback?code=evil`)
      await fetch(`http://127.0.0.1:${p}/mcp/oauth/callback?state=st4te&code=good`)
      expect(await cb2.code).toBe("good")
    } finally {
      cb2.stop()
    }
  })

  test("a port that is taken is reported, not thrown unhandled", async () => {
    const busy = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() })
    try {
      const cb = waitForCallback(busy.port!, () => "s")
      expect(cb.error?.message).toContain("paste the redirect address")
      cb.stop()
    } finally {
      busy.stop(true)
    }
  })
})

describe("a project's servers", () => {
  test("switching a global server off or narrowing it works; defining one replaces the global one whole", () => {
    mkdirSync(paths.config, { recursive: true })
    writeFileSync(join(paths.config, "config.yaml"), `mcp:\n  gh:\n    url: https://api.example/mcp\n    headers: { Authorization: "Bearer SECRET" }\n  other:\n    command: x\n`)
    const proj = mkdtempSync(join(tmpdir(), "ph-proj-"))
    writeFileSync(join(proj, "config.yaml"), `mcp:\n  gh: { enabled: false }\n  other: { tools: { include: [a] } }\n`)
    let l = loadConfig({ projectConfigDir: proj, trusted: true })
    expect(l.mcp.gh!.enabled).toBe(false)
    expect(l.mcp.gh!.headers!.Authorization).toBe("Bearer SECRET")
    expect(l.mcp.other!.tools!.include).toEqual(["a"])
    expect(l.mcp.other!.command).toBe("x")
    writeFileSync(join(proj, "config.yaml"), `mcp:\n  gh: { url: "https://elsewhere.example/mcp" }\n  nosuch: { enabled: false }\n`)
    l = loadConfig({ projectConfigDir: proj, trusted: true })
    expect(l.mcp.gh!.url).toBe("https://elsewhere.example/mcp")
    expect(l.mcp.gh!.headers).toBeUndefined()
    expect(l.warnings.join("\n")).toContain("mcp.nosuch changes a server the global config does not define")
    writeFileSync(join(paths.config, "config.yaml"), "")
  })
})
