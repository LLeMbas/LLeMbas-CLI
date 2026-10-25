// /login and `lembas login`: sign this machine in to a LLeMbas instance, and point LLeMbas CLI at
// it — one `webui` connection, named after the instance (example), and voice and web search through
// it where the instance offers them.
//
// What is written is ordinary configuration, in the files rule 2 allows: one entry in the global
// connections.yaml holding the address and the key as {file:} to a 0600 file beside it, never
// pasted into the YAML. The models are not written anywhere: a webui connection reads them from the
// instance at every start (webui.ts). `lembas.json` remembers which connections a login made, so
// `login` again refreshes them and `logout` removes exactly them. Without a login nothing here is
// read, and LLeMbas CLI runs on its hand-written config as before.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { parseDocument } from "yaml"
import { expandHome, globalPaths, isLocal, paths } from "../config/paths.ts"
import { awaitToken, discover, LembasError, signOut, spoken, startDevice, type DeviceStart, type Discovery, type InstanceInfo, type ServedModel, type Tls } from "./client.ts"
import { dropCache, fetchWebui, isChatModel, readCache, specFor } from "./webui.ts"

export interface Instance {
  base_url: string
  connection: string
  email?: string
  name?: string
  /** The instance's own name (Example). */
  instance_name?: string
  ca?: string
  /** What the token may do, as the instance granted it: `library` in it makes the account's
   *  library the default. An older login has none recorded until it is made again. */
  scope?: string
  /** The link protocols the instance listed when last asked: at login, and again at every
   *  dial of the link, so an instance updated later is picked up. */
  protocols?: number[]
  logged_in_at: string
}

interface Index {
  instances: Record<string, Instance>
}

const indexFile = (dir = paths.config) => join(dir, "lembas.json")
const keyDir = () => join(paths.config, "lembas")
/** Where a login made here keeps its key. */
const ownKeyFile = (connection: string) => join(keyDir(), `${connection}.key`)
/** The key of a login: this mode's own, or — in local mode, for a login made outside it — the
 *  user's, read where it is. */
export const keyFile = (connection: string) => {
  const own = ownKeyFile(connection)
  if (!isLocal() || existsSync(own)) return own
  const theirs = join(globalPaths.config, "lembas", `${connection}.key`)
  return existsSync(theirs) ? theirs : own
}

/** What a later look at the instance said it speaks, kept with the login (not for a login local
 *  mode only reads). */
export function rememberProtocols(connection: string, protocols: number[]) {
  const all = ownInstances()
  const one = all[connection]
  if (!one || JSON.stringify(one.protocols) === JSON.stringify(protocols)) return
  saveIndex({ ...all, [connection]: { ...one, protocols } })
}

function readIndex(dir: string): Record<string, Instance> {
  try {
    const parsed = JSON.parse(readFileSync(indexFile(dir), "utf8")) as Index
    return parsed.instances ?? {}
  } catch {
    return {}
  }
}

/** Every login in force: in local mode the user's own (read only) and the ones made here. */
export function instances(): Record<string, Instance> {
  return isLocal() ? { ...readIndex(globalPaths.config), ...readIndex(paths.config) } : readIndex(paths.config)
}

/** The logins this mode wrote, and may change: all of them, or in local mode the local ones. */
export function ownInstances(): Record<string, Instance> {
  return readIndex(paths.config)
}

function saveIndex(all: Record<string, Instance>) {
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(indexFile(), JSON.stringify({ instances: all }, null, 2) + "\n", { mode: 0o600 })
}

type Doc = ReturnType<typeof parseDocument>

function readYamlDoc(file: string): Doc {
  const doc = parseDocument(existsSync(file) ? readFileSync(file, "utf8") : "")
  if (!doc.contents) doc.contents = doc.createNode({}) as never
  return doc
}

const connectionsFile = () => join(paths.config, "connections.yaml")
const configFile = () => join(paths.config, "config.yaml")

function writeYamlDoc(file: string, doc: Doc, mode?: number) {
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(file, doc.toString(), mode ? { mode } : undefined)
  if (mode) chmodSync(file, mode)
}

/** What to call the instance's connection: the name it gives itself (`example`), or — from an
 *  instance that gives none — its host's first label. Never one the user wrote by hand:
 *  that gets `-lembas` after it. */
export function connectionNameFor(baseUrl: string, preferred?: string): string {
  let name = (preferred ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "")
  if (!name) {
    const host = new URL(baseUrl).hostname
    const first = (/^\d+(\.\d+){3}$/.test(host) ? host.replace(/\./g, "-") : host.split(".")[0]!).toLowerCase()
    name = first.replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "") || "lembas"
  }
  const ours = Object.values(instances()).some((i) => i.connection === name && i.base_url === baseUrl)
  if (ours) return name
  return readYamlDoc(connectionsFile()).hasIn(["connections", name]) ? `${name}-lembas` : name
}

export function writeConnection(connection: string, d: Discovery, tls: Tls | undefined) {
  const doc = readYamlDoc(connectionsFile())
  const entry: Record<string, unknown> = {
    type: "webui",
    url: d.base_url,
    api_key: `{file:${ownKeyFile(connection)}}`,
    ...(tls?.ca ? { tls: { ca: tls.ca } } : {}),
  }
  doc.setIn(["connections", connection], doc.createNode(entry))
  const node = doc.getIn(["connections", connection], true) as { commentBefore?: string } | undefined
  if (node)
    node.commentBefore = ` ${d.name ?? "LLeMbas"} at ${d.base_url}, written by \`lembas login\`. Its models and their settings come from the instance at every start; \`lembas logout ${connection}\` removes it.`
  writeYamlDoc(connectionsFile(), doc, 0o600)
}

/** A model ref `old/x` as `new/x`; anything else unchanged. */
function renamed(ref: unknown, from: string, to: string): unknown {
  return typeof ref === "string" && ref.startsWith(`${from}/`) ? `${to}/${ref.slice(from.length + 1)}` : ref
}

/** An older kind of login named the connection after the host (`ai`) and copied every model
 *  into it. Logging in again replaces it with the webui one: the old entry, key and cache go, and
 *  config.yaml's model refs follow the new name. A start model that was only the instance's
 *  default goes too, so the instance decides it from now on. Returns what changed, in words. */
function replaceOld(old: string, now: string, instanceDefault: string | undefined): string[] {
  const said: string[] = []
  const conns = readYamlDoc(connectionsFile())
  if (conns.hasIn(["connections", old])) {
    conns.deleteIn(["connections", old])
    writeYamlDoc(connectionsFile(), conns, 0o600)
  }
  rmSync(ownKeyFile(old), { force: true })
  dropCache(old)
  said.push(`the connection ${old} from an earlier login is now ${now}`)
  if (!existsSync(configFile())) return said
  const cfg = readYamlDoc(configFile())
  let changed = false
  const model = cfg.get("model")
  if (typeof model === "string" && model.startsWith(`${old}/`)) {
    if (instanceDefault && model === `${old}/${instanceDefault}`) {
      cfg.delete("model")
      said.push(`config.yaml no longer pins ${model}: sessions start on the instance's default`)
    } else {
      cfg.set("model", renamed(model, old, now))
      said.push(`config.yaml starts on ${renamed(model, old, now)}`)
    }
    changed = true
  }
  for (const key of ["small_model", "embedding"]) {
    const v = cfg.get(key)
    if (typeof v === "string" && v.startsWith(`${old}/`)) {
      cfg.set(key, renamed(v, old, now))
      changed = true
    }
  }
  if (changed) writeYamlDoc(configFile(), cfg)
  return said
}

/** Voice and web search through the instance, where it offers them and this machine does not
 *  already use it: what the config had becomes the fallback (voice) or comes after it (search).
 *  Returns what changed, in words. */
export function useServices(connection: string, services: InstanceInfo["services"], several: boolean): string[] {
  if (!services) return []
  const said: string[] = []
  const cfg = readYamlDoc(configFile())
  const plain = (path: string[]) => {
    const v = cfg.getIn(path, true) as { toJSON?: () => unknown } | undefined
    return v && typeof v.toJSON === "function" ? (v.toJSON() as Record<string, unknown>) : undefined
  }
  const named = several ? { connection } : {}
  for (const [half, offered, words] of [
    ["stt", services.stt, "voice input"],
    ["tts", services.tts, "voice output"],
  ] as const) {
    if (!offered) continue
    const now = plain(["voice", half])
    if (now?.provider === "webui") continue
    const { fallback: _, ...before } = now ?? {}
    cfg.setIn(["voice", half], cfg.createNode({ provider: "webui", ...named, ...(now ? { fallback: before } : {}) }))
    said.push(`${words} through ${connection}${now ? ` (what was set up stays as its fallback)` : ""}`)
  }
  // Local mode searches without the instance (loadConfig would take it out again).
  if (services.search && !isLocal()) {
    const search = plain(["search"]) ?? {}
    const order = Array.isArray(search.order) ? (search.order as string[]) : undefined
    if (!order?.includes("webui")) {
      // What was tried before is tried after the instance, in the order it was.
      const before = order ?? [...(search.searxng ? ["searxng"] : []), ...(search.firecrawl ? ["firecrawl"] : []), "ddg"]
      cfg.setIn(["search", "order"], ["webui", ...before.filter((p) => p !== "webui")])
      if (several) cfg.setIn(["search", "webui"], cfg.createNode({ connection }))
      said.push(`web search through ${connection} first (then ${before.join(", ")})`)
    }
  }
  if (said.length) writeYamlDoc(configFile(), cfg)
  return said
}

/** Take a connection out of voice and search again: logout. */
function dropServices(connection: string, several: boolean): void {
  if (!existsSync(configFile())) return
  const cfg = readYamlDoc(configFile())
  let changed = false
  const ours = (o: Record<string, unknown> | undefined) => o?.provider === "webui" && (o.connection === connection || (!o.connection && !several))
  for (const half of ["stt", "tts"]) {
    const node = cfg.getIn(["voice", half], true) as { toJSON?: () => unknown } | undefined
    const v = node && typeof node.toJSON === "function" ? (node.toJSON() as Record<string, unknown>) : undefined
    if (!ours(v)) continue
    if (v!.fallback) cfg.setIn(["voice", half], cfg.createNode(v!.fallback))
    else cfg.deleteIn(["voice", half])
    changed = true
  }
  const s = cfg.getIn(["search"], true) as { toJSON?: () => unknown } | undefined
  const search = s && typeof s.toJSON === "function" ? (s.toJSON() as Record<string, unknown>) : undefined
  const webui = search?.webui as { connection?: string } | undefined
  if (search && (webui?.connection === connection || (!webui?.connection && !several))) {
    if (Array.isArray(search.order) && search.order.includes("webui")) {
      cfg.setIn(["search", "order"], (search.order as string[]).filter((p) => p !== "webui"))
      changed = true
    }
    if (webui) {
      cfg.deleteIn(["search", "webui"])
      changed = true
    }
    if (search.fetch === "webui") {
      cfg.deleteIn(["search", "fetch"])
      changed = true
    }
  }
  if (changed) writeYamlDoc(configFile(), cfg)
}

/** The library's embedding model from the instance: with no `embedding:` in config.yaml,
 *  the first model the instance serves as `kind: embedding`, as `<connection>/<served id>` — the
 *  form the embedder resolves whatever the provider is called (library/embed.ts). An embedding the
 *  person set — another instance's, or one of this machine's own — is never replaced: the vectors
 *  already made with it are only found again with it. Returns what changed, in words. */
export function useEmbedding(connection: string, models: ServedModel[]): string[] {
  const first = models.find((m) => m.kind === "embedding")
  // Local mode embeds nothing through the instance.
  if (!first || isLocal()) return []
  const cfg = readYamlDoc(configFile())
  const now = cfg.get("embedding")
  if (typeof now === "string" && now.trim()) return []
  const ref = `${connection}/${first.id}`
  cfg.set("embedding", ref)
  writeYamlDoc(configFile(), cfg)
  return [`the library embeds with ${ref} (embedding:)`]
}

/** Logout: an `embedding:` on the connection that goes would only warn at every start. */
function dropEmbedding(connection: string) {
  if (!existsSync(configFile())) return
  const cfg = readYamlDoc(configFile())
  const v = cfg.get("embedding")
  if (typeof v !== "string" || !v.startsWith(`${connection}/`)) return
  cfg.delete("embedding")
  writeYamlDoc(configFile(), cfg)
}

function currentModel(): string | undefined {
  if (!existsSync(configFile())) return undefined
  const value = parseDocument(readFileSync(configFile(), "utf8")).get("model")
  return typeof value === "string" && value ? value : undefined
}

/** Each served model's ref once this login is in place (by provider, `deepseek/x`; an
 *  instance that does not speak protocol 2, or a provider a connection of the user's own is named after, keeps
 *  `<connection>/<id>`). Read from the configuration as it now is. */
async function refsOf(connection: string): Promise<Record<string, string>> {
  try {
    const { loadConfig } = await import("../config/load.ts")
    const loaded = loadConfig()
    return Object.fromEntries(loaded.refs.filter((r) => r.connection === connection).map((r) => [r.id, r.ref]))
  } catch {
    return {}
  }
}

export interface LoginResult {
  connection: string
  instance: Instance
  models: ServedModel[]
  /** The model a session starts on when config.yaml names none: the instance's default. */
  instanceDefault?: string
  /** The model ref config.yaml starts on, when login set it (--default). */
  defaultSet?: string
  /** What else changed — voice, search, an earlier login replaced — in words. */
  changes: string[]
  version: string
  /** Each served id's ref. */
  refs?: Record<string, string>
}

export interface LoginOptions {
  /** The CA that signed the instance's certificate, when it is not one Bun trusts. */
  ca?: string
  /** Pin config.yaml's model to the instance's default (otherwise it follows the instance). */
  setDefault?: boolean
  /** Leave voice and web search as they are. */
  keepServices?: boolean
  signal?: AbortSignal
  /** Called once with the code to show and where to approve it. */
  onCode: (start: DeviceStart, d: Discovery) => void
  sleep?: (ms: number) => Promise<void>
}

/** The two ways to approve a code, as the person is told them. */
export function codeInstructions(start: DeviceStart, d: Discovery): string {
  const link = start.verification_uri_complete ?? start.verification_uri
  const name = d.name ? `${d.name} (LLeMbas ${d.version})` : `LLeMbas ${d.version}`
  return [
    `Found ${name} at ${d.base_url}. To sign this machine in:`,
    "",
    `  1. Click the link: ${link}`,
    `  2. Copy the code ${start.user_code} into User → Security → Devices`,
    "",
    `It lasts ${Math.round(start.expires_in / 60)} minutes. Waiting…`,
  ].join("\n")
}

/** `lembas login --json`: what a program driving the login (LLeMbas Desktop) reads, one JSON
 *  object per line on stdout — the code to approve, then the outcome. */
export function codeEvent(start: DeviceStart, d: Discovery) {
  return {
    event: "code" as const,
    user_code: start.user_code,
    verification_uri: start.verification_uri,
    verification_uri_complete: start.verification_uri_complete ?? start.verification_uri,
    expires_in: start.expires_in,
    instance: { name: d.name ?? null, version: d.version, base_url: d.base_url },
  }
}

export function doneEvent(r: LoginResult, fresh: boolean) {
  return {
    event: "done" as const,
    fresh,
    connection: r.connection,
    base_url: r.instance.base_url,
    version: r.version,
    models: r.models.length,
    changes: r.changes,
  }
}

/** Whether a login's connection is already the webui kind — not an older kind of entry, with
 *  the models copied in, which a login again replaces. */
export function isWebuiEntry(connection: string): boolean {
  const doc = readYamlDoc(connectionsFile()).toJSON() as { connections?: Record<string, { type?: string }> } | null
  return doc?.connections?.[connection]?.type === "webui"
}

/** What a login or a refresh did, as lines for a terminal. */
export function loginSummary(r: LoginResult, fresh: boolean): string[] {
  const out: string[] = []
  const who = r.instance.email ? ` as ${r.instance.email}` : ""
  const label = r.instance.instance_name ? `${r.instance.instance_name} (${r.instance.base_url})` : r.instance.base_url
  out.push(fresh ? `Signed in to ${label}${who}. Connection ${r.connection}: ${r.models.length} model${r.models.length === 1 ? "" : "s"}, read from the instance at every start.` : `${r.connection}: ${r.models.length} model${r.models.length === 1 ? "" : "s"} from ${label} (LLeMbas ${r.version}).`)
  const refOf = (id: string) => r.refs?.[id] ?? `${r.connection}/${id}`
  for (const m of r.models) out.push(`  ${refOf(m.id)}${m.context ? `  ${Math.round(m.context / 1024)}k` : ""}${m.id === r.instanceDefault ? "  (the instance's default)" : ""}`)
  const model = currentModel()
  if (r.defaultSet) out.push(`Sessions start on ${r.defaultSet}.`)
  else if (!model && r.instanceDefault) out.push(`Sessions start on the instance's default, ${refOf(r.instanceDefault)}.`)
  else if (model) out.push(`Sessions start on ${model} (config.yaml).`)
  for (const c of r.changes) out.push(`· ${c}`)
  if (r.instance.ca) out.push(`TLS: trusting ${r.instance.ca} for this connection.`)
  return out
}

function webuiCount(): number {
  const doc = readYamlDoc(connectionsFile()).toJSON() as { connections?: Record<string, { type?: string }> } | null
  return Object.values(doc?.connections ?? {}).filter((c) => c?.type === "webui").length
}

export async function login(address: string, o: LoginOptions): Promise<LoginResult> {
  // Kept as a full path: `lembas service` and Desktop read it from another directory.
  const ca = o.ca ? resolve(expandHome(o.ca)) : undefined
  const { discovery, tls } = await discover(address, ca ? { ca } : undefined)
  const start = await startDevice(discovery, tls)
  o.onCode(start, discovery)
  const granted = await awaitToken(discovery, start, tls, { signal: o.signal, sleep: o.sleep })

  const connection = connectionNameFor(discovery.base_url, discovery.connection)
  // Logging in again under the same name: the token being replaced, read before its file is.
  const before = ownInstances()[connection]
  const replaced = before?.base_url === discovery.base_url && existsSync(ownKeyFile(connection)) ? readFileSync(ownKeyFile(connection), "utf8").trim() : ""
  mkdirSync(keyDir(), { recursive: true, mode: 0o700 })
  writeFileSync(ownKeyFile(connection), granted.access_token + "\n", { mode: 0o600 })
  chmodSync(ownKeyFile(connection), 0o600)
  const fetched = await fetchWebui(connection, discovery.base_url, granted.access_token, tls)
  const instanceDefault = fetched.instance?.default_model ?? fetched.models.find((m) => m.default)?.id ?? undefined

  const changes: string[] = []
  // The old token is signed out too: this machine holds one, the new one. Over the TLS that has
  // just worked (the old login's CA may be what was wrong), naming the new token, so the instance
  // moves the old device's agent chats to it instead of keeping an offline twin.
  const handOver = async (old: string) => {
    if (old && old !== granted.access_token && !(await signOut(discovery.base_url, old, tls, granted.access_token)))
      changes.push("the previous login could not be signed out: revoke it under User → Security → Devices on the instance")
  }
  await handOver(replaced)
  // Only logins this mode made: in local mode, the user's own login to the same instance is not
  // signed out or replaced — it is not this project's.
  const known = ownInstances()
  for (const [name, old] of Object.entries(known))
    if (name !== connection && old.base_url === discovery.base_url) {
      if (existsSync(ownKeyFile(name))) await handOver(readFileSync(ownKeyFile(name), "utf8").trim())
      changes.push(...replaceOld(name, connection, instanceDefault))
      delete known[name]
    }

  writeConnection(connection, discovery, tls)
  const instance: Instance = {
    base_url: discovery.base_url,
    connection,
    email: granted.account?.email,
    name: granted.account?.name,
    ...(discovery.name ? { instance_name: discovery.name } : {}),
    ...(tls?.ca ? { ca: tls.ca } : {}),
    ...(granted.scope ? { scope: granted.scope } : {}),
    protocols: spoken(discovery),
    logged_in_at: new Date().toISOString(),
  }
  saveIndex({ ...known, [connection]: instance })
  if (!o.keepServices) changes.push(...useServices(connection, fetched.instance?.services, webuiCount() > 1))
  changes.push(...useEmbedding(connection, fetched.models))
  const refs = await refsOf(connection)
  let defaultSet: string | undefined
  if (o.setDefault && instanceDefault) {
    const cfg = readYamlDoc(configFile())
    defaultSet = refs[instanceDefault] ?? `${connection}/${instanceDefault}`
    cfg.set("model", defaultSet)
    writeYamlDoc(configFile(), cfg)
  }
  // Chat models only: what the summary lists is what /model offers.
  return { connection, instance, models: fetched.models.filter(isChatModel), instanceDefault, defaultSet, changes, version: discovery.version, refs }
}

function tokenOf(connection: string): string {
  try {
    return readFileSync(keyFile(connection), "utf8").trim()
  } catch {
    throw new LembasError(`no stored sign-in for ${connection} — run lembas login`)
  }
}

/** Read the account's models again now (every start does this anyway). */
export async function sync(connection: string, o: { setDefault?: boolean } = {}): Promise<LoginResult> {
  const instance = instances()[connection]
  if (!instance) throw new LembasError(`${connection} was not made by lembas login`)
  const { discovery, tls } = await discover(instance.base_url, instance.ca ? { ca: instance.ca } : undefined)
  const fetched = await fetchWebui(connection, discovery.base_url, tokenOf(connection), tls)
  const instanceDefault = fetched.instance?.default_model ?? fetched.models.find((m) => m.default)?.id ?? undefined
  // Logging in again reads the models again: an embedding model the instance has added since is
  // taken up the same way, still only where none is set.
  const changes = useEmbedding(connection, fetched.models)
  const refs = await refsOf(connection)
  let defaultSet: string | undefined
  if (o.setDefault && instanceDefault) {
    const cfg = readYamlDoc(configFile())
    defaultSet = refs[instanceDefault] ?? `${connection}/${instanceDefault}`
    cfg.set("model", defaultSet)
    writeYamlDoc(configFile(), cfg)
  }
  return { connection, instance, models: fetched.models.filter(isChatModel), instanceDefault, defaultSet, changes, version: discovery.version, refs }
}

export interface LogoutResult {
  connection: string
  revoked: boolean
  /** config.yaml still names a model on the removed connection. */
  modelLeft?: string
}

export async function logout(connection: string): Promise<LogoutResult> {
  const all = ownInstances()
  if (!all[connection] && instances()[connection])
    throw new LembasError(`${connection} was signed in outside local mode, and local mode only reads that sign-in — lembas logout without -l signs it out`)
  const instance = all[connection]
  if (!instance) throw new LembasError(`${connection} was not made by lembas login${Object.keys(all).length ? ` — logged in: ${Object.keys(all).join(", ")}` : ""}`)
  // Whether config.yaml starts on one of its models — by provider (`deepseek/x`) the ref
  // no longer names the connection, so it is asked before the connection goes.
  let ours = false
  try {
    const { loadConfig } = await import("../config/load.ts")
    const { findRef } = await import("../provider/refs.ts")
    const loaded = loadConfig()
    const m = currentModel()
    ours = Boolean(m && findRef(loaded.connections, loaded.refs, m)?.connection === connection)
  } catch {}
  let revoked = false
  if (existsSync(ownKeyFile(connection))) {
    revoked = await signOut(instance.base_url, tokenOf(connection), instance.ca ? { ca: instance.ca } : undefined)
    rmSync(ownKeyFile(connection), { force: true })
  }
  const several = webuiCount() > 1
  const doc = readYamlDoc(connectionsFile())
  if (doc.hasIn(["connections", connection])) {
    doc.deleteIn(["connections", connection])
    writeYamlDoc(connectionsFile(), doc, 0o600)
  }
  dropCache(connection)
  dropServices(connection, several)
  dropEmbedding(connection)
  delete all[connection]
  saveIndex(all)
  const model = currentModel()
  return { connection, revoked, modelLeft: model && (ours || model.startsWith(`${connection}/`)) ? model : undefined }
}

export { LembasError, readCache, specFor }
