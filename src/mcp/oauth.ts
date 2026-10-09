// OAuth for remote MCP servers, after OpenCode (packages/opencode/src/mcp/oauth-provider.ts,
// oauth-callback.ts, auth.ts; MIT, © opencode): the SDK does discovery, dynamic registration,
// PKCE and refresh; this keeps what it hands over (client, tokens) in
// ~/.local/share/lembas/mcp-auth.json (mode 600), keyed by server and checked against its URL,
// and catches the redirect on 127.0.0.1. A sign-in's state and PKCE verifier stay in memory, with
// the sign-in: another LLeMbas CLI connecting meanwhile must not replace them.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs"
import { join } from "node:path"
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js"
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js"
import { paths } from "../config/paths.ts"
import type { McpServer } from "../config/schema.ts"

export const CALLBACK_PORT = 19876
export const CALLBACK_PATH = "/mcp/oauth/callback"

interface Entry {
  url: string
  client?: OAuthClientInformationMixed
  tokens?: OAuthTokens
}

const file = () => join(paths.data, "mcp-auth.json")

/** Every stored sign-in. `strict` (before a write): a file that does not parse is an error, not
 *  an empty one — writing over it would lose every sign-in in it. */
function readAll(strict = false): Record<string, Entry> {
  if (!existsSync(file())) return {}
  try {
    return JSON.parse(readFileSync(file(), "utf8")) as Record<string, Entry>
  } catch (e) {
    if (strict) throw new Error(`${file()} is not valid JSON (${(e as Error).message}); fix or delete it`)
    return {}
  }
}

function writeAll(all: Record<string, Entry>) {
  mkdirSync(paths.data, { recursive: true })
  const tmp = `${file()}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, file())
}

// Stored by name and URL together: a project's server with the same name as one of yours, at
// another address, must not replace (or forget) your sign-in. Entries from before were stored by
// name alone, and are still read when their URL matches.
const keyOf = (name: string, url: string) => `${name} ${url}`

/** What is stored for a server, if it was stored for this URL (a changed URL starts over). */
export function authEntry(name: string, url: string): Entry | undefined {
  const all = readAll()
  const e = all[keyOf(name, url)] ?? all[name]
  return e && e.url === url ? e : undefined
}

function update(name: string, url: string, change: (e: Entry) => void) {
  const all = readAll(true)
  const old = all[keyOf(name, url)] ?? (all[name]?.url === url ? all[name] : undefined)
  const e: Entry = old ?? { url }
  change(e)
  if (all[name]?.url === url) delete all[name]
  all[keyOf(name, url)] = e
  writeAll(all)
}

/** Forget a server's sign-in: at this URL, or (no URL) every one stored under the name. */
export function forget(name: string, url?: string) {
  const all = readAll(true)
  for (const k of Object.keys(all)) if ((k === name && (url === undefined || all[k]!.url === url)) || (url === undefined ? k.startsWith(`${name} `) : k === keyOf(name, url))) delete all[k]
  writeAll(all)
}

type OAuthConfig = Exclude<NonNullable<McpServer["oauth"]>, false>

export class OAuthProvider implements OAuthClientProvider {
  /** Set when the SDK wants the user to authorise: the page to open. */
  authorizationUrl?: URL
  private stateValue?: string
  private verifier?: string

  constructor(
    private name: string,
    private url: string,
    private cfg: OAuthConfig = {},
  ) {}

  get redirectUrl() {
    return `http://127.0.0.1:${this.cfg.callback_port ?? CALLBACK_PORT}${CALLBACK_PATH}`
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "LLeMbas CLI",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.cfg.client_secret ? "client_secret_post" : "none",
      ...(this.cfg.scope ? { scope: this.cfg.scope } : {}),
    }
  }

  state(): string {
    this.stateValue = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("")
    return this.stateValue
  }

  expectedState(): string | undefined {
    return this.stateValue
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    if (this.cfg.client_id) return { client_id: this.cfg.client_id, ...(this.cfg.client_secret ? { client_secret: this.cfg.client_secret } : {}) }
    return authEntry(this.name, this.url)?.client
  }

  saveClientInformation(info: OAuthClientInformationMixed) {
    update(this.name, this.url, (e) => (e.client = info))
  }

  tokens(): OAuthTokens | undefined {
    return authEntry(this.name, this.url)?.tokens
  }

  saveTokens(tokens: OAuthTokens) {
    update(this.name, this.url, (e) => (e.tokens = tokens))
  }

  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url
  }

  saveCodeVerifier(v: string) {
    this.verifier = v
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error("no PKCE verifier — start the sign-in again")
    return this.verifier
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "verifier" || scope === "all") this.verifier = undefined
    if (scope === "verifier" || scope === "discovery") return
    if (scope === "all") return forget(this.name, this.url)
    update(this.name, this.url, (e) => {
      if (scope === "client") delete e.client
      if (scope === "tokens") delete e.tokens
    })
  }
}

/** The authorisation code from what the user has: the whole redirect URL, or the code itself. */
export function codeFrom(input: string): { code: string; state?: string; fromUrl?: boolean } {
  const t = input.trim()
  try {
    const u = new URL(t)
    const code = u.searchParams.get("code")
    if (code) return { code, state: u.searchParams.get("state") ?? undefined, fromUrl: true }
  } catch {}
  return { code: t }
}

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** Wait for the browser's redirect on 127.0.0.1. `code` resolves with the code, or rejects on an
 *  error from the server or after `timeoutMs`. Only a request carrying this sign-in's state is
 *  acted on: any web page can reach 127.0.0.1, and must not be able to end the sign-in. `error`:
 *  the port could not be listened on (a pasted address is then the only way). */
export function waitForCallback(port: number, expectedState: () => string | undefined, timeoutMs = 5 * 60_000): { code: Promise<string>; stop(): void; error?: Error } {
  let server: ReturnType<typeof Bun.serve> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    clearTimeout(timer)
    server?.stop(true)
    server = undefined
  }
  const page = (title: string, text: string, status = 200) =>
    new Response(`<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><body style="font-family:sans-serif;padding:2em"><h2>${esc(title)}</h2><p>${esc(text)}</p>`, {
      status,
      headers: { "content-type": "text/html; charset=utf-8" },
    })
  let resolve!: (c: string) => void
  let reject!: (e: Error) => void
  const code = new Promise<string>((a, b) => ((resolve = a), (reject = b)))
  // Whoever races it handles a rejection; one nobody is waiting for is not an error.
  code.catch(() => {})
  let error: Error | undefined
  try {
    server = Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch(req) {
        const u = new URL(req.url)
        if (u.pathname !== CALLBACK_PATH) return new Response("not found", { status: 404 })
        const want = expectedState()
        if (!want || u.searchParams.get("state") !== want) return page("Not this sign-in", "This address does not belong to the sign-in LLeMbas CLI is waiting for.", 400)
        const err = u.searchParams.get("error")
        if (err) {
          setTimeout(stop, 100)
          const detail = u.searchParams.get("error_description")
          reject(new Error(`the server refused: ${err}${detail ? ` — ${detail}` : ""}`))
          return page("Sign-in failed", `The server said: ${err}. You can close this tab.`)
        }
        const c = u.searchParams.get("code")
        if (!c) return page("No code", "This address carried no authorisation code.", 400)
        setTimeout(stop, 100)
        resolve(c)
        return page("Signed in", "LLeMbas CLI has the authorisation. You can close this tab.")
      },
    })
    timer = setTimeout(() => {
      stop()
      reject(new Error("no sign-in within 5 minutes"))
    }, timeoutMs)
  } catch (e) {
    error = new Error(`cannot listen on 127.0.0.1:${port} for the sign-in redirect (${(e as Error).message}); paste the redirect address instead`)
    reject(error)
  }
  return { code, stop, error }
}
