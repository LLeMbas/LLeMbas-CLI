import { request, tlsFor } from "../provider/http.ts"
import { SearchError, type SearchConfig, type SearchResult } from "./index.ts"

// GET /search?format=json. A 403 means the instance has JSON output switched off
// (search.formats in its settings.yml).
export async function searxngSearch(query: string, c: SearchConfig, limit: number, signal: AbortSignal): Promise<SearchResult[]> {
  const s = c.searxng
  if (!s) throw new SearchError("not configured")
  const url = new URL(s.base_url.replace(/\/+$/, "") + "/search")
  url.searchParams.set("q", query)
  url.searchParams.set("format", "json")
  if (s.categories) url.searchParams.set("categories", s.categories)
  if (s.language) url.searchParams.set("language", s.language)
  const headers: Record<string, string> = s.api_key ? { authorization: `Bearer ${s.api_key}` } : {}
  let res: Response
  try {
    res = await request(url.toString(), { headers, signal, timeoutMs: 20_000, tls: tlsFor(s) }, "searxng")
  } catch (e) {
    if ((e as { status?: number }).status === 403) throw new SearchError("JSON output is disabled on this SearXNG (add json to search.formats in its settings.yml)")
    throw e
  }
  const j = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] }
  return (j.results ?? []).filter((r) => r.url).slice(0, limit).map((r) => ({ title: r.title ?? r.url!, url: r.url!, snippet: (r.content ?? "").trim() }))
}
