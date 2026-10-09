// Web search: a LLeMbas instance's own (webui), SearXNG, Firecrawl (its hosted API with a key, or a
// self-hosted instance without one) and DuckDuckGo's HTML page, tried in order until one answers.
// LLeMbas has the last three.
import type { Config } from "../config/schema.ts"
import { ProviderError } from "../provider/types.ts"
import { ddgSearch } from "./ddg.ts"
import { firecrawlSearch } from "./firecrawl.ts"
import { searxngSearch } from "./searxng.ts"
import { webuiSearch } from "./webui.ts"

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

export type SearchConfig = NonNullable<Config["search"]>
export type Provider = "webui" | "searxng" | "firecrawl" | "ddg"

export class SearchError extends Error {}

/** The providers to try: as configured, else every configured one, then DuckDuckGo. A listed
 *  service that is not configured (or was turned off because its key could not be read) is skipped. */
export function searchOrder(c: SearchConfig): Provider[] {
  if (c.order?.length) return c.order.filter((p) => p === "ddg" || c[p] !== undefined)
  const out: Provider[] = []
  // The instance first: it is where the user set search up once for every machine.
  if (c.webui) out.push("webui")
  if (c.searxng) out.push("searxng")
  if (c.firecrawl) out.push("firecrawl")
  out.push("ddg")
  return out
}

export async function search(query: string, c: SearchConfig, signal: AbortSignal, limit = c.max_results ?? 8): Promise<{ provider: Provider; results: SearchResult[]; failed: string[] }> {
  const failed: string[] = []
  for (const p of searchOrder(c)) {
    try {
      const results =
        p === "webui"
          ? await webuiSearch(query, c, limit, signal)
          : p === "searxng"
            ? await searxngSearch(query, c, limit, signal)
            : p === "firecrawl"
              ? await firecrawlSearch(query, c, limit, signal)
              : await ddgSearch(query, c, limit, signal)
      return { provider: p, results: results.slice(0, limit), failed }
    } catch (e) {
      if (signal.aborted) throw e
      failed.push(`${p}: ${e instanceof ProviderError || e instanceof SearchError ? e.message : (e as Error).message}`)
    }
  }
  throw new SearchError(`every search provider failed — ${failed.join("; ")}`)
}
