import { request } from "../provider/http.ts"
import { SearchError, type SearchConfig, type SearchResult } from "./index.ts"

// DuckDuckGo's HTML page — no key, no API, and it may decide it is talking to a bot. When it does,
// that is said, not returned as "no results". The results are links with class result__a (whose
// href is either the page itself or a //duckduckgo.com/l/?uddg=<page> redirect) and snippets with
// class result__snippet.
const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0"
const SAFE = { strict: "1", moderate: "-1", off: "-2" } as const

export function parseDdg(html: string): SearchResult[] {
  if (/anomaly-modal|detected unusual activity|challenge-form|g-recaptcha/i.test(html)) throw new SearchError("DuckDuckGo answered with a bot check; try again later, or configure SearXNG")
  const out: SearchResult[] = []
  const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/).slice(1)
  for (const b of blocks) {
    if (/result--ad\b/.test(b.slice(0, 200))) continue
    const a = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(b)
    if (!a) continue
    let url = decode(a[1]!)
    const redirect = /[?&]uddg=([^&]+)/.exec(url)
    if (redirect) url = decodeURIComponent(redirect[1]!)
    if (url.startsWith("//")) url = "https:" + url
    if (!/^https?:\/\//.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue
    const snip = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(b)
    out.push({ title: text(a[2]!), url, snippet: snip ? text(snip[1]!) : "" })
  }
  return out
}

function decode(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
}

function text(html: string): string {
  return decode(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim()
}

export async function ddgSearch(query: string, c: SearchConfig, limit: number, signal: AbortSignal): Promise<SearchResult[]> {
  const form = new URLSearchParams({ q: query, kl: c.ddg?.region ?? "wt-wt", kp: SAFE[c.ddg?.safe ?? "moderate"] })
  const res = await request(
    "https://html.duckduckgo.com/html/",
    { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA }, body: form.toString(), signal, timeoutMs: 20_000 },
    "duckduckgo",
  )
  if (res.status === 202) throw new SearchError("DuckDuckGo is rate-limiting (202); try again later, or configure SearXNG")
  return parseDdg(await res.text()).slice(0, limit)
}
