// The `webui` connection: one entry in connections.yaml that names a LLeMbas instance and
// nothing else —
//
//   example:
//     type: webui
//     url: https://ai.example.org
//     api_key: "{file:~/.config/lembas/lembas/example.key}"
//
// The models are the instance's, read from its /v1/models with the settings its administrator gave
// them (context, efforts, sampling, capacity), and so are the voice and the web search when
// config.yaml says `provider: webui`. Nothing is copied into the config: a model added, removed or
// given another context on the instance is here at the next start, without logging in again.
//
// LLeMbas CLI speaks to it as an ordinary openai-chat connection at <url>/v1. What the instance said
// last is kept in the state directory, so a start without the network still knows the models; a
// start that can reach the instance reads them again first (`refreshWebui`).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parse } from "yaml"
import { connectionFiles, isLocal, paths } from "../config/paths.ts"
import type { Connection, ModelSpec, WebuiConnection } from "../config/schema.ts"
import { substituteDeep } from "../config/substitute.ts"
import { instanceInfo, LembasError, models as listModels, normalise, personalization, type InstanceInfo, type Personalization, type ServedModel, type Tls } from "./client.ts"

/** What a loaded webui connection carries besides an openai-chat connection's fields. */
export interface WebuiMark {
  /** The instance's base address, without /v1. */
  url: string
  /** The model this account's new chats start on there, as the connection's model id. */
  default?: string
  /** The instance's name (Example), when it said. */
  name?: string
  services?: InstanceInfo["services"]
  /** When the models were last read from the instance; absent: never. */
  fetched_at?: string
  /** The served ids of its embedding models, which are not chat models and so not in
   *  `models`: `embedding: llama/nomic-embed` finds its connection by them (library/embed.ts). */
  embeddings?: string[]
}

export type WebuiLoaded = Connection & { webui: WebuiMark }

export interface Cache {
  fetched_at: string
  url: string
  instance?: InstanceInfo
  models: ServedModel[]
  /** The account's personalization, where the instance has the endpoint. */
  personalization?: Personalization
}

const cacheDir = () => join(paths.state, "webui")
export const cacheFile = (connection: string) => join(cacheDir(), `${connection}.json`)

export function readCache(connection: string): Cache | undefined {
  try {
    const c = JSON.parse(readFileSync(cacheFile(connection), "utf8")) as Cache
    return Array.isArray(c.models) ? c : undefined
  } catch {
    return undefined
  }
}

export function writeCache(connection: string, cache: Cache) {
  mkdirSync(cacheDir(), { recursive: true, mode: 0o700 })
  writeFileSync(cacheFile(connection), JSON.stringify(cache, null, 2) + "\n", { mode: 0o600 })
}

export function dropCache(connection: string) {
  rmSync(cacheFile(connection), { force: true })
}

/** A served model a session can talk to: `kind` chat, or none (an instance that does not
 *  say `kind` lists nothing else). The others — embedding, stt, tts, image — are no chat model: listed
 *  as one, the model picker offered a speech model to talk to. The embedding ones are the
 *  library's to use (login.ts, useEmbedding); voice reaches stt and tts through the instance's own
 *  endpoints. */
export function isChatModel(m: ServedModel): boolean {
  // Anything but the four non-chat kinds is chat: an instance may put the connection's dialect
  // ("openai", "anthropic") in `kind`, and reading that as "not chat" would leave such an instance
  // with no models at all.
  return !NOT_CHAT.has(String(m.kind ?? ""))
}
const NOT_CHAT = new Set(["embedding", "stt", "tts", "image"])

/** One served model as a LLeMbas CLI model entry. Only what the instance said: an absent field
 *  stays absent, because unknown is not zero. The capacity group is prefixed with the connection,
 *  so the instance's "gpu" is never mistaken for a group of the user's own. */
export function specFor(m: ServedModel, connection: string): ModelSpec {
  const out: Record<string, unknown> = {}
  if (m.name && m.name !== m.id) out.name = m.name
  if (m.family) out.family = m.family
  if (m.context) out.context = m.context
  if (m.max_output) out.max_output = m.max_output
  if (typeof m.temperature === "number" && m.temperature >= 0 && m.temperature <= 2) out.temperature = m.temperature
  if (typeof m.top_p === "number" && m.top_p >= 0 && m.top_p <= 1) out.top_p = m.top_p
  if (m.efforts?.length) out.efforts = m.efforts
  if (m.effort) out.effort = m.effort
  if (m.vision !== undefined) out.vision = m.vision
  if (m.tools !== undefined) out.tools = m.tools
  if (m.notes) out.notes = m.notes.slice(0, 300)
  if (m.capacity?.single_session) out.single_session = true
  if (m.capacity?.group) out.group = `${connection}:${m.capacity.group}`
  return out as ModelSpec
}

/** A webui entry as the openai-chat connection LLeMbas CLI speaks to, with the instance's models
 *  (the account's default first) and anything the entry's own `models:` says on top. */
export function expandWebui(name: string, w: WebuiConnection, cache = readCache(name)): WebuiLoaded {
  const url = normalise(w.url)
  // The cache keeps every kind (login picks the embedding model from it); the connection only chat.
  const all = cache && cache.url === url ? cache.models : []
  const served = all.filter(isChatModel)
  const embeddings = all.filter((m) => m.kind === "embedding").map((m) => m.id)
  const def = cache?.instance?.default_model ?? served.find((m) => m.default)?.id
  const ordered = [...served].sort((a, b) => Number(b.id === def) - Number(a.id === def))
  // The entry's own `models:` go over the instance's — keyed by the served id, or by the bare name an
  // older entry used (`deepseek-flash` for the served `deepseek/deepseek-flash`): the
  // override lands on the real model, not on a model of its own nobody serves.
  const overrides = new Map<string, ModelSpec>()
  const unmatched: [string, ModelSpec][] = []
  for (const [key, spec] of Object.entries(w.models ?? {})) {
    const target = served.some((m) => m.id === key) ? key : served.filter((m) => m.id.slice(m.id.indexOf("/") + 1) === key && m.id.includes("/"))
    if (typeof target === "string") overrides.set(target, { ...overrides.get(target), ...spec })
    else if (target.length === 1) overrides.set(target[0]!.id, { ...spec, ...overrides.get(target[0]!.id) })
    else unmatched.push([key, spec])
  }
  const models: Record<string, ModelSpec> = {}
  for (const m of ordered) models[m.id] = { ...specFor(m, name), ...(overrides.get(m.id) ?? {}) }
  // A model the entry names that the instance does not (yet) list: kept, as written.
  for (const [id, spec] of unmatched) models[id] ??= spec
  return {
    base_url: `${url}/v1`,
    ...(w.api_key !== undefined ? { api_key: w.api_key } : {}),
    ...(w.tls ? { tls: w.tls } : {}),
    ...(w.timeout ? { timeout: w.timeout } : {}),
    ...(w.quirks ? { quirks: w.quirks } : {}),
    models,
    webui: {
      url,
      ...(def && models[def] ? { default: def } : {}),
      ...(cache?.instance?.name ? { name: cache.instance.name } : {}),
      ...(cache?.instance?.services ? { services: cache.instance.services } : {}),
      ...(cache && cache.url === url ? { fetched_at: cache.fetched_at } : {}),
      ...(embeddings.length ? { embeddings } : {}),
    },
  }
}

/** Read the instance's models and services, and keep them. Throws LembasError. */
export async function fetchWebui(name: string, url: string, token: string, tls: Tls | undefined, timeoutMs?: number): Promise<Cache> {
  const base = normalise(url)
  const [served, instance, personal] = await Promise.all([
    listModels({ api: { openai: `${base}/v1` } }, token, tls, timeoutMs),
    instanceInfo(base, token, tls, timeoutMs),
    // Best-effort: an instance may not have it, and a failure here must not cost the models.
    // Not in local mode: the account's settings are not taken into the project.
    isLocal() ? undefined : personalization(base, token, tls, timeoutMs).catch(() => undefined),
  ])
  const cache: Cache = { fetched_at: new Date().toISOString(), url: base, ...(instance ? { instance } : {}), models: served, ...(personal ? { personalization: personal } : {}) }
  writeCache(name, cache)
  return cache
}

/** This process's last refresh that failed, by connection: the loader says so, beside the models
 *  it is using instead. */
export const refreshFailures: Record<string, string> = {}

export interface Refreshed {
  name: string
  ok: boolean
  error?: string
  models?: number
}

/** Every webui connection in connections.yaml, read again from its instance — what a start does
 *  first, so the models are the instance's as they are now. Never throws: an instance that cannot
 *  be reached leaves what was read last, and says so. */
export async function refreshWebui(o: { timeoutMs?: number; only?: string } = {}): Promise<Refreshed[]> {
  // In local mode the user's own connections too, read only; the local file's entries win.
  const raw: Record<string, unknown> = {}
  for (const file of connectionFiles())
    try {
      Object.assign(raw, ((parse(readFileSync(file, "utf8")) ?? {}) as { connections?: Record<string, unknown> }).connections ?? {})
    } catch {}
  const entries = Object.entries(raw).filter(([name, c]) => (!o.only || o.only === name) && (c as { type?: string })?.type === "webui")
  return Promise.all(
    entries.map(async ([name, c]): Promise<Refreshed> => {
      try {
        const w = substituteDeep(c, `connections.${name}`) as WebuiConnection
        const token = w.api_key
        if (!token) throw new LembasError("no key (lembas login)")
        const got = await fetchWebui(name, w.url, token.trim(), w.tls, o.timeoutMs ?? 4000)
        delete refreshFailures[name]
        return { name, ok: true, models: got.models.length }
      } catch (e) {
        refreshFailures[name] = (e as Error).message
        return { name, ok: false, error: (e as Error).message }
      }
    }),
  )
}
