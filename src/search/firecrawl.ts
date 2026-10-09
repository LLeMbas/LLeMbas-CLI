import { request, tlsFor } from "../provider/http.ts"
import { SearchError, type SearchConfig, type SearchResult } from "./index.ts"

// Firecrawl, v2 first and v1 where v2 is not there (older self-hosted builds). Hosted:
// https://api.firecrawl.dev with a key. Self-hosted: its own URL and no key — a self-hosted
// Firecrawl never reads the Authorization header, so none is sent unless a key is configured.
const HOSTED = "https://api.firecrawl.dev"
const noV2 = new Set<string>()

function base(c: SearchConfig) {
  return (c.firecrawl?.base_url ?? HOSTED).replace(/\/+$/, "")
}

async function call(c: SearchConfig, path: string, body: unknown, signal: AbortSignal, what: string): Promise<any> {
  const f = c.firecrawl
  if (!f) throw new SearchError("not configured")
  const b = base(c)
  if (b === HOSTED && !f.api_key) throw new SearchError("api.firecrawl.dev needs api_key (a self-hosted Firecrawl does not)")
  const headers: Record<string, string> = { "content-type": "application/json", ...(f.api_key ? { authorization: `Bearer ${f.api_key}` } : {}) }
  for (const v of noV2.has(b) ? ["v1"] : ["v2", "v1"]) {
    try {
      const res = await request(`${b}/${v}/${path}`, { method: "POST", headers, body: JSON.stringify(body), signal, timeoutMs: 60_000, tls: tlsFor(f) }, what)
      const j = (await res.json()) as any
      if (j?.success === false) throw new SearchError(j.error ?? "the request failed")
      return j
    } catch (e) {
      if (v === "v2" && (e as { status?: number }).status === 404) {
        noV2.add(b)
        continue
      }
      throw e
    }
  }
}

export async function firecrawlSearch(query: string, c: SearchConfig, limit: number, signal: AbortSignal): Promise<SearchResult[]> {
  const j = await call(c, "search", { query, limit }, signal, "firecrawl search")
  // v2: data.web[]; v1: data[]
  const list: any[] = Array.isArray(j?.data) ? j.data : (j?.data?.web ?? [])
  return list.filter((r) => r?.url).map((r) => ({ title: r.title ?? r.url, url: r.url, snippet: (r.description ?? r.snippet ?? "").trim() }))
}

export async function firecrawlScrape(url: string, c: SearchConfig, signal: AbortSignal): Promise<{ title?: string; markdown: string }> {
  const j = await call(c, "scrape", { url, formats: ["markdown"], onlyMainContent: true }, signal, "firecrawl scrape")
  const d = j?.data ?? {}
  return { title: d.metadata?.title, markdown: d.markdown ?? "" }
}
