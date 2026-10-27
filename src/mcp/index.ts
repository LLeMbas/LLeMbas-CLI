// MCP servers (Model Context Protocol), after Hermes Agent (tools/mcp_tool*.py; MIT, © Nous
// Research) and OpenCode (packages/opencode/src/mcp/; MIT, © opencode), on the official SDK.
//
// - A server is a local process (`command`, stdio) or a URL (streamable HTTP, SSE as fallback).
// - Its tools become LLeMbas CLI tools named mcp__<server>__<tool>; each call is checked by the
//   permission rules like any tool (key = that name), and asks by default.
// - Its prompts become /<server>:<prompt> commands; its resources get list/read tools; its
//   instructions go into the system prompt (OpenCode's <mcp_instructions>).
// - Connecting happens in the background; tools appear on the next prompt after a server is up.
import { createHash } from "node:crypto"
import { isAbsolute, join } from "node:path"
import { z } from "zod"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { ToolListChangedNotificationSchema, PromptListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js"
import type { McpServer } from "../config/schema.ts"
import { expandHome } from "../config/paths.ts"
import { scanThreats } from "../memory/threats.ts"
import { tlsFor } from "../provider/http.ts"
import type { ImagePart } from "../provider/types.ts"
import { ToolError, truncate, type Tool, type ToolResult } from "../tool/tool.ts"
import { match } from "../permission/wildcard.ts"
import { codeFrom, forget, OAuthProvider, waitForCallback, CALLBACK_PORT } from "./oauth.ts"

export type ServerConfig = McpServer & { source: "global" | "project" }
export type Status = "disabled" | "connecting" | "connected" | "failed" | "needs_auth"

interface RemoteTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string }
}
interface RemotePrompt {
  name: string
  description?: string
  arguments?: { name: string; description?: string; required?: boolean }[]
}

export interface ServerState {
  name: string
  cfg: ServerConfig
  status: Status
  error?: string
  client?: Client
  transport?: Transport
  tools: RemoteTool[]
  prompts: RemotePrompt[]
  resources: boolean
  instructions?: string
  /** The last lines the process wrote to stderr (stdio), for a failure's explanation. */
  stderr: string[]
  oauth?: OAuthProvider
  /** The connect under way, which every other caller waits on rather than starting one. */
  connecting?: Promise<ServerState>
  /** Bumped by every connect and disable: a connect that finds it changed gives up quietly. */
  gen: number
  loading?: Promise<void>
  reloadAgain?: boolean
}

export interface McpPromptCommand {
  /** `server:prompt`, as typed after the slash. */
  name: string
  description: string
  args: string[]
  server: string
  prompt: string
}

const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_")

/** The LLeMbas server's /mcp, for its memory (`library: lembas`, harness/acp.md *Memory*): its
 *  `memory` tool keeps its name and stands in for this machine's; notes, knowledge and skills stay
 *  this machine's (spec 3.0.0). */
export const LIBRARY_SERVER = "lembas-library"
/** mcp__<server>__<tool>, at most 64 characters (the providers' limit); longer ones keep a hash. */
export function toolName(server: string, tool: string): string {
  const full = `mcp__${sanitize(server)}__${sanitize(tool)}`
  if (full.length <= 64) return full
  return `${full.slice(0, 55)}_${createHash("sha256").update(full).digest("hex").slice(0, 8)}`
}

/** include wins; otherwise exclude; names or globs. */
export function toolAllowed(name: string, filter: McpServer["tools"]): boolean {
  if (filter?.include) return filter.include.some((p) => match(name, p))
  if (filter?.exclude) return !filter.exclude.some((p) => match(name, p))
  return true
}

/** A tool result from MCP content blocks: text as text, images for the model, the rest named. */
export function convertResult(server: string, r: any): ToolResult {
  const texts: string[] = []
  const images: ImagePart[] = []
  for (const b of (r?.content ?? []) as any[]) {
    if (b.type === "text") texts.push(String(b.text ?? ""))
    else if (b.type === "image" && typeof b.data === "string") {
      images.push({ type: "image", mime: b.mimeType ?? "image/png", data: b.data })
      texts.push(`[image: ${b.mimeType ?? "image"}, attached]`)
    } else if (b.type === "audio") texts.push(`[audio (${b.mimeType ?? "?"}) — not passed on]`)
    else if (b.type === "resource") {
      const res = b.resource ?? {}
      if (typeof res.text === "string") texts.push(`[resource ${res.uri ?? ""}]\n${res.text}`)
      else texts.push(`[binary resource ${res.uri ?? ""} (${res.mimeType ?? "?"}, ${typeof res.blob === "string" ? Math.floor((res.blob.length * 3) / 4) : "?"} bytes) — not passed on]`)
    } else if (b.type === "resource_link") texts.push(`[resource link: ${b.uri}${b.name ? ` (${b.name})` : ""}${b.mimeType ? `, ${b.mimeType}` : ""} — read it with ${toolName(server, "read_resource")}]`)
    else texts.push(`[unsupported MCP content: ${b.type}]`)
  }
  let text = texts.join("\n\n").trim()
  if (r?.structuredContent !== undefined && (!text || text === JSON.stringify(r.structuredContent))) text = JSON.stringify(r.structuredContent, null, 2)
  if (!text && r?.toolResult !== undefined) text = typeof r.toolResult === "string" ? r.toolResult : JSON.stringify(r.toolResult)
  if (r?.isError) return { output: truncate(text || "The MCP tool reported an error."), isError: true, title: "error" }
  return { output: truncate(text || "(no output)"), ...(images.length ? { images } : {}) }
}

/** The parameters schema as providers want it: an object, with properties. */
function objectSchema(s: unknown): Record<string, unknown> {
  const o = s && typeof s === "object" && !Array.isArray(s) ? { ...(s as Record<string, unknown>) } : {}
  delete o.$schema
  if (o.type !== "object") o.type = "object"
  if (!o.properties) o.properties = {}
  return o
}

const MAX_INSTRUCTIONS = 4000
const LOOSE = z.looseObject({})

export interface McpOptions {
  /** The project root: where a local server runs unless it says otherwise. */
  root: string
  version: string
  notice?: (message: string) => void
  /** Open a URL in the user's browser; false when that is not possible. */
  open?: (url: string) => boolean
}

/** Local server processes still running, killed when LLeMbas CLI exits however it exits. */
const live = new Set<StdioClientTransport>()
let exitHook = false

export class McpManager {
  readonly servers = new Map<string, ServerState>()
  private listeners: (() => void)[] = []

  /** Called whenever a server's status, tools or prompts change. */
  onChange(f: () => void) {
    this.listeners.push(f)
  }

  private changed() {
    for (const f of this.listeners) f()
  }

  constructor(
    configs: Record<string, ServerConfig>,
    private o: McpOptions,
  ) {
    if (!exitHook) {
      exitHook = true
      process.once("exit", () => {
        for (const t of live)
          try {
            if (t.pid) process.kill(t.pid)
          } catch {}
      })
    }
    for (const [name, cfg] of Object.entries(configs))
      this.servers.set(name, { name, cfg, status: cfg.enabled === false ? "disabled" : "connecting", tools: [], prompts: [], resources: false, stderr: [], gen: 0 })
  }

  /** Connect every enabled server, together; resolves when all have succeeded or failed. */
  start(): Promise<void> {
    return Promise.all([...this.servers.values()].filter((s) => s.status !== "disabled").map((s) => this.connect(s.name))).then(() => undefined)
  }

  private transportFor(s: ServerState, kind: "http" | "sse"): Transport {
    const cfg = s.cfg
    if (cfg.command !== undefined) {
      const [command, ...rest] = Array.isArray(cfg.command) ? cfg.command : [cfg.command]
      // The server gets a safe minimum of the environment (as Hermes does), plus what its config
      // names — not every API key in the shell.
      const env: Record<string, string> = { ...getDefaultEnvironment() }
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined && (/^(XDG_|LC_)/.test(k) || ["LANG", "TZ", "TMPDIR", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"].includes(k))) env[k] = v
      Object.assign(env, cfg.env ?? {})
      const cwd = cfg.cwd ? (isAbsolute(expandHome(cfg.cwd)) ? expandHome(cfg.cwd) : join(this.o.root, cfg.cwd)) : this.o.root
      const t = new StdioClientTransport({ command: command!, args: [...rest, ...(cfg.args ?? [])], env, cwd, stderr: "pipe" })
      live.add(t)
      const close = t.close.bind(t)
      t.close = async () => {
        live.delete(t)
        await close()
      }
      t.stderr?.on("data", (chunk: Buffer) => {
        s.stderr.push(...chunk.toString().split("\n").filter(Boolean))
        if (s.stderr.length > 20) s.stderr.splice(0, s.stderr.length - 20)
      })
      return t
    }
    const url = new URL(cfg.url!)
    const tls = tlsFor(cfg)
    const fetchWith = tls ? (u: string | URL, init?: RequestInit) => fetch(u, { ...init, tls } as RequestInit) : undefined
    if (cfg.oauth !== false) s.oauth ??= new OAuthProvider(s.name, cfg.url!, cfg.oauth ?? {})
    const opts = { requestInit: { headers: cfg.headers ?? {} }, ...(s.oauth ? { authProvider: s.oauth } : {}), ...(fetchWith ? { fetch: fetchWith } : {}) }
    return kind === "sse" ? new SSEClientTransport(url, opts) : new StreamableHTTPClientTransport(url, opts)
  }

  /** (Re)connect one server. Never throws: the outcome is its status. Calls while one is under way
   *  (three tool calls finding it dropped) share it, rather than starting a process each. */
  connect(name: string): Promise<ServerState> {
    const s = this.servers.get(name)
    if (!s) throw new Error(`no MCP server "${name}"`)
    if (s.connecting) return s.connecting
    const gen = ++s.gen
    s.connecting = this.connectNow(s, gen).finally(() => {
      if (s.gen === gen) s.connecting = undefined
    })
    return s.connecting
  }

  private async connectNow(s: ServerState, gen: number): Promise<ServerState> {
    await this.disconnect(s)
    s.status = "connecting"
    s.error = undefined
    this.changed()
    const kinds: ("http" | "sse")[] = s.cfg.command !== undefined ? ["http"] : s.cfg.transport === "sse" ? ["sse"] : ["http", "sse"]
    for (const [i, kind] of kinds.entries()) {
      const client = new Client({ name: "lembas-cli", version: this.o.version }, { capabilities: {} })
      let transport: Transport
      try {
        transport = this.transportFor(s, kind)
      } catch (e) {
        return this.fail(s, (e as Error).message)
      }
      const limit = (s.cfg.connect_timeout ?? 30) * 1000
      try {
        await withTimeout(client.connect(transport), limit, `no answer within ${s.cfg.connect_timeout ?? 30} s`)
        // Disabled or reconnected meanwhile: this connection is nobody's.
        if (s.gen !== gen) {
          await client.close().catch(() => {})
          return s
        }
        s.client = client
        s.transport = transport
        client.onclose = () => {
          if (s.client !== client) return
          s.client = undefined
          s.status = "failed"
          s.error = `the connection closed${s.stderr.length ? ` — ${s.stderr[s.stderr.length - 1]}` : ""}`
          this.changed()
        }
        // Set before the first listing, so a change announced during it is not missed.
        const relist = () => void this.reload(s).then(() => this.changed(), () => {})
        client.setNotificationHandler(ToolListChangedNotificationSchema, async () => relist())
        client.setNotificationHandler(PromptListChangedNotificationSchema, async () => relist())
        // The listing is part of connecting: a server that never finishes it must not hang startup.
        await withTimeout(this.reload(s), limit, `its tools were not listed within ${s.cfg.connect_timeout ?? 30} s`)
        if (s.gen !== gen) return s
        s.status = "connected"
        this.changed()
        return s
      } catch (e) {
        if (s.client === client) {
          s.client = undefined
          s.transport = undefined
        }
        await client.close().catch(() => {})
        await transport.close().catch(() => {})
        if (s.gen !== gen) return s
        if (e instanceof UnauthorizedError || s.oauth?.authorizationUrl) {
          s.status = "needs_auth"
          s.error = `sign-in needed — /mcp auth ${s.name}`
          this.changed()
          return s
        }
        // Streamable HTTP refused: try SSE once, as Hermes and OpenCode do.
        if (i < kinds.length - 1) continue
        const why = (e as Error).message || String(e)
        return this.fail(s, s.stderr.length ? `${why} — ${s.stderr.slice(-3).join(" | ")}` : why)
      }
    }
    return s
  }

  private fail(s: ServerState, why: string): ServerState {
    s.status = "failed"
    s.error = why
    this.changed()
    return s
  }

  /** One listing at a time per server; a change announced during one runs another after it. */
  private reload(s: ServerState): Promise<void> {
    if (s.loading) {
      s.reloadAgain = true
      return s.loading
    }
    s.loading = (async () => {
      do {
        s.reloadAgain = false
        await this.load(s)
      } while (s.reloadAgain)
    })().finally(() => (s.loading = undefined))
    return s.loading
  }

  /** Tools, prompts, resources and instructions, as the server has them now. */
  private async load(s: ServerState) {
    const c = s.client
    if (!c) return
    const caps = c.getServerCapabilities() ?? {}
    // Pages until the server stops giving a cursor — but not forever: a cursor seen before, or a
    // hundred pages, ends it.
    const pages = async <T>(get: (cursor?: string) => Promise<{ items: T[]; next?: string }>) => {
      const out: T[] = []
      const seen = new Set<string>()
      let cursor: string | undefined
      for (let n = 0; n < 100; n++) {
        const r = await get(cursor)
        out.push(...r.items)
        if (!r.next || seen.has(r.next)) break
        seen.add(r.next)
        cursor = r.next
      }
      return out
    }
    const tools = caps.tools ? await pages(async (cursor) => {
      const r = await c.listTools(cursor ? { cursor } : undefined)
      return { items: r.tools as RemoteTool[], next: r.nextCursor }
    }) : []
    const prompts = caps.prompts && s.cfg.prompts !== false ? await pages(async (cursor) => {
      const r = await c.listPrompts(cursor ? { cursor } : undefined)
      return { items: r.prompts as RemotePrompt[], next: r.nextCursor }
    }) : []
    s.tools = tools.filter((t) => toolAllowed(t.name, s.cfg.tools))
    s.prompts = prompts
    s.resources = !!caps.resources && s.cfg.resources !== false
    const ins = s.cfg.instructions === false ? undefined : c.getInstructions()?.trim()
    s.instructions = undefined
    if (ins) {
      // The server wrote this, not the user: anything aimed at the agent is left out.
      const threats = scanThreats(ins, "context")
      if (threats.length) this.o.notice?.(`MCP ${s.name}: its instructions match ${threats.join(", ")} — left out of the prompt`)
      else s.instructions = ins.length > MAX_INSTRUCTIONS ? `${ins.slice(0, MAX_INSTRUCTIONS)}\n[…cut]` : ins
    }
  }

  private async disconnect(s: ServerState) {
    const c = s.client
    s.client = undefined
    s.transport = undefined
    if (c) await c.close().catch(() => {})
  }

  /** A connected client, reconnecting once if the connection dropped (Hermes retries once). */
  private async clientOf(name: string): Promise<Client> {
    let s = this.servers.get(name)!
    if (!s.client && s.status !== "disabled" && s.status !== "needs_auth") s = await this.connect(name)
    if (!s.client) throw new ToolError(`MCP server ${name} is not connected: ${s.error ?? s.status}. /mcp shows the servers.`)
    return s.client
  }

  /** A resource's text, read from a server directly (not offered to the model): the LLeMbas
   *  server's `lembas://memory` for the prompt. `scope` rides as on a tool call. */
  async readResource(server: string, uri: string, scope?: string): Promise<string> {
    const c = await this.clientOf(server)
    const r = await c.readResource({ uri, ...(scope ? { _meta: { lembas: { scope } } } : {}) })
    return r.contents.map((x) => ("text" in x && typeof x.text === "string" ? x.text : "")).join("\n").trim()
  }

  /** Every connected server's tools as LLeMbas CLI tools, and list/read tools for resources. */
  tools(): Tool[] {
    const out: Tool[] = []
    // Different names can come out the same (get.user and get_user; server a.b and a_b): the
    // second gets a hash of what it really is, so every tool stays reachable and names stay unique.
    const used = new Set<string>()
    const unique = (server: string, tool: string) => {
      let n = toolName(server, tool)
      if (used.has(n)) n = `${n.slice(0, 55)}_${createHash("sha256").update(`${server}\u0000${tool}`).digest("hex").slice(0, 8)}`
      used.add(n)
      return n
    }
    for (const s of this.servers.values()) {
      if (s.status !== "connected") continue
      for (const t of s.tools) {
        const library = s.name === LIBRARY_SERVER
        const name = library ? sanitize(t.name) : unique(s.name, t.name)
        if (library) used.add(name)
        const readOnly = t.annotations?.readOnlyHint === true
        out.push({
          name,
          access: name,
          description: library ? (t.description ?? t.name).trim() : `${(t.description ?? `${t.name} from the MCP server ${s.name}`).trim()}\n(MCP server: ${s.name})`,
          schema: LOOSE,
          jsonSchema: objectSchema(t.inputSchema),
          // The library's writes are the account's memory, not this machine: asked like the local
          // memory tool (interact), never run unasked as a command would be denied.
          permission: () => ({ permission: name, class: readOnly ? "read" : library ? "interact" : "execute", patterns: ["*"] }),
          run: async (args, ctx) => {
            const c = await this.clientOf(s.name)
            try {
              // The server's memory answers within the chat's scope (harness/acp.md, Scope).
              const scope = library ? ctx.libraryScope : undefined
              const r = await c.callTool({ name: t.name, arguments: args as Record<string, unknown>, ...(scope ? { _meta: { lembas: { scope } } } : {}) }, undefined, {
                signal: ctx.signal,
                timeout: (s.cfg.timeout ?? 120) * 1000,
                resetTimeoutOnProgress: true,
                onprogress: () => {},
              })
              const res = convertResult(s.name, r)
              const first = res.output.split("\n").find((l) => l.trim()) ?? ""
              return { ...res, title: res.title ?? (first.length > 60 ? `${first.slice(0, 57)}…` : first) }
            } catch (e) {
              throw new ToolError(`${s.name}/${t.name}: ${(e as Error).message}`)
            }
          },
        } as Tool)
      }
      if (s.resources) {
        const list = unique(s.name, "list_resources")
        const read = unique(s.name, "read_resource")
        out.push(
          {
            name: list,
            access: list,
            description: `List the resources the MCP server ${s.name} offers (documents, files, records it can hand over).`,
            schema: LOOSE,
            jsonSchema: { type: "object", properties: {} },
            permission: () => ({ permission: list, class: "read", patterns: ["*"] }),
            run: async () => {
              const c = await this.clientOf(s.name)
              const r = await c.listResources()
              const rows = r.resources.map((x: any) => `${x.uri}${x.name ? ` — ${x.name}` : ""}${x.mimeType ? ` (${x.mimeType})` : ""}${x.description ? `: ${x.description}` : ""}`)
              return { output: rows.join("\n") || "(no resources)", title: `${s.name} · ${rows.length} resources` }
            },
          } as Tool,
          {
            name: read,
            access: read,
            description: `Read one resource from the MCP server ${s.name}, by its URI (from ${list}, or a resource link in a tool result).`,
            schema: z.object({ uri: z.string() }),
            jsonSchema: { type: "object", properties: { uri: { type: "string", description: "The resource's URI" } }, required: ["uri"] },
            permission: (a: any) => ({ permission: read, class: "read", patterns: [String(a.uri)] }),
            run: async (a: any) => {
              const c = await this.clientOf(s.name)
              const r = await c.readResource({ uri: a.uri })
              return { ...convertResult(s.name, { content: r.contents.map((x: any) => ({ type: "resource", resource: x })) }), title: `${s.name} · ${a.uri}` }
            },
          } as Tool,
        )
      }
    }
    return out
  }

  /** Prompts as /server:prompt commands. */
  prompts(): McpPromptCommand[] {
    return [...this.servers.values()]
      .filter((s) => s.status === "connected")
      .flatMap((s) => s.prompts.map((p) => ({ name: `${sanitize(s.name)}:${sanitize(p.name)}`, description: p.description ?? `prompt from ${s.name}`, args: (p.arguments ?? []).map((a) => a.name), server: s.name, prompt: p.name })))
  }

  /** A prompt's text with the typed words as its arguments, in order (the last takes the rest). */
  async promptText(cmd: McpPromptCommand, typed: string): Promise<string> {
    const words = typed.trim() ? typed.trim().split(/\s+/) : []
    const args: Record<string, string> = {}
    cmd.args.forEach((a, i) => {
      const v = i === cmd.args.length - 1 ? words.slice(i).join(" ") : words[i]
      if (v) args[a] = v
    })
    const c = await this.clientOf(cmd.server)
    const r = await c.getPrompt({ name: cmd.prompt, arguments: args })
    return r.messages
      .map((m: any) => (m.content?.type === "text" ? m.content.text : m.content?.type === "resource" && typeof m.content.resource?.text === "string" ? m.content.resource.text : ""))
      .filter(Boolean)
      .join("\n\n")
  }

  /** The system prompt's block of server instructions, or "". */
  instructions(): string {
    const parts = [...this.servers.values()].filter((s) => s.status === "connected" && s.instructions).map((s) => `<server name="${s.name}">\n${s.instructions}\n</server>`)
    return parts.length ? `Instructions from the MCP servers you have tools from (their tools are named mcp__<server>__…):\n<mcp_instructions>\n${parts.join("\n")}\n</mcp_instructions>` : ""
  }

  /** Sign in to a remote server: show the page, catch the redirect (or take a pasted one). */
  async auth(name: string, show: (url: string) => void, pasted?: Promise<string>): Promise<ServerState> {
    const s = this.servers.get(name)
    if (!s) throw new Error(`no MCP server "${name}"`)
    if (s.cfg.url === undefined) throw new Error(`${name} is a local server; it has no sign-in`)
    if (s.cfg.oauth === false) throw new Error(`${name} has oauth: false`)
    // A connect already under way uses the old provider; let it finish first.
    await s.connecting?.catch(() => {})
    const oauth = new OAuthProvider(s.name, s.cfg.url, s.cfg.oauth ?? {})
    s.oauth = oauth
    const port = (s.cfg.oauth || undefined)?.callback_port ?? CALLBACK_PORT
    const cb = waitForCallback(port, () => oauth.expectedState())
    try {
      if (cb.error && !pasted) throw cb.error
      if (cb.error) this.o.notice?.(cb.error.message)
      await this.connect(name)
      if (s.status === "connected") return s
      const url = oauth.authorizationUrl
      if (!url) throw new Error(s.error ?? "the server did not ask for a sign-in")
      show(url.toString())
      this.o.open?.(url.toString())
      const got = await Promise.race([
        // The listener has checked the state itself.
        ...(cb.error ? [] : [cb.code.then((code) => ({ code, state: undefined as string | undefined, fromUrl: false }))]),
        ...(pasted ? [pasted.then(codeFrom)] : []),
      ])
      const want = oauth.expectedState()
      // A pasted address must carry this sign-in's state; a bare code (some servers show one) is taken.
      if (want && (got.state !== undefined || got.fromUrl) && got.state !== want) throw new Error("OAuth state mismatch — that address is from another sign-in")
      const t = this.transportFor(s, s.cfg.transport === "sse" ? "sse" : "http") as StreamableHTTPClientTransport | SSEClientTransport
      await t.finishAuth(got.code)
      await t.close().catch(() => {})
      oauth.authorizationUrl = undefined
      return await this.connect(name)
    } finally {
      cb.stop()
    }
  }

  /** Forget a server's stored sign-in. */
  logout(name: string) {
    forget(name)
    const s = this.servers.get(name)
    if (s) s.oauth = undefined
  }

  async setEnabled(name: string, on: boolean) {
    const s = this.servers.get(name)
    if (!s) throw new Error(`no MCP server "${name}"`)
    if (!on) {
      // A connect under way sees the changed generation and gives up.
      s.gen++
      s.connecting = undefined
      await this.disconnect(s)
      s.status = "disabled"
      this.changed()
      return s
    }
    return this.connect(name)
  }

  async close() {
    await Promise.all([...this.servers.values()].map((s) => this.disconnect(s)))
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>
  return Promise.race([p, new Promise<T>((_, reject) => (t = setTimeout(() => reject(new Error(message)), ms)))]).finally(() => clearTimeout(t))
}
