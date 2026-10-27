import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { isScalar, parse, parseDocument } from "yaml"
import { z } from "zod"
import { connectionFiles, isLocal, paths } from "./paths.ts"
import { asMode, Config, McpServer, PERSONALITIES, renamePermissionKeys, WebuiConnection, type Connection, type PermissionConfig } from "./schema.ts"
import { substituteDeep } from "./substitute.ts"
import { expandWebui, refreshFailures, type WebuiMark } from "../lembas/webui.ts"
import { defaultLibrary, withInstancePersonalization } from "../lembas/personal.ts"
import { instances } from "../lembas/login.ts"
import { findRef, modelRefs, type ModelRef } from "../provider/refs.ts"

export class ConfigError extends Error {}

export interface Loaded {
  config: Config
  /** The LLeMbas server this machine is logged in to — at most one: its `webui` entry as the
   *  `/v1` it is spoken to at, with its models and a `webui` mark (custom connections are gone). */
  connections: Record<string, Connection & { webui?: WebuiMark }>
  /** Connections whose {env:}/{file:} substitution failed, with the reason. Unusable, not fatal. */
  broken: Record<string, string>
  /** Permission rulesets in precedence order (global first). */
  permissions: PermissionConfig[]
  /** Where each of `permissions` came from: a project's rules cannot loosen a global one. */
  permissionSources: ("global" | "project")[]
  /** MCP servers, substituted; where each came from. A server whose substitution failed is in
   *  `broken` under `mcp:<name>`. */
  mcp: Record<string, McpServer & { source: "global" | "project" }>
  warnings: string[]
  files: string[]
  /** `instructions` from both files, kept apart: a project's may only name files inside it. */
  instructions: { path: string; global: boolean }[]
  /** Every model with its ref (an instance's by provider, `deepseek/deepseek-flash`). */
  refs: ModelRef[]
  /** The webui connection whose account's personalization is in force: /settings writes
   *  personality, personality_custom and instructions back there. */
  personalFrom?: string
}

function readYaml(file: string): unknown {
  try {
    return parse(readFileSync(file, "utf8")) ?? {}
  } catch (e) {
    throw new ConfigError(`${file}: ${(e as Error).message}`)
  }
}

function validate<S extends z.ZodType>(schema: S, value: unknown, file: string): z.infer<S> {
  const r = schema.safeParse(value)
  if (!r.success) {
    const lines = r.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
    throw new ConfigError(`${file} is invalid:\n${lines.join("\n")}`)
  }
  return r.data
}

/** config.yaml: everything substituted except `mcp` and `voice`, whose parts are substituted one
 *  by one later (a missing variable for one server or endpoint must not break the whole file). */
const MODE_RANK = { auto: 0, edit: 1, manual: 2, plan: 3 } as const

/** A project's change to a global server, kept only where it narrows: off, fewer tools, less in
 *  the prompt, shorter waits. It never turns on what the user turned off. */
function narrowed(base: McpServer, o: Record<string, unknown>): McpServer {
  const out: Record<string, unknown> = { ...base }
  for (const k of ["enabled", "instructions", "prompts", "resources"] as const) if (o[k] === false) out[k] = false
  for (const k of ["timeout", "connect_timeout"] as const) {
    const v = o[k]
    if (typeof v === "number" && (base[k] === undefined || v < base[k]!)) out[k] = v
  }
  const t = (o.tools ?? {}) as { include?: string[]; exclude?: string[] }
  if (t.include || t.exclude) {
    const include = base.tools?.include ? (t.include ? base.tools.include.filter((x) => t.include!.includes(x)) : base.tools.include) : t.include
    const exclude = [...new Set([...(base.tools?.exclude ?? []), ...(t.exclude ?? [])])]
    out.tools = { ...(include ? { include } : {}), ...(exclude.length ? { exclude } : {}) }
  }
  return out as McpServer
}

// What a project may change about a server the global config defines, without redefining it.
const MCP_OVERRIDE = new Set(["enabled", "tools", "timeout", "connect_timeout", "prompts", "resources", "instructions"])

/** A project's config with every {env:}/{file:} value taken out (`removed` names them): only the
 *  user's own files may put a secret from the environment or a file into a URL or a header. */
function withoutPlaceholders(v: unknown, path: string, removed: string[]): unknown {
  if (typeof v === "string") return /\{(env|file):[^}]+\}/.test(v) ? (removed.push(path), undefined) : v
  if (Array.isArray(v)) return v.map((x, i) => withoutPlaceholders(x, `${path}[${i}]`, removed)).filter((x) => x !== undefined)
  if (v && typeof v === "object") {
    // A placeholder in one of its own values takes out the whole entry (a search service, an MCP
    // server): what is left of it would be broken, or would go where it was not meant to.
    const own = Object.entries(v).filter(([, x]) => typeof x === "string" && /\{(env|file):[^}]+\}/.test(x))
    if (own.length) {
      for (const [k] of own) removed.push(path ? `${path}.${k}` : k)
      return undefined
    }
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) {
      const y = withoutPlaceholders(x, path ? `${path}.${k}` : k, removed)
      if (y !== undefined) out[k] = y
    }
    return out
  }
  return v
}

/** What was taken out or reshaped, read from an older config, so an old file still
 *  starts: crowd chats and named personalities are gone (dropped, said once), a personality that
 *  is not a preset any more becomes none, and `instructions` as a list of files is now
 *  `instruction_files` (`instructions` became the custom-instructions text). */
function legacyKeys(all: Record<string, unknown>, file: string, notes: string[]) {
  if ("crowd" in all) {
    delete all.crowd
    notes.push(`${file}: crowd chats were removed; \`crowd\` is ignored — delete it`)
  }
  if ("personalities" in all) {
    delete all.personalities
    notes.push(`${file}: named personalities were removed; \`personalities\` is ignored — personality is one of ${PERSONALITIES.join(", ")} now (custom takes personality_custom)`)
  }
  const p = all.personality
  if (p !== undefined && !(typeof p === "string" && (p === "" || (PERSONALITIES as readonly string[]).includes(p)))) {
    delete all.personality
    if (!(typeof p === "string" && ["none", "default", "neutral"].includes(p.toLowerCase())))
      notes.push(`${file}: personality "${String(p)}" is not a preset any more (${PERSONALITIES.join(", ")}); none is used`)
  }
  // compaction.prune cut old tool outputs in place, which threw the prompt cache away; harness spec
  // 3.0.0 never rewrites what was sent (context.md), so the key is gone.
  const comp = all.compaction
  if (comp && typeof comp === "object" && !Array.isArray(comp) && "prune" in comp) {
    const { prune: _, ...rest } = comp as Record<string, unknown>
    all.compaction = rest
    notes.push(`${file}: compaction.prune was removed — old tool outputs are no longer cut afterwards; delete it`)
  }
  // One file written as a plain string, not a list: read as the list of that one, not dropped
  // without a word by the schema.
  if (typeof all.instruction_files === "string") {
    all.instruction_files = all.instruction_files.trim() ? [all.instruction_files] : []
    notes.push(`${file}: instruction_files is a list; the one file given is read as a list of one — write it as [${String((all.instruction_files as string[])[0] ?? "")}]`)
  }
  if (Array.isArray(all.instructions)) {
    all.instruction_files = [...(Array.isArray(all.instruction_files) ? all.instruction_files : []), ...all.instructions]
    delete all.instructions
    notes.push(`${file}: \`instructions\` is the custom-instructions text now; the list of files is read as instruction_files — rename it`)
  }
}

function readConfig(file: string, label: string, notes: string[], dropped?: string[], mcpOverrides?: Record<string, Record<string, unknown>>, placeholders?: string[]): Config {
  const raw = readYaml(file)
  let all = raw && typeof raw === "object" ? { ...(raw as Record<string, unknown>) } : {}
  if (placeholders) all = withoutPlaceholders(all, "", placeholders) as Record<string, unknown>
  legacyKeys(all, file, notes)
  // A project's global-only keys go before validation: ignored, so their shape cannot break the file.
  if (dropped)
    for (const k of GLOBAL_ONLY)
      if (k in all) {
        delete all[k]
        dropped.push(k)
      }
  // mcp, voice and search are filled in later, one server / half / service at a time: a key that
  // cannot be read turns off that one thing instead of the whole file.
  // update: filled in when an update is looked for — a token file missing must not stop a start.
  let { mcp, voice, search, update, ...rest } = all
  // Names the harness spec renamed (v1): an old mode or permission key is read as the new one.
  if (typeof rest.mode === "string") rest.mode = asMode(rest.mode) ?? rest.mode
  if (rest.permission && typeof rest.permission === "object" && !Array.isArray(rest.permission)) rest.permission = renamePermissionKeys(rest.permission as Record<string, unknown>)
  // A project's entry that only switches a global server off or narrows it (no command, no url)
  // is kept apart: on its own it is not a valid server.
  if (mcpOverrides && mcp && typeof mcp === "object" && !Array.isArray(mcp)) {
    const full: Record<string, unknown> = {}
    for (const [name, v] of Object.entries(mcp as Record<string, unknown>)) {
      const keys = v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v) : []
      if (keys.length && keys.every((k) => MCP_OVERRIDE.has(k))) mcpOverrides[name] = v as Record<string, unknown>
      else full[name] = v
    }
    mcp = full
  }
  return validate(Config, { ...substituteDeep(rest, label), ...(mcp === undefined ? {} : { mcp }), ...(voice === undefined ? {} : { voice }), ...(search === undefined ? {} : { search }), ...(update === undefined ? {} : { update }) }, file)
}

/** Objects merge key by key; anything else is replaced. Permission is handled separately (it stacks). */
function merge<T extends Record<string, unknown>>(a: T, b: Partial<T>): T {
  const out: Record<string, unknown> = { ...a }
  for (const [k, v] of Object.entries(b)) {
    const prev = out[k]
    out[k] =
      v && typeof v === "object" && !Array.isArray(v) && prev && typeof prev === "object" && !Array.isArray(prev)
        ? merge(prev as Record<string, unknown>, v as Record<string, unknown>)
        : v
  }
  return out as T
}

// Keys a project may never set: they would let a cloned repository weaken the floor. The custom
// instructions and a custom personality's text are the person's own words, put last in the system
// prompt as theirs: a repository writing them would speak in the user's voice.
// A personality preset's name is only a choice among the shipped texts, and stays a project's to make.
const GLOBAL_ONLY = ["hardline_extra", "hardline_disable", "voice", "update", "settings_tool", "embedding", "remote", "library", "prototypes", "instructions", "personality_custom"] as const

export function loadConfig(opts: { projectConfigDir?: string; trusted?: boolean } = {}): Loaded {
  const warnings: string[] = []
  const files: string[] = []

  const globalFile = join(paths.config, "config.yaml")
  let config: Config = {}
  const permissions: PermissionConfig[] = []
  const permissionSources: ("global" | "project")[] = []
  if (existsSync(globalFile)) {
    config = readConfig(globalFile, "config.yaml", warnings)
    files.push(globalFile)
    if (config.permission) permissions.push(config.permission), permissionSources.push("global")
  }
  const instructions: { path: string; global: boolean }[] = (config.instruction_files ?? []).map((path) => ({ path, global: true }))

  const mcpSources: Record<string, "global" | "project"> = {}
  for (const name of Object.keys(config.mcp ?? {})) mcpSources[name] = "global"

  if (opts.projectConfigDir && opts.trusted) {
    const projectFile = join(opts.projectConfigDir, "config.yaml")
    if (existsSync(projectFile)) {
      const dropped: string[] = []
      const placeholders: string[] = []
      const overrides: Record<string, Record<string, unknown>> = {}
      const project = readConfig(projectFile, "project config.yaml", warnings, dropped, overrides, placeholders)
      for (const key of dropped) warnings.push(`${projectFile}: \`${key}\` is honoured only in the global config; ignored`)
      for (const at of placeholders) warnings.push(`${projectFile}: ${at} uses {env:} or {file:}, which only the global config may; ignored`)
      files.push(projectFile)
      // The settings tool's gate is global-only (settings_tool); a project rule for it would open it.
      if (project.permission && "settings" in project.permission) {
        delete project.permission.settings
        warnings.push(`${projectFile}: permission.settings is honoured only in the global config (settings_tool); ignored`)
      }
      if (project.permission) permissions.push(project.permission), permissionSources.push("project")
      // A project may make the starting mode stricter than the user's, never looser.
      const own = config.mode ?? "manual"
      if (project.mode && MODE_RANK[project.mode] < MODE_RANK[own]) {
        warnings.push(`${projectFile}: mode ${project.mode} is looser than your own (${own}); a project can only make it stricter — ${own} it is`)
        delete project.mode
      }
      for (const name of Object.keys(project.mcp ?? {})) mcpSources[`project:${name}`] = "project"
      const { permission: _, mcp: projectMcp, instruction_files: projectInstructions, ...rest } = project
      // A search service the project names replaces yours whole: merged field by field, your api_key
      // would go to the project's base_url (the same reason as for MCP servers below).
      const ownSearch = { ...config.search }
      config = merge(config, rest)
      for (const svc of ["searxng", "firecrawl"] as const)
        if (rest.search?.[svc]) config = { ...config, search: { ...ownSearch, ...config.search, [svc]: rest.search[svc] } }
      for (const path of projectInstructions ?? []) instructions.push({ path, global: false })
      // A server the project defines replaces the global one whole: merged field by field, the
      // global one's headers (a token) would go to the project's url.
      const servers: Record<string, McpServer> = { ...config.mcp, ...projectMcp }
      for (const [name, o] of Object.entries(overrides)) {
        const base = config.mcp?.[name]
        if (!base) {
          warnings.push(`${projectFile}: mcp.${name} changes a server the global config does not define; ignored`)
          continue
        }
        const r = McpServer.safeParse(narrowed(base, o))
        if (r.success) {
          servers[name] = r.data
          mcpSources[`project:${name}`] = "global"
        } else warnings.push(`${projectFile}: mcp.${name}: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}; ignored`)
      }
      if (Object.keys(servers).length) config = { ...config, mcp: servers }
    }
  }

  // `skin` was renamed `theme`; an old config keeps its look.
  if (config.skin !== undefined) {
    if (config.theme === undefined) config = { ...config, theme: config.skin }
    warnings.push("config: `skin` is now called `theme`; rename it (the value is used meanwhile)")
  }

  const connections: Loaded["connections"] = {}
  const broken: Record<string, string> = {}
  // The login: a `webui` entry, as `lembas login` writes it. An entry of any other kind is a custom
  // connection from 1.x, gone in 2.0 (the CLI is LLeMbas-server-specific): said, and read past, so
  // an old file still starts. In local mode, the user's own file first (read, never written), then
  // the local one, whose entries win by name. Each entry is substituted on its own.
  const raw: Record<string, unknown> = {}
  for (const connFile of connectionFiles()) {
    files.push(connFile)
    const mode = statSync(connFile).mode & 0o777
    if (mode & 0o077) warnings.push(`${connFile} is mode ${mode.toString(8)}; chmod 600 it — it references credentials`)
    const doc = readYaml(connFile)
    const entries = doc && typeof doc === "object" ? (doc as { connections?: unknown }).connections : undefined
    if (entries === undefined || entries === null) continue
    if (typeof entries !== "object" || Array.isArray(entries)) throw new ConfigError(`${connFile} is invalid:\n  connections: expected the login as written by lembas login`)
    for (const [name, c] of Object.entries(entries as Record<string, unknown>)) {
      if ((c as { type?: string } | null)?.type === "webui") raw[name] = c
      else warnings.push(`${connFile}: ${name} is a custom connection, and LLeMbas CLI 2.0 has none — it talks only to the LLeMbas server it is logged in to (lembas login <address>). Ignored; delete it.`)
    }
  }
  // One server: the login made last, where several are left from 1.x.
  const logins = instances()
  const names = Object.keys(raw)
  const chosen = names.length > 1 ? [...names].sort((a, b) => (logins[b]?.logged_in_at ?? "").localeCompare(logins[a]?.logged_in_at ?? ""))[0]! : names[0]
  if (names.length > 1) warnings.push(`connections.yaml holds ${names.length} LLeMbas logins (${names.join(", ")}); LLeMbas CLI 2.0 uses one server — ${chosen}, the latest. lembas logout the others.`)
  if (chosen) {
    const name = chosen
    try {
      const w = WebuiConnection.safeParse(substituteDeep(raw[name], `connections.${name}`))
      if (w.success) {
        const c = (connections[name] = expandWebui(name, w.data))
        if (refreshFailures[name])
          warnings.push(
            `${name}: the instance could not be asked for its models (${refreshFailures[name]}); ${c.webui.fetched_at ? `using what it said at ${c.webui.fetched_at.slice(0, 16).replace("T", " ")}` : "none known yet"}`,
          )
      } else broken[name] = `once {env:}/{file:} are filled in: ${w.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
    } catch (e) {
      broken[name] = (e as Error).message
    }
  }

  /** The server a voice half or the search goes through: the login (`connection:` may still name
   *  it). A string says why there is none. */
  const webuiFor = (named?: string): { name: string; c: Loaded["connections"][string] } | string => {
    if (named) return connections[named]?.webui ? { name: named, c: connections[named]! } : broken[named] ? `${named} is unusable: ${broken[named]}` : `there is no webui connection named ${named}`
    const all = Object.entries(connections).filter(([, c]) => c.webui)
    if (all.length === 1) return { name: all[0]![0], c: all[0]![1] }
    return all.length ? `there are several webui connections (${all.map(([n]) => n).join(", ")}); name one with connection:` : "there is no webui connection (lembas login)"
  }

  const mcp: Loaded["mcp"] = {}
  for (const [name, server] of Object.entries(config.mcp ?? {})) {
    try {
      mcp[name] = { ...substituteDeep(server, `mcp.${name}`), source: mcpSources[`project:${name}`] ?? mcpSources[name] ?? "global" }
    } catch (e) {
      broken[`mcp:${name}`] = (e as Error).message
      warnings.push(`MCP server ${name} is off: ${(e as Error).message}`)
    }
  }

  // Voice: each half on its own; a half whose substitution fails is off, with a warning.
  if (config.voice) {
    const v = { ...config.voice }
    for (const half of ["stt", "tts"] as const) {
      if (!v[half]) continue
      try {
        v[half] = substituteDeep(v[half], `voice.${half}`) as never
      } catch (e) {
        delete v[half]
        broken[`voice:${half}`] = (e as Error).message
        warnings.push(`voice ${half === "stt" ? "input" : "output"} is off: ${(e as Error).message}`)
      }
    }
    // provider: webui — the instance's speech servers, reached at <url>/v1 with this machine's key.
    // An instance that is not configured here falls back (or the half is off), with a warning.
    for (const half of ["stt", "tts"] as const) {
      const h = v[half]
      if (h?.provider !== "webui") continue
      const found = webuiFor(h.connection)
      if (typeof found !== "string") {
        try {
          v[half] = { ...h, base_url: `${found.c.webui!.url}/v1`, api_key: resolveKey(found.name, found.c), tls: found.c.tls, connection: found.name } as never
          continue
        } catch (e) {
          broken[`voice:${half}`] = (e as Error).message
        }
      }
      const why = typeof found === "string" ? found : broken[`voice:${half}`]!
      if (h.fallback) {
        v[half] = h.fallback as never
        warnings.push(`voice ${half === "stt" ? "input" : "output"}: webui — ${why}; using its fallback`)
      } else {
        delete v[half]
        warnings.push(`voice ${half === "stt" ? "input" : "output"} is off: webui — ${why}`)
      }
    }
    config = { ...config, voice: v }
  }

  // Search: each service on its own, like voice — a key that cannot be read turns off that
  // service (the next in search.order is used), with a warning, and LLeMbas CLI still starts.
  if (config.search) {
    const sr = { ...config.search }
    for (const svc of ["searxng", "firecrawl"] as const) {
      if (!sr[svc]) continue
      try {
        const filled = substituteDeep(sr[svc], `search.${svc}`) as { base_url?: string }
        if (filled.base_url !== undefined && !URL.canParse(filled.base_url)) throw new Error(`base_url is not a URL once {env:}/{file:} are filled in`)
        sr[svc] = filled as never
      } catch (e) {
        delete sr[svc]
        broken[`search:${svc}`] = (e as Error).message
        warnings.push(`search: ${svc} is off: ${(e as Error).message}`)
      }
    }
    // webui: the instance's own search (and fetch), with this machine's key.
    if (sr.order?.includes("webui") || sr.webui || sr.fetch === "webui") {
      const found = webuiFor(sr.webui?.connection)
      let why = typeof found === "string" ? found : ""
      if (typeof found !== "string") {
        try {
          sr.webui = { connection: found.name, base_url: found.c.webui!.url, api_key: resolveKey(found.name, found.c), tls: found.c.tls } as never
        } catch (e) {
          why = (e as Error).message
        }
      }
      if (why) {
        delete sr.webui
        if (sr.fetch === "webui") sr.fetch = "local"
        warnings.push(`search: webui is off — ${why}`)
      }
    }
    config = { ...config, search: sr }
  }

  // Local mode: an instance serves models, chat, speech and the balance, and nothing that is kept
  // or shown there — no search or fetch through it, no embeddings, no library, no personalization
  // (the local keys apply) — and the whole hardline stays.
  if (isLocal()) config = localOnly(config, connections, warnings)

  // Logged in to one instance: the account's personalization in place of the local keys,
  // where the instance offers it; and its library when nobody chose one.
  const personal = isLocal() ? { config } : withInstancePersonalization(config)
  config = personal.config
  if (config.library === undefined && !isLocal() && defaultLibrary()) config = { ...config, library: "lembas" }

  const refs = modelRefs(connections)
  // A config.yaml naming the model the way it was named before providers (`example/deepseek-flash`)
  // is rewritten to the new name, once (migrateRefs). Only that form: a pinned `<login>/<provider>/
  // <model>` means what it says, and `embedding` stays as written — its name keys the stored vectors.
  for (const key of ["model", "small_model"] as const) {
    const v = config[key]
    if (typeof v !== "string") continue
    const r = findRef(connections, refs, v)
    if (!r?.old) continue
    config = { ...config, [key]: r.ref }
    migrateRef(globalFile, key, v, r.ref)
  }

  return { config, connections, broken, permissions, permissionSources, warnings, files, mcp, instructions, refs, ...(personal.connection ? { personalFrom: personal.connection } : {}) }
}

/** `key: old` in the global config.yaml becomes `key: now` — once per key and old value, recorded
 *  in the state directory; the scalar edited in place (its anchor and comment kept), re-read just
 *  before writing and written atomically, so a login writing the same file meanwhile is not lost. */
function migrateRef(file: string, key: string, old: string, now: string) {
  const record = join(paths.state, "migrations.json")
  let done: Record<string, string> = {}
  try {
    done = JSON.parse(readFileSync(record, "utf8")) as Record<string, string>
  } catch {}
  const id = `provider-refs:${key}:${old}`
  if (done[id]) return
  try {
    if (existsSync(file)) {
      const doc = parseDocument(readFileSync(file, "utf8"))
      const node = doc.get(key, true)
      if (isScalar(node) && node.value === old) {
        node.value = now
        const tmp = `${file}.${process.pid}.tmp`
        writeFileSync(tmp, doc.toString())
        renameSync(tmp, file)
      }
    }
    done[id] = now
    mkdirSync(paths.state, { recursive: true })
    writeFileSync(record, JSON.stringify(done, null, 2) + "\n")
  } catch {}
}

/** What local mode takes out of a loaded config, saying so where something was asked for. */
function localOnly(config: Config, connections: Loaded["connections"], warnings: string[]): Config {
  const out = { ...config }
  if (out.search) {
    const sr = { ...out.search }
    if (sr.order?.includes("webui") || sr.webui || sr.fetch === "webui") warnings.push("local mode: web search and fetch do not go through the LLeMbas instance")
    if (sr.order) sr.order = sr.order.filter((p) => p !== "webui")
    delete sr.webui
    if (sr.fetch === "webui") sr.fetch = "local"
    out.search = sr
  }
  if (out.library === "lembas") warnings.push("local mode: library: lembas is ignored; this project's own library is used")
  out.library = "local"
  const emb = out.embedding?.split("/")[0]
  if (out.embedding && emb && connections[emb]?.webui) {
    warnings.push(`local mode: embedding ${out.embedding} would go through the LLeMbas instance; the library is searched by words only`)
    delete out.embedding
  }
  if (out.hardline_disable?.length) {
    warnings.push("local mode: hardline_disable is ignored; the whole hardline applies")
    delete out.hardline_disable
  }
  return out
}

/** The server's token: the login's `api_key`, already substituted from its key file. */
export function resolveKey(_name: string, c: Pick<Connection, "api_key">): string | undefined {
  return c.api_key || undefined
}
