import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_RULES, evaluate, toRules } from "../src/permission/evaluate.ts"
import { hardlineRules } from "../src/permission/hardline.ts"
import { parseDdg } from "../src/search/ddg.ts"
import { isPrivateHost } from "../src/search/fetch.ts"
import { search } from "../src/search/index.ts"
import { webFetchTool, webSearchTool } from "../src/tool/web.ts"
import type { ToolContext } from "../src/tool/tool.ts"

const fx = (n: string) => readFileSync(join(import.meta.dir, "fixtures/web", n), "utf8")
let server: ReturnType<typeof Bun.serve> | undefined
afterEach(() => server?.stop(true))

type Seen = { path: string; auth: string | null; body?: any }
function serve(handler: (req: Request, url: URL, seen: Seen[]) => Response | Promise<Response>) {
  const seen: Seen[] = []
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const body = req.method === "POST" ? await req.json().catch(() => undefined) : undefined
      seen.push({ path: url.pathname + url.search, auth: req.headers.get("authorization"), body })
      return handler(req, url, seen)
    },
  })
  return { base: `http://127.0.0.1:${server.port}`, seen }
}
const signal = new AbortController().signal

describe("search providers", () => {
  test("DuckDuckGo: a real results page; a bot check is an error, not 'no results'", () => {
    const r = parseDdg(fx("ddg-bun.html"))
    expect(r.length).toBeGreaterThan(5)
    // Plain expects, not toMatchObject with expect.stringMatching: in Bun 1.4.2 that writes the
    // matchers into the received object (see the wiki's Working-notes).
    expect(r[0]!.url).toMatch(/^https:\/\/(bun\.sh|bun\.com)/)
    expect(r[0]!.title).toContain("Bun")
    expect(r.every((x) => /^https?:\/\//.test(x.url))).toBe(true)
    expect(parseDdg('<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=x">Ex</a><a class="result__snippet">snip</a></div>')).toEqual([{ title: "Ex", url: "https://example.com/a", snippet: "snip" }])
    expect(() => parseDdg('<div class="anomaly-modal">are you a robot</div>')).toThrow("bot check")
  })

  test("SearXNG: format=json; a 403 explains the setting", async () => {
    const s = serve((_, url) => (url.searchParams.get("format") === "json" && url.searchParams.get("q") === "bun" ? new Response(fx("searxng-bun.json")) : new Response("no", { status: 403 })))
    const r = await search("bun", { searxng: { base_url: s.base } }, signal)
    expect(r.provider).toBe("searxng")
    expect(r.results[0]!.title).toContain("Bun")
    expect(r.results[0]!.url).toMatch(/^https:/)
    await expect(search("other", { searxng: { base_url: s.base }, order: ["searxng"] }, signal)).rejects.toThrow("JSON output is disabled")
  })

  test("Firecrawl: v2 with a key; self-hosted without a key sends no Authorization; v1 when v2 is missing", async () => {
    const s = serve((_, url) => {
      if (url.pathname === "/v2/search") return Response.json({ success: true, data: { web: [{ url: "https://a.example", title: "A", description: "about a" }] } })
      return new Response("nope", { status: 404 })
    })
    const r = await search("q", { firecrawl: { base_url: s.base, api_key: "fc-KEY" }, order: ["firecrawl"] }, signal)
    expect(r.results).toEqual([{ title: "A", url: "https://a.example", snippet: "about a" }])
    expect(s.seen[0]).toMatchObject({ path: "/v2/search", auth: "Bearer fc-KEY", body: { query: "q", limit: 8 } })
    await search("q", { firecrawl: { base_url: s.base }, order: ["firecrawl"] }, signal)
    expect(s.seen[1]!.auth).toBeNull()
    server!.stop(true)

    const old = serve((_, url) => (url.pathname === "/v1/search" ? Response.json({ success: true, data: [{ url: "https://b.example", title: "B" }] }) : new Response("no", { status: 404 })))
    const r1 = await search("q", { firecrawl: { base_url: old.base }, order: ["firecrawl"] }, signal)
    expect(r1.results[0]!.url).toBe("https://b.example")
    expect(old.seen.map((x) => x.path)).toEqual(["/v2/search", "/v1/search"])
    await expect(search("q", { firecrawl: {}, order: ["firecrawl"] }, signal)).rejects.toThrow("api.firecrawl.dev needs api_key")
  })

  test("the chain: the first that answers wins, and the failures are named", async () => {
    const s = serve((_, url) => (url.pathname === "/search" ? new Response("down", { status: 502 }) : Response.json({ success: true, data: { web: [{ url: "https://c.example", title: "C" }] } })))
    const r = await search("q", { searxng: { base_url: s.base }, firecrawl: { base_url: s.base }, order: ["searxng", "firecrawl"] }, signal)
    expect(r.provider).toBe("firecrawl")
    expect(r.failed[0]).toContain("searxng")
  })
})

describe("web tools", () => {
  const ctx = (search: ToolContext["search"] = {}) => ({ root: "/", cwd: "/", signal, readFiles: new Set<string>(), fileStamps: new Map(), bashTimeoutMs: 1000, search }) as ToolContext

  test("webfetch: HTML becomes markdown without scripts or navigation; long pages come in parts", async () => {
    const long = "word ".repeat(6000)
    const s = serve((_, url) =>
      url.pathname === "/long"
        ? new Response(`<html><body><p>${long}</p></body></html>`, { headers: { "content-type": "text/html" } })
        : new Response(`<html><head><title>Doc Page</title><script>evil()</script></head><body><nav>menu</nav><main><h1>Install</h1><p>Run <code>bun add x</code>.</p><ul><li>one</li></ul></main></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } }),
    )
    const r = await webFetchTool.run({ url: `${s.base}/doc` }, ctx())
    expect(r.output).toContain("# Doc Page")
    expect(r.output).toContain("# Install")
    expect(r.output).toContain("`bun add x`")
    expect(r.output).toContain("-   one")
    expect(r.output).not.toContain("evil")
    expect(r.output).not.toContain("menu")
    const p1 = await webFetchTool.run({ url: `${s.base}/long` }, ctx())
    expect(p1.output).toContain("call again with offset 20000")
    const p2 = await webFetchTool.run({ url: `${s.base}/long`, offset: 20000 }, ctx())
    expect(p2.output).not.toContain("call again with offset")
  })

  test("webfetch on the local network asks; the public web does not", () => {
    const perm = { mode: "manual" as const, rules: toRules(DEFAULT_RULES), hardline: hardlineRules(), root: "/p" }
    expect(evaluate(webFetchTool.permission({ url: "https://docs.example.com/x" }, ctx()), perm).action).toBe("allow")
    for (const u of ["http://192.168.1.10/", "http://localhost:3000", "https://nas.lan/admin", "http://[::1]/", "http://printer/"])
      expect(evaluate(webFetchTool.permission({ url: u }, ctx()), perm).action).toBe("ask")
    expect(isPrivateHost("100.100.1.1")).toBe(true) // tailnet
    expect(isPrivateHost("8.8.8.8")).toBe(false)
  })

  test("websearch: numbered results with links and snippets", async () => {
    const s = serve(() => new Response(fx("searxng-bun.json")))
    const r = await webSearchTool.run({ query: "bun", max_results: 3 }, ctx({ searxng: { base_url: s.base } }))
    expect(r.output).toMatch(/^1\. .+\n {3}https:\/\/.+\n {3}.+/)
    expect(r.title).toBe("bun · 3 results · searxng")
  })
})

// Audit: private addresses in other spellings, redirects, and pages built to stall a regex.
import { fetchPage as fp13, htmlToMarkdown as h13, isPrivateHost as ip13, PrivateAddressError as PAE13 } from "../src/search/fetch.ts"
test("private in every spelling; public names starting with fc/fd are not", () => {
  for (const h of ["[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[::]", "[::ffff:a9fe:a9fe]", "localhost.", "printer.lan.", "[fe90::1]", "[fd12::1]"]) expect(ip13(h)).toBe(true)
  for (const h of ["fcc.gov", "fdroid.org", "example.com", "[2001:db8::1]"]) expect(ip13(h)).toBe(false)
})
test("a redirect to another local address is not followed, even from an approved local host", async () => {
  const away = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 302, headers: { location: "http://10.1.2.3/" } }) })
  try {
    await expect(fp13(`http://127.0.0.1:${away.port}/`, new AbortController().signal, { allowPrivate: "127.0.0.1" })).rejects.toBeInstanceOf(PAE13)
    await expect(fp13(`http://127.0.0.1:${away.port}/`, new AbortController().signal)).rejects.toBeInstanceOf(PAE13)
  } finally {
    away.stop(true)
  }
})
test("a page of unclosed <main tags is read in linear time", () => {
  const t0 = performance.now()
  h13("<main".repeat(80_000))
  expect(performance.now() - t0).toBeLessThan(2000)
})
