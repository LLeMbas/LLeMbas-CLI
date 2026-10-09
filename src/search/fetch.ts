// Reading a web page for the model: HTML turned into markdown (turndown), text as it is, others
// described. Capped in size; long pages are read in parts with an offset.
import TurndownService from "turndown"
import { lookup } from "node:dns/promises"
import { request } from "../provider/http.ts"

const MAX_BYTES = 5_000_000
const UA = "Mozilla/5.0 (X11; Linux x86_64) LLeMbas CLI"

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" })
turndown.remove(["script", "style", "noscript", "iframe", "svg", "form", "nav", "footer"] as never)

/** The first <tag …>…</tag> in the HTML, found by searching, not by a lazy regex: on a page of
 *  thousands of unclosed `<main` a regex is quadratic and freezes the program for minutes. */
function element(html: string, lower: string, tag: string): string | undefined {
  const open = lower.indexOf(`<${tag}`)
  if (open < 0) return undefined
  const close = lower.indexOf(`</${tag}>`, open)
  return close < 0 ? undefined : html.slice(open, close + tag.length + 3)
}

/** HTML as markdown, the way web_fetch reads a page (scripts, styles and navigation dropped). */
export function htmlToMarkdown(html: string): string {
  const lower = html.toLowerCase()
  const body = element(html, lower, "main") ?? element(html, lower, "article") ?? html
  return turndown.turndown(body).replace(/\n{3,}/g, "\n\n").trim()
}

export class PrivateAddressError extends Error {}

/** Whether a host is, or resolves to, an address on this machine or the local network. */
export async function resolvesPrivate(host: string): Promise<boolean> {
  if (isPrivateHost(host)) return true
  const h = host.replace(/^\[|\]$/g, "")
  if (/^[\d.]+$/.test(h) || h.includes(":")) return false
  try {
    const all = await lookup(h, { all: true })
    return all.some((a) => isPrivateHost(a.address))
  } catch {
    return false
  }
}

/** A page, following at most five redirects by hand: each one is checked again, so a public page
 *  cannot send the fetch on to a local service (`allowPrivate`: the host the user approved). */
export async function fetchPage(url: string, signal: AbortSignal, o: { allowPrivate?: string | true } = {}): Promise<{ title?: string; text: string; type: string; status: number }> {
  let at = url
  let res: Response | undefined
  for (let hop = 0; hop <= 5; hop++) {
    const u = new URL(at)
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`a redirect to ${u.protocol} — not followed`)
    if (o.allowPrivate !== true && u.hostname !== o.allowPrivate && (await resolvesPrivate(u.hostname)))
      throw new PrivateAddressError(`${hop ? `the page redirected to ${u.host}, which` : `${u.host}`} is on this machine or the local network — not fetched. Fetch it by a local name or address (that is asked first), if the user wants it.`)
    res = await request(at, { headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5" }, signal, timeoutMs: 30_000, redirect: "manual" }, u.host)
    const next = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null
    if (!next) break
    await res.body?.cancel().catch(() => {})
    at = new URL(next, at).toString()
    if (hop === 5) throw new Error("more than five redirects")
  }
  res = res!
  const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase()
  const bytes = await readCapped(res)
  const raw = new TextDecoder().decode(bytes)
  if (type.includes("html") || (!type && /<html|<body/i.test(raw.slice(0, 2000)))) {
    const lower = raw.toLowerCase()
    const t = element(raw, lower, "title")
    const title = t?.slice(t.indexOf(">") + 1, t.lastIndexOf("<")).replace(/\s+/g, " ").trim()
    return { title, text: htmlToMarkdown(raw), type: type || "text/html", status: res.status }
  }
  if (type.startsWith("text/") || type.includes("json") || type.includes("xml") || type.includes("javascript")) return { text: raw, type, status: res.status }
  return { text: `(${type || "unknown type"}, ${bytes.length} bytes — not a page that can be shown as text)`, type, status: res.status }
}

async function readCapped(res: Response): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const c of res.body) {
    chunks.push(c)
    size += c.length
    if (size > MAX_BYTES) break
  }
  const out = new Uint8Array(Math.min(size, MAX_BYTES))
  let at = 0
  for (const c of chunks) {
    const take = Math.min(c.length, out.length - at)
    out.set(c.subarray(0, take), at)
    at += take
    if (at >= out.length) break
  }
  return out
}

/** Hosts on this machine or the local network: fetching them is asked about, not assumed. */
export function isPrivateHost(host: string): boolean {
  let h = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "")
  if (h === "localhost" || h.endsWith(".localhost") || (!h.includes(".") && !h.includes(":"))) return true
  if (/\.(lan|local|localdomain|internal|home|home\.arpa|intranet|corp)$/.test(h)) return true
  if (h.includes(":")) {
    // IPv4 inside IPv6 (::ffff:127.0.0.1, or as the URL parser writes it, ::ffff:7f00:1).
    const mapped = /^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h) ?? null
    if (mapped) return isPrivateHost(mapped[1]!)
    const hex = /^(?:0*:)*:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h)
    if (hex) {
      const a = parseInt(hex[1]!, 16)
      const b = parseInt(hex[2]!, 16)
      return isPrivateHost(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`)
    }
    return h === "::" || h === "::1" || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h)
  }
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
  }
  return false
}
