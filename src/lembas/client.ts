// Talking to a LLeMbas instance: finding it, signing this machine in by device code (RFC 8628),
// reading the account's models and what else it offers, and signing out. The `webui` connection
// (webui.ts) uses the same calls at every start.
//
// The instance's address is all a person types. `/.well-known/lembas.json` says whether it is
// LLeMbas at all, which versions it speaks, and where to log in, so nobody is asked to approve
// anything for a server that only looks like one.
import { existsSync, readFileSync } from "node:fs"
import { hostname } from "node:os"
import { VERSION } from "../version.ts"

/** The device protocol this build speaks (LLeMbas `api/devices.py:PROTOCOL`): 2, the
 *  same number as the link's `_lembas/*` extension (acp/agent.ts LEMBAS_PROTOCOL). */
export const PROTOCOL = 2
/** The ones it can log in to: protocol 2 only adds what both sides name in their capabilities, so an
 *  instance still at 1 works with what it has. */
export const PROTOCOLS = [1, 2]

export class LembasError extends Error {}

export interface Discovery {
  service: "lembas"
  version: string
  /** The instance's own name (Example), where it gives one. */
  name?: string
  /** What a device calls it: its name as a connection name (example). */
  connection?: string
  protocol: number
  /** Every link protocol it speaks (`protocol: 1, protocols: [1, 2]` — `protocol` stays the
   *  lowest, so a client that compares it for equality still logs in). */
  protocols?: number[]
  harness_spec: string
  base_url: string
  api: { openai: string; instance?: string }
  login: { device: { code: string; token: string; verify: string } }
}

/** One entry of /v1/models: OpenAI's fields, then the harness spec's model metadata. */
export interface ServedModel {
  id: string
  name?: string
  family?: string
  context?: number
  max_output?: number
  temperature?: number
  top_p?: number
  efforts?: string[]
  effort?: string
  vision?: boolean
  tools?: boolean
  notes?: string
  capacity?: { group?: string; single_session?: boolean }
  default?: boolean
  /** The provider's slug — the part of `id` before its `/` — and what kind of model it is. */
  provider?: string
  /** "chat", "embedding", "stt", "tts" or "image"; absent from an older instance, which
   *  lists chat models only. */
  kind?: string
}

export interface Tls {
  ca?: string
}

/** Where a CA bundle that includes the system's own (and so an estate's internal CA, once it is
 *  installed system-wide) usually is. Bun trusts its built-in roots, not these, so a private CA
 *  needs naming — and this is the name to try before asking. */
export const SYSTEM_BUNDLES = ["/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt", "/etc/ssl/cert.pem"]

function tlsInit(tls: Tls | undefined): { tls?: { ca: string } } {
  if (!tls?.ca) return {}
  try {
    return { tls: { ca: readFileSync(tls.ca, "utf8") } }
  } catch {
    throw new LembasError(`cannot read the CA file ${tls.ca}`)
  }
}

function untrusted(e: unknown): boolean {
  const code = String((e as { code?: string }).code ?? "")
  return /CERT|SIGNATURE|SELF_SIGNED|UNABLE_TO_GET_ISSUER/.test(code)
}

async function call(url: string, init: RequestInit, tls: Tls | undefined, timeoutMs = 15_000): Promise<Response> {
  try {
    return await fetch(url, { ...init, ...tlsInit(tls), signal: AbortSignal.timeout(timeoutMs) } as RequestInit)
  } catch (e) {
    if (untrusted(e)) throw new LembasError(`the TLS certificate of ${new URL(url).host} is not trusted. Pass --ca <file> with the CA that signed it.`)
    if ((e as Error).name === "TimeoutError") throw new LembasError(`${new URL(url).host} did not answer in time`)
    throw new LembasError(`cannot reach ${new URL(url).host}: ${(e as Error).message}`)
  }
}

/** What a person typed, as a base address: a scheme added (https unless they said http), the path
 *  and a trailing slash dropped. */
export function normalise(address: string): string {
  let a = address.trim()
  if (!a) throw new LembasError("an instance address is needed, e.g. ai.example.org")
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(a)) a = `https://${a}`
  let u: URL
  try {
    u = new URL(a)
  } catch {
    throw new LembasError(`${address} is not an address`)
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new LembasError(`${address}: only http and https`)
  return `${u.protocol}//${u.host}`
}

/** Find the instance. With no CA given and an untrusted certificate, the system's own bundle is
 *  tried once — it is what an internal CA installed on this machine is in — and returned, so the
 *  connection written afterwards uses it too. */
/** The protocols both this CLI and the instance speak: `protocols` where it says, else `protocol`. */
export function spoken(d: Pick<Discovery, "protocol" | "protocols">): number[] {
  const theirs = Array.isArray(d.protocols) && d.protocols.length ? d.protocols : [d.protocol]
  return PROTOCOLS.filter((p) => theirs.includes(p))
}

/** The `_lembas` protocol to say in the link's hello: 2 where the instance lists it, else
 *  1 — an instance that speaks only 1 closes a link that says 2 (4400). Features stay gated by capabilities. */
export function linkProtocol(protocols: number[] | undefined): number {
  return protocols?.includes(2) ? 2 : 1
}

export async function discover(address: string, tls?: Tls): Promise<{ discovery: Discovery; tls?: Tls }> {
  const base = normalise(address)
  const url = `${base}/.well-known/lembas.json`
  let res: Response
  let used = tls
  try {
    res = await call(url, { headers: { accept: "application/json" } }, tls)
  } catch (e) {
    const bundle = SYSTEM_BUNDLES.find((f) => existsSync(f))
    if (tls?.ca || !bundle || !(e instanceof LembasError) || !/not trusted/.test(e.message)) throw e
    used = { ca: bundle }
    res = await call(url, { headers: { accept: "application/json" } }, used)
  }
  if (res.status === 404) throw new LembasError(`${base} answers, but is not a LLeMbas instance (no /.well-known/lembas.json)`)
  if (!res.ok) throw new LembasError(`${base}: ${res.status} ${res.statusText}`)
  let body: Discovery
  try {
    body = (await res.json()) as Discovery
  } catch {
    throw new LembasError(`${base} answered /.well-known/lembas.json with something that is not JSON`)
  }
  if (body?.service !== "lembas") throw new LembasError(`${base} is not a LLeMbas instance`)
  if (!spoken(body).length) throw new LembasError(`${base} speaks device protocol ${body.protocol}; this LLeMbas CLI speaks ${PROTOCOLS.join(" and ")}. Update the older of the two.`)
  if (!body.login?.device?.code) throw new LembasError(`${base} offers no device login`)
  return { discovery: body, tls: used }
}

export interface DeviceStart {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_in: number
  interval: number
}

export async function startDevice(d: Discovery, tls: Tls | undefined, scopes = ["models", "library", "link"]): Promise<DeviceStart> {
  const res = await call(
    d.login.device.code,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_id: `lembas-cli ${VERSION}`,
        // The machine's name alone: the program is said by client_id, and the web UI shows this
        // where room is short.
        device_name: hostname(),
        device_host: hostname(),
        device_platform: `${process.platform}-${process.arch}`,
        scope: scopes.join(" "),
      }),
    },
    tls,
  )
  const body = (await res.json().catch(() => ({}))) as DeviceStart & { error?: string; error_description?: string }
  if (!res.ok) throw new LembasError(body.error_description ?? body.error ?? `${res.status} ${res.statusText}`)
  return body
}

export interface Granted {
  access_token: string
  scope: string
  account: { email?: string; name?: string }
  base_url?: string
}

/** Poll until the person decides, the code runs out, or `signal` stops it. */
export async function awaitToken(d: Discovery, start: DeviceStart, tls: Tls | undefined, opts: { signal?: AbortSignal; sleep?: (ms: number) => Promise<void> } = {}): Promise<Granted> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let interval = Math.max(1, start.interval || 5)
  const deadline = Date.now() + Math.max(1, start.expires_in) * 1000
  while (Date.now() < deadline) {
    await sleep(interval * 1000)
    if (opts.signal?.aborted) throw new LembasError("cancelled")
    const res = await call(
      d.login.device.token,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: start.device_code }),
      },
      tls,
    )
    const body = (await res.json().catch(() => ({}))) as Granted & { error?: string }
    if (res.ok && body.access_token) return body
    switch (body.error) {
      case "authorization_pending":
        continue
      case "slow_down":
        interval += 5
        continue
      case "access_denied":
        throw new LembasError("the sign-in was denied on the instance")
      case "expired_token":
        throw new LembasError("the code expired before it was approved — run login again")
      default:
        throw new LembasError(`the instance refused the sign-in: ${body.error ?? `${res.status} ${res.statusText}`}`)
    }
  }
  throw new LembasError("the code expired before it was approved — run login again")
}

export async function models(d: { api: { openai: string } }, token: string, tls: Tls | undefined, timeoutMs?: number): Promise<ServedModel[]> {
  const res = await call(`${d.api.openai}/models`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } }, tls, timeoutMs)
  if (res.status === 401) throw new LembasError("the instance no longer accepts this sign-in — run login again")
  if (res.status === 403) throw new LembasError("this account may not use the instance's models through the API (the “Use the API” permission)")
  if (!res.ok) throw new LembasError(`listing the models: ${res.status} ${res.statusText}`)
  const body = (await res.json()) as { data?: ServedModel[] }
  return Array.isArray(body.data) ? body.data : []
}

/** GET /api/v1/instance: the instance by name, the account's default model, and
 *  which of voice and web search it may use through the API. */
export interface InstanceInfo {
  name?: string
  connection?: string
  version?: string
  default_model?: string | null
  services?: { stt?: boolean; tts?: boolean; search?: boolean; fetch?: boolean }
}

/** The instance's own description; undefined from an instance that does not have it (a 404). */
export async function instanceInfo(base: string, token: string, tls: Tls | undefined, timeoutMs?: number): Promise<InstanceInfo | undefined> {
  const res = await call(`${base}/api/v1/instance`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } }, tls, timeoutMs)
  if (res.status === 404) return undefined
  if (res.status === 401) throw new LembasError("the instance no longer accepts this sign-in — run login again")
  if (!res.ok) throw new LembasError(`reading the instance: ${res.status} ${res.statusText}`)
  const body = (await res.json().catch(() => undefined)) as InstanceInfo | undefined
  return body && typeof body === "object" ? body : undefined
}

/** Revoke this machine's token on the instance. Best-effort: signing out locally goes ahead even
 *  when the instance cannot be reached, and says so. */
export async function signOut(baseUrl: string, token: string, tls: Tls | undefined): Promise<boolean> {
  try {
    const res = await call(`${baseUrl}/api/v1/token`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } }, tls)
    return res.ok || res.status === 401
  } catch {
    return false
  }
}

/** GET /v1/usage: the account's credits this month, and this device's share. Every
 *  number is null on an instance that keeps no credits or plans. */
export interface Usage {
  plan: { name: string; credits_per_month: number } | null
  balance: number | null
  /** `cost` null where the instance keeps no credits. */
  month: { from: string; tokens_in: number; tokens_out: number; cost: number | null; cost_money?: number | null }
  device: { tokens_in: number; tokens_out: number; cost: number | null; cost_money?: number | null }
  unit: string
  // Every one optional: an instance may have none of them.
  /** The money credits are counted in: "EUR", "USD" or "GBP". */
  currency?: string
  /** What one credit is worth, in `currency`. */
  credit_value?: number | null
  /** An administrator: no limit, never refused — the spend is still counted. */
  admin?: boolean
  /** The balance in `currency`. `month.cost_money`, `device.cost_money` likewise. */
  balance_money?: number | null
  /** Rolling spending windows (e.g. five hours, a week): how much of each is used, and when the
   *  oldest of it frees again. */
  windows?: { window: string | number; limit: number | null; spent: number; frees_at?: string | null }[]
}

/** The usage, or undefined from an instance that does not have the endpoint. */
export async function usage(base: string, token: string, tls: Tls | undefined, timeoutMs = 5000): Promise<Usage | undefined> {
  const res = await call(`${base}/v1/usage`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } }, tls, timeoutMs)
  if (res.status === 404) return undefined
  if (res.status === 401) throw new LembasError("the instance no longer accepts this sign-in — run login again")
  if (!res.ok) throw new LembasError(`reading the usage: ${res.status} ${res.statusText}`)
  const body = (await res.json().catch(() => undefined)) as Usage | undefined
  return body && typeof body === "object" ? body : undefined
}

/** GET/PUT /v1/me/personalization: how the account wants to be helped, the same
 *  three things a person says about themselves here (personality, personality_custom, instructions).
 *  `available`: the administrator allows it; `enabled`: and the person has it on. */
export interface Personalization {
  enabled: boolean
  available: boolean
  personality: string
  personality_custom: string
  instructions: string
}

function asPersonalization(b: unknown): Personalization | undefined {
  if (!b || typeof b !== "object") return undefined
  const o = b as Record<string, unknown>
  const str = (v: unknown) => (typeof v === "string" ? v : "")
  return { enabled: o.enabled === true, available: o.available === true, personality: str(o.personality), personality_custom: str(o.personality_custom), instructions: str(o.instructions) }
}

/** The account's personalization, or undefined from an instance without the endpoint. */
export async function personalization(base: string, token: string, tls: Tls | undefined, timeoutMs = 5000): Promise<Personalization | undefined> {
  const res = await call(`${base}/v1/me/personalization`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } }, tls, timeoutMs)
  if (res.status === 404) return undefined
  if (res.status === 401) throw new LembasError("the instance no longer accepts this sign-in — run login again")
  if (!res.ok) throw new LembasError(`reading the personalization: ${res.status} ${res.statusText}`)
  return asPersonalization(await res.json().catch(() => undefined))
}

/** Write it back (the CLI's /settings, logged in). 403: not available, or a token that is not a
 *  device's; 422: a field of the wrong type. */
export async function savePersonalization(base: string, token: string, tls: Tls | undefined, value: Partial<Omit<Personalization, "available">>, timeoutMs = 10_000): Promise<Personalization | undefined> {
  const res = await call(
    `${base}/v1/me/personalization`,
    { method: "PUT", headers: { authorization: `Bearer ${token}`, accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(value) },
    tls,
    timeoutMs,
  )
  // 403 is two things (not available, or not a device token): the instance's own words, where it
  // says which; 422 a field it would not take.
  if (res.status === 403 || res.status === 422) {
    const detail = await res
      .json()
      .then((b: any) => (typeof b?.detail === "string" ? b.detail : typeof b?.error === "string" ? b.error : ""))
      .catch(() => "")
    if (res.status === 422) throw new LembasError(`the instance would not take that personalization${detail ? `: ${detail}` : ""}`)
    throw new LembasError(detail ? `the instance did not allow it: ${detail}` : "not allowed: the instance refused to save the personalization")
  }
  if (res.status === 401) throw new LembasError("the instance no longer accepts this sign-in — run login again")
  if (!res.ok) throw new LembasError(`saving the personalization: ${res.status} ${res.statusText}`)
  return asPersonalization(await res.json().catch(() => undefined))
}
