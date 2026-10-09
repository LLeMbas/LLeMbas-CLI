import { z } from "zod"
import { firecrawlScrape } from "../search/firecrawl.ts"
import { PrivateAddressError, fetchPage, isPrivateHost } from "../search/fetch.ts"
import { search, searchOrder } from "../search/index.ts"
import { webuiFetch } from "../search/webui.ts"
import { defineTool, ToolError, truncate } from "./tool.ts"
import { described } from "../harness.ts"

export const webSearchTool = defineTool({
  ...described("web_search"),
  access: "web_search",
  schema: z.object({
    query: z.string().min(1),
    max_results: z.number().int().min(1).max(20).optional(),
  }),
  permission: (a) => ({ permission: "web_search", class: "read", patterns: [a.query] }),
  async run(a, ctx) {
    const c = ctx.search ?? {}
    const r = await search(a.query, c, ctx.signal, a.max_results ?? c.max_results ?? 8).catch((e) => {
      throw new ToolError((e as Error).message)
    })
    const lines = r.results.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}${x.snippet ? `\n   ${x.snippet.slice(0, 300)}` : ""}`)
    const note = r.failed.length ? `\n\n(${r.failed.join("; ")} — answered by ${r.provider})` : ""
    return { output: (lines.join("\n") || "No results.") + note, title: `${a.query} · ${r.results.length} results · ${r.provider}` }
  },
})

export const webFetchTool = defineTool({
  ...described("web_fetch"),
  access: "web_fetch",
  schema: z.object({
    url: z.string().url(),
    offset: z.number().int().min(0).optional(),
  }),
  permission: (a) => {
    let host = ""
    try {
      host = new URL(a.url).hostname
    } catch {}
    // Pages on this machine or the local network are asked about: a page the model read
    // earlier must not be able to steer it into internal services unseen.
    return { permission: "web_fetch", class: "read", patterns: [isPrivateHost(host) ? `private:${host}` : host] }
  },
  async run(a, ctx) {
    const u = new URL(a.url)
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new ToolError("only http and https URLs")
    const c = ctx.search ?? {}
    let title: string | undefined
    let text: string
    if (c.fetch === "firecrawl" && c.firecrawl) {
      const r = await firecrawlScrape(a.url, c, ctx.signal)
      title = r.title
      text = r.markdown
    } else if (c.fetch === "webui" && c.webui && !isPrivateHost(u.hostname)) {
      // Through the instance — except a page on this network, which it cannot (and should not) reach.
      const r = await webuiFetch(a.url, c, ctx.signal)
      title = r.title
      text = r.text
    } else {
      // A local host the user was asked about (and allowed) may be fetched; any other local address
      // — a redirect, or a public name that resolves to one — is refused.
      let r: Awaited<ReturnType<typeof fetchPage>>
      try {
        r = await fetchPage(a.url, ctx.signal, { allowPrivate: isPrivateHost(u.hostname) ? u.hostname : undefined })
      } catch (e) {
        if (e instanceof PrivateAddressError) throw new ToolError(e.message)
        throw e
      }
      title = r.title
      text = r.text
    }
    const from = a.offset ?? 0
    const PAGE = 20_000
    const part = text.slice(from, from + PAGE)
    const more = from + PAGE < text.length ? `\n\n(${text.length - from - PAGE} more characters — call again with offset ${from + PAGE})` : ""
    return {
      output: `${title ? `# ${title}\n` : ""}${a.url}\n\n${truncate(part, PAGE + 1000)}${more}`,
      title: `${u.host}${u.pathname.length > 1 ? u.pathname.slice(0, 40) : ""} · ${Math.round(text.length / 1000)}k chars`,
    }
  },
})

export { searchOrder }
