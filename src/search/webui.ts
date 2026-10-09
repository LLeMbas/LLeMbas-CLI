// Web search and page fetch through a LLeMbas instance: its provider, its settings and its
// keys, so a machine logged in to it needs none of its own. `search.webui` is filled in by the
// loader from the webui connection — the address and this machine's key — and never written by hand.
import { joinUrl, request, tlsFor } from "../provider/http.ts"
import { SearchError, type SearchConfig, type SearchResult } from "./index.ts"

export interface WebuiSearch {
  connection?: string
  base_url?: string
  api_key?: string
  tls?: { ca?: string; insecure?: boolean }
}

function target(c: SearchConfig): Required<Pick<WebuiSearch, "base_url">> & WebuiSearch {
  const w = c.webui as WebuiSearch | undefined
  if (!w?.base_url) throw new SearchError("not configured (a webui connection: lembas login)")
  return w as Required<Pick<WebuiSearch, "base_url">> & WebuiSearch
}

async function post(w: WebuiSearch & { base_url: string }, path: string, body: unknown, signal: AbortSignal, what: string): Promise<any> {
  const headers: Record<string, string> = { "content-type": "application/json", ...(w.api_key ? { authorization: `Bearer ${w.api_key}` } : {}) }
  try {
    const res = await request(joinUrl(w.base_url, path), { method: "POST", headers, body: JSON.stringify(body), signal, timeoutMs: 60_000, tls: tlsFor(w) }, what)
    return await res.json()
  } catch (e) {
    // 404: the instance has it switched off for this account, or does not have the endpoint.
    if ((e as { status?: number }).status === 404) throw new SearchError(`${new URL(w.base_url).host} does not offer this to this account`)
    throw e
  }
}

export async function webuiSearch(query: string, c: SearchConfig, limit: number, signal: AbortSignal): Promise<SearchResult[]> {
  const j = await post(target(c), "api/v1/search", { query, max_results: limit }, signal, "webui search")
  const list: any[] = Array.isArray(j?.results) ? j.results : []
  return list.filter((r) => r?.url).map((r) => ({ title: String(r.title ?? r.url), url: String(r.url), snippet: String(r.snippet ?? "").trim() }))
}

export async function webuiFetch(url: string, c: SearchConfig, signal: AbortSignal): Promise<{ title?: string; text: string }> {
  const j = await post(target(c), "api/v1/fetch", { url }, signal, "webui fetch")
  return { title: j?.title || undefined, text: String(j?.text ?? "") }
}
