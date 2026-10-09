// Where releases are listed and fetched from: GitHub's or Gitea's (Forgejo's) releases API, or a
// plain web directory. LLeMbas CLI's own default is the public repository on GitHub; anyone can
// point `update.source` at a fork, a mirror, or a directory of their own builds.
import type { Update } from "../config/schema.ts"
import { runKeyCmd, substituteDeep } from "../config/substitute.ts"
import { tlsFor } from "../provider/http.ts"
import { VERSION } from "../version.ts"

export type Source = NonNullable<Update["source"]>

/** The public releases: the GitHub mirror of the LLeMbas organisation's repository. */
export const DEFAULT_SOURCE: Source = { type: "github", repo: "LLeMbas/LLeMbas-CLI" }

export interface Release {
  tag: string
  /** Asset name → where to download it (a forge's release). */
  assets?: Record<string, string>
  /** A static source's directory for this tag: every asset is `<dir>/<name>`. */
  dir?: string
}

export const assetUrl = (r: Release, name: string): string | undefined => (r.dir ? `${r.dir}/${name}` : r.assets?.[name])

export interface Fetcher {
  json(url: string): Promise<unknown>
  bytes(url: string): Promise<Uint8Array>
  /** Undefined when the file is not there (404); throws on anything else. */
  text(url: string): Promise<string | undefined>
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    url: string,
  ) {
    super(`${url}: HTTP ${status}`)
  }
}

/** {env:}/{file:} in the source filled in (left until now: a missing token file is a failed
 *  update, not a failed start). */
export function resolveSource(source: Source): Source {
  return substituteDeep(source, "update.source")
}

export function fetcher(source: Source, timeoutMs = 30_000): Fetcher {
  const headers: Record<string, string> = { "user-agent": `lembas-cli/${VERSION}` }
  const token = source.token ? source.token : source.key_cmd ? runKeyCmd(source.key_cmd, "update.source.key_cmd") : undefined
  if (token) headers.authorization = source.type === "gitea" ? `token ${token}` : `Bearer ${token}`
  if (source.type === "github") headers.accept = "application/vnd.github+json"
  const tls = tlsFor(source)
  // The token goes only where the source is: an API that names another host for its downloads (a
  // forge with a wrong ROOT_URL, plain http) does not get it.
  const own = new Set([source.url ? new URL(source.url).origin : undefined, source.type === "github" ? new URL(source.url ?? "https://api.github.com").origin : undefined, source.type === "github" ? "https://github.com" : undefined].filter(Boolean) as string[])
  const get = async (url: string, accept?: string) => {
    const h: Record<string, string> = { ...headers, ...(accept ? { accept } : {}) }
    if (!own.has(new URL(url).origin)) delete h.authorization
    const r = await fetch(url, { headers: h, tls, signal: AbortSignal.timeout(timeoutMs) } as RequestInit)
    if (!r.ok) throw new HttpError(r.status, url)
    return r
  }
  return {
    json: async (url) => (await get(url)).json(),
    bytes: async (url) => new Uint8Array(await (await get(url, source.type === "github" && token ? "application/octet-stream" : "*/*")).arrayBuffer()),
    async text(url) {
      try {
        return await (await get(url, "text/plain")).text()
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) return undefined
        throw e
      }
    },
  }
}

type ApiRelease = { tag_name: string; draft?: boolean; assets?: { name: string; browser_download_url: string; url?: string }[] }

/** The releases the source has, newest first or in any order (the caller picks by version). */
export async function listReleases(source: Source, f: Fetcher): Promise<Release[]> {
  if (source.type === "static") {
    const base = (source.url ?? "").replace(/\/+$/, "")
    if (!base) throw new Error("update.source: a static source needs url")
    const out: Release[] = []
    for (const ch of ["stable", "beta"]) {
      const tag = (await f.text(`${base}/${ch}`))?.trim()
      if (!tag) continue
      // A directory has no listing; the assets are found by LLeMbas CLI's own names.
      out.push({ tag, dir: `${base}/${encodeURIComponent(tag)}` })
    }
    return out
  }
  const authed = source.token !== undefined || source.key_cmd !== undefined
  if (!source.repo) throw new Error(`update.source: ${source.type} needs repo (owner/name)`)
  const api =
    source.type === "github"
      ? `${(source.url ?? "https://api.github.com").replace(/\/+$/, "")}/repos/${source.repo}/releases?per_page=30`
      : `${(source.url ?? "").replace(/\/+$/, "")}/api/v1/repos/${source.repo}/releases?limit=30`
  if (source.type === "gitea" && !source.url) throw new Error("update.source: gitea needs url (the forge)")
  let list: ApiRelease[]
  try {
    list = (await f.json(api)) as ApiRelease[]
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) throw new Error(`${source.type} ${source.repo}: no such repository, or it is private and update.source has no token (404)`)
    throw e
  }
  if (!Array.isArray(list)) throw new Error("update.source: the releases API did not answer with a list")
  return list
    .filter((r) => !r.draft)
    .map((r) => ({
      tag: r.tag_name,
      // A private GitHub repository serves an asset through its API address (with the token);
      // browser_download_url would want a browser session.
      assets: Object.fromEntries((r.assets ?? []).map((a) => [a.name, source.type === "github" && authed && a.url ? a.url : a.browser_download_url])),
    }))
}
