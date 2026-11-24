// An editor as the client (harness/acp.md, spec 3.11.0, capability `editor`): autocomplete, the
// rewrite of a selection, the editor block of a prompt, edits as ACP diff items, and the person's
// two model settings. The rules are functions here (conformance/editor.json runs them); the
// requests go to the server this machine is logged in to and to nothing else.
//
// Neither autocomplete nor a rewrite runs a tool or reads the disk: they see what the client sent.
// What a model answers is text for the client to insert or to show as a diff — never run here.
import { isAbsolute, relative, resolve } from "node:path"
import { LOOP } from "../harness.ts"
import { apiCall, LembasError, type ServedModel } from "../lembas/client.ts"
import { soleInstance } from "../lembas/personal.ts"
import type { Instance } from "../lembas/login.ts"
import type { Client, ResolvedModel } from "../provider/types.ts"
import type { Level } from "../provider/effort.ts"
import { promptText } from "../prompt/assemble.ts"
import type { FileChange } from "../tool/tool.ts"
import { INTERNAL_ERROR, INVALID_PARAMS, RpcError } from "./rpc.ts"

const E = LOOP.editor

// ── autocomplete ────────────────────────────────────────────────────────────────────────────

const bytes = (s: string) => Buffer.byteLength(s, "utf8")

/** The end of `text` that fits in `max` UTF-8 bytes, cut at a character boundary. */
function tailBytes(text: string, max: number): string {
  if (bytes(text) <= max) return text
  const b = Buffer.from(text, "utf8")
  let at = b.length - max
  // Not into the middle of a character: its continuation bytes are 10xxxxxx.
  while (at < b.length && (b[at]! & 0xc0) === 0x80) at++
  return b.subarray(at).toString("utf8")
}

/** The start of `text` that fits in `max` UTF-8 bytes, cut at a character boundary. */
function headBytes(text: string, max: number): string {
  if (bytes(text) <= max) return text
  const b = Buffer.from(text, "utf8")
  let at = max
  while (at > 0 && (b[at]! & 0xc0) === 0x80) at--
  return b.subarray(0, at).toString("utf8")
}

/** `_lembas/complete`'s window (`kind: trim`): the prefix keeps its end, the suffix its start. */
export function trimWindow(prefix: string, suffix: string, max = E.complete.max_bytes): { prefix: string; suffix: string } {
  return { prefix: tailBytes(prefix, max), suffix: headBytes(suffix, max) }
}

/** A login to send requests with: the one server this machine is logged in to. */
export interface Login {
  instance: Instance
  token: string
}

const tlsOf = (l: Login) => (l.instance.ca ? { ca: l.instance.ca } : undefined)

/** The server's own sentence in an error answer (`detail`), when it gave one. */
const detailOf = (json: any): string | undefined => {
  // The /v1 routes answer in OpenAI's shape ({ error: { message } }); others say `detail`.
  const said = typeof json?.error?.message === "string" ? json.error.message : typeof json?.detail === "string" ? json.detail : ""
  return said.trim() || undefined
}

export const NOT_LOGGED_IN = "this computer is not logged in to a LLeMbas server (lembas login <address>)"
const OLDER = (what: string) => `the LLeMbas server this computer is logged in to has no ${what} yet (it needs a newer LLeMbas server)`

/** The login, or the refusal every editor method gives without one. */
export function loginOrRefuse(login: Login | undefined): Login {
  if (!login) throw new RpcError(INVALID_PARAMS, NOT_LOGGED_IN, { reason: "not_logged_in" })
  return login
}

export function currentLogin(): Login | undefined {
  return soleInstance()
}

export interface CompleteParams {
  prefix: string
  suffix: string
  path?: string
  language?: string
  model?: string
  max_tokens?: number
}

/** What `_lembas/complete` sends on from its params: the window trimmed, the tokens capped. */
export function completeBody(p: any): CompleteParams {
  if (typeof p?.prefix !== "string") throw new RpcError(INVALID_PARAMS, "prefix must be the text before the cursor", { reason: "invalid" })
  const w = trimWindow(p.prefix, typeof p.suffix === "string" ? p.suffix : "")
  const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined)
  const tokens = Number.isFinite(p.max_tokens) && p.max_tokens >= 1 ? Math.min(Math.floor(p.max_tokens), E.complete.max_tokens_cap) : undefined
  const path = str(p.path, 1000)
  const language = str(p.language, 100)
  const model = str(p.model, 300)
  return { ...w, ...(path ? { path } : {}), ...(language ? { language } : {}), ...(model ? { model } : {}), ...(tokens ? { max_tokens: tokens } : {}) }
}

/** One autocomplete request to the server (`POST /v1/lembas/complete`, acp.md *The HTTP API*).
 *  `signal` closes it — the server stops the model's request when the client goes. */
export async function completeOnServer(login: Login, body: CompleteParams, signal: AbortSignal): Promise<{ text: string; model: string | null; finish: "stop" | "length" }> {
  let r: { status: number; json: any }
  try {
    r = await apiCall(login.instance.base_url, login.token, tlsOf(login), "POST", "/v1/lembas/complete", { ...body, stream: false }, 60_000, signal)
  } catch (e) {
    if (signal.aborted) throw e
    throw new RpcError(INTERNAL_ERROR, (e as Error).message)
  }
  const said = detailOf(r.json)
  if (r.status === 401) throw new RpcError(INVALID_PARAMS, said ?? "the server no longer accepts this sign-in — lembas login again", { reason: "not_logged_in" })
  if (r.status === 409) throw new RpcError(INVALID_PARAMS, said ?? "no autocomplete model is chosen yet — choose one in your settings on the server", { reason: "no_model" })
  if (r.status === 403) throw new RpcError(INVALID_PARAMS, said ?? "that model is not allowed for autocomplete", { reason: "not_allowed" })
  if (r.status === 413) throw new RpcError(INVALID_PARAMS, said ?? "the text around the cursor is too long for autocomplete", { reason: "too_large" })
  // A 404 with the server's sentence is a model that is not this account's; a bare one, no such route.
  if (r.status === 404 && said) throw new RpcError(INVALID_PARAMS, said, { reason: "unknown_model" })
  if (r.status === 404 || r.status === 405) throw new RpcError(INVALID_PARAMS, OLDER("autocomplete"), { reason: "unsupported" })
  if (r.status === 429) throw new RpcError(INVALID_PARAMS, said ?? "too many completions at once — the next keystroke will try again", { reason: "busy" })
  if (r.status === 400) throw new RpcError(INVALID_PARAMS, said ?? "the server could not read the completion request", { reason: "invalid" })
  if (r.status >= 400 || typeof r.json?.text !== "string") throw new RpcError(INTERNAL_ERROR, said ?? `autocomplete failed on the server (${r.status})`)
  return { text: r.json.text, model: typeof r.json.model === "string" ? r.json.model : null, finish: r.json.finish === "length" ? "length" : "stop" }
}

/** What a request stopped by a newer one, or by its cancel, is answered: a result, not an error. */
export const CANCELLED = { text: "", cancelled: true } as const

// ── the person's two model settings ─────────────────────────────────────────────────────────

export interface EditorSettings {
  autocomplete: { model: string | null; source: "person" | "instance" | null; allowed: string[] | null }
  main: { model: string | null }
}

function settingsOf(json: any): EditorSettings {
  const a = json?.autocomplete ?? {}
  const str = (v: unknown) => (typeof v === "string" && v ? v : null)
  return {
    autocomplete: {
      model: str(a.model),
      source: a.source === "person" || a.source === "instance" ? a.source : null,
      allowed: Array.isArray(a.allowed) ? a.allowed.filter((x: unknown): x is string => typeof x === "string") : null,
    },
    main: { model: str(json?.main?.model) },
  }
}

/** `GET /v1/lembas/editor`, after a `PUT` of `set` when one is given. Undefined: a server before
 *  spec 3.11.0 (only when reading — a write to such a server is refused). */
export async function editorSettings(login: Login, set?: { autocomplete_model?: string | null; main_model?: string | null }): Promise<EditorSettings | undefined> {
  const call = async (method: string, body?: unknown) => {
    try {
      return await apiCall(login.instance.base_url, login.token, tlsOf(login), method, "/v1/lembas/editor", body, 15_000)
    } catch (e) {
      throw new RpcError(INTERNAL_ERROR, (e as Error).message)
    }
  }
  const judge = (r: { status: number; json: any }, writing: boolean): EditorSettings | undefined => {
    const said = detailOf(r.json)
    if (r.status === 401) throw new RpcError(INVALID_PARAMS, said ?? "the server no longer accepts this sign-in — lembas login again", { reason: "not_logged_in" })
    if (r.status === 404 && said) throw new RpcError(INVALID_PARAMS, said, { reason: "unknown_model" })
    if (r.status === 404 || r.status === 405) {
      if (writing) throw new RpcError(INVALID_PARAMS, OLDER("editor settings"), { reason: "unsupported" })
      return undefined
    }
    if (r.status >= 400) throw new RpcError(INVALID_PARAMS, said ?? `the server refused the editor settings (${r.status})`, { reason: r.status === 403 ? "not_allowed" : "invalid" })
    return settingsOf(r.json)
  }
  if (set) {
    const written = judge(await call("PUT", set), true)
    if (written) return written
  }
  return judge(await call("GET"), false)
}

/** The `set` of `_lembas/editor/settings`, or undefined when the request only reads. */
export function settingsToSet(p: any): { autocomplete_model?: string | null; main_model?: string | null } | undefined {
  const s = p?.set
  if (s === undefined || s === null) return undefined
  if (typeof s !== "object") throw new RpcError(INVALID_PARAMS, "set must name autocomplete_model or main_model", { reason: "invalid" })
  const out: { autocomplete_model?: string | null; main_model?: string | null } = {}
  for (const k of ["autocomplete_model", "main_model"] as const) {
    if (s[k] === undefined) continue
    if (s[k] !== null && (typeof s[k] !== "string" || !s[k].trim())) throw new RpcError(INVALID_PARAMS, `${k} must be a model's id, or null for the instance's`, { reason: "invalid" })
    out[k] = s[k] === null ? null : s[k].trim()
  }
  if (!Object.keys(out).length) throw new RpcError(INVALID_PARAMS, "set must name autocomplete_model or main_model", { reason: "invalid" })
  return out
}

/** `_lembas/models`: the login's chat models, each with what it may be picked for. */
export async function modelsForPicker(login: Login) {
  let r: { status: number; json: any }
  try {
    r = await apiCall(login.instance.base_url, login.token, tlsOf(login), "GET", "/v1/models", undefined, 15_000)
  } catch (e) {
    throw new RpcError(INTERNAL_ERROR, (e as Error).message)
  }
  if (r.status === 401) throw new RpcError(INVALID_PARAMS, "the server no longer accepts this sign-in — lembas login again", { reason: "not_logged_in" })
  if (r.status >= 400) throw new RpcError(INTERNAL_ERROR, detailOf(r.json) ?? `listing the models failed (${r.status})`)
  const served: ServedModel[] = Array.isArray(r.json?.data) ? r.json.data : []
  const settings = await editorSettings(login)
  const allowed = settings?.autocomplete.allowed
  const models = served
    .filter((m) => m && typeof m.id === "string" && (m.kind === undefined || m.kind === "chat"))
    .map((m) => ({
      id: m.id,
      name: typeof m.name === "string" && m.name ? m.name : m.id,
      // A server before 3.11.0 has no autocomplete: every model is for the main setting alone.
      for: settings && (!allowed || allowed.includes(m.id)) ? ["main", "autocomplete"] : ["main"],
      ...(m.default === true ? { default: true } : {}),
      ...(m.interactive_only === true ? { interactive_only: true } : {}),
    }))
  return { models, autocomplete: settings?.autocomplete ?? null, main: settings?.main ?? null }
}

// ── the rewrite of a selection ──────────────────────────────────────────────────────────────

/** The model a rewrite runs on (`kind: model`): the one asked for; the session's; the person's
 *  main model while the login serves it; what a new session in the directory would start on. */
export function rewriteModel(o: { asked?: string; session?: string; main?: string | null; served: readonly string[]; start?: string }): { model: string | undefined; from: "asked" | "session" | "main" | "start" } {
  if (o.asked) return { model: o.asked, from: "asked" }
  if (o.session) return { model: o.session, from: "session" }
  if (o.main && o.served.includes(o.main)) return { model: o.main, from: "main" }
  return { model: o.start, from: "start" }
}

export interface RewriteParams {
  text: string
  instruction: string
  path?: string
  language?: string
  before?: string
  after?: string
}

/** A rewrite's params, checked: the selection and the instruction are needed, and bounded. */
export function rewriteParams(p: any): RewriteParams {
  if (typeof p?.text !== "string" || !p.text) throw new RpcError(INVALID_PARAMS, "text must be the selected text", { reason: "invalid" })
  if (typeof p.instruction !== "string" || !p.instruction.trim()) throw new RpcError(INVALID_PARAMS, "instruction must say what to do with the selection", { reason: "invalid" })
  if (bytes(p.text) > E.rewrite.selection_max_bytes)
    throw new RpcError(INVALID_PARAMS, `the selection is ${Math.round(bytes(p.text) / 1024)} KB; at most ${Math.round(E.rewrite.selection_max_bytes / 1024)} KB can be rewritten at once — select less`, { reason: "too_large" })
  if (p.instruction.length > E.rewrite.instruction_max_chars)
    throw new RpcError(INVALID_PARAMS, `the instruction is ${p.instruction.length} characters; at most ${E.rewrite.instruction_max_chars}`, { reason: "too_large" })
  const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? oneLine(v).slice(0, max) : undefined)
  const path = str(p.path, 1000)
  const language = str(p.language, 100)
  return {
    text: p.text,
    instruction: p.instruction.trim(),
    ...(path ? { path } : {}),
    ...(language ? { language } : {}),
    ...(typeof p.before === "string" && p.before ? { before: p.before } : {}),
    ...(typeof p.after === "string" && p.after ? { after: p.after } : {}),
  }
}

/** The lines of `text` nearest the selection: its last (`end`) or first ones, within both limits. */
function contextLines(text: string, end: boolean, maxLines: number, maxBytes: number): string {
  const lines = text.split("\n")
  // A text ending in a line break has an empty piece after it, which is no line.
  const trailing = lines.at(-1) === ""
  if (trailing) lines.pop()
  const kept: string[] = []
  let size = 0
  const order = end ? [...lines].reverse() : lines
  for (const l of order) {
    const cost = bytes(l) + 1
    if (kept.length >= maxLines || size + cost > maxBytes) break
    kept.push(l)
    size += cost
  }
  if (end) kept.reverse()
  if (!kept.length) return ""
  return kept.join("\n") + (trailing || kept.length < lines.length ? "\n" : "")
}

const block = (tag: string, text: string) => `<${tag}>\n${text}${text.endsWith("\n") ? "" : "\n"}</${tag}>`

/** The user message of a rewrite (`kind: message`). */
export function rewriteMessage(p: RewriteParams, limits: { context_max_lines?: number; context_max_bytes?: number } = {}): string {
  const maxLines = limits.context_max_lines ?? E.rewrite.context_max_lines
  const maxBytes = limits.context_max_bytes ?? E.rewrite.context_max_bytes
  const out: string[] = []
  if (p.path) out.push(`File: ${p.path}${p.language ? ` (${p.language})` : ""}`)
  else if (p.language) out.push(`Language: ${p.language}`)
  const before = p.before ? contextLines(p.before, true, maxLines, maxBytes) : ""
  if (before) out.push(block("before", before))
  out.push(block("selection", p.text))
  const after = p.after ? contextLines(p.after, false, maxLines, maxBytes) : ""
  if (after) out.push(block("after", after))
  out.push(block("instruction", p.instruction))
  return out.join("\n")
}

const FENCE = /^[ \t]*```[^\n`]*$/

/** What a rewrite answers, cleaned as it streams (`kind: output`): a fence around the whole
 *  answer taken off, and the end made the selection's — a line break exactly when it had one.
 *  `feed` gives the piece that can be passed on now; `end` the rest. The pieces joined are the
 *  text. */
export class RewriteOutput {
  private raw = ""
  /** How much of `raw` has been judged and is behind us. */
  private at = 0
  private opened: boolean | undefined
  private sent = ""

  constructor(private selection: string) {}

  feed(chunk: string): string {
    this.raw += chunk
    return this.advance(false)
  }

  end(): string {
    return this.advance(true)
  }

  get text(): string {
    return this.sent
  }

  private advance(done: boolean): string {
    // The opening: blank lines, then perhaps a fence — known once that line is whole.
    if (this.opened === undefined) {
      const blank = /^(?:[ \t]*\n)*/.exec(this.raw)![0].length
      const nl = this.raw.indexOf("\n", blank)
      const first = nl < 0 ? this.raw.slice(blank) : this.raw.slice(blank, nl)
      // Still on the first line: nothing is passed on while it may yet turn out to be a fence.
      if (nl < 0 && !done && (/^[ \t]*`{0,3}$/.test(first) || FENCE.test(first))) return ""
      this.opened = FENCE.test(first)
      if (this.opened) this.at = nl < 0 ? this.raw.length : nl + 1
    }
    const lastLine = (t: string) => t.slice(t.lastIndexOf("\n") + 1)
    const dropLastLine = (t: string) => (t.includes("\n") ? t.slice(0, t.lastIndexOf("\n")) : "")
    // Line breaks at the end wait: whether one stays is the selection's to say.
    let ready = this.raw.slice(this.at).replace(/\n+$/, "")
    if (this.opened) {
      // The closing fence is the last line. While more may come, a last line that is one, or could
      // still become one, waits too — passed on, it could not be taken back.
      const closing = done ? /^[ \t]*```[ \t]*$/ : /^[ \t]*`{0,3}[ \t]*$/
      if (closing.test(lastLine(ready))) ready = dropLastLine(ready).replace(/\n+$/, "")
    }
    if (done && ready && this.selection.endsWith("\n")) ready += "\n"
    // Only ever more of the same text: what was passed on stays as it was.
    if (!ready.startsWith(this.sent)) return ""
    const piece = ready.slice(this.sent.length)
    this.sent = ready
    return piece
  }
}

/** One rewrite: the model's stream cleaned, each piece passed to `onDelta`, the whole returned. */
export async function runRewrite(o: { client: Client; params: RewriteParams; effort?: Level | null; signal: AbortSignal; onDelta?: (delta: string) => void }): Promise<string> {
  const out = new RewriteOutput(o.params.text)
  const stream = o.client.stream({
    system: promptText("tasks/rewrite.md"),
    messages: [{ role: "user", parts: [{ type: "text", text: rewriteMessage(o.params) }] }],
    // No tools at all: a rewrite reads nothing and changes nothing.
    tools: [],
    effort: o.effort ?? null,
    signal: o.signal,
  })
  for await (const e of stream) {
    if (e.type !== "text") continue
    const piece = out.feed(e.text)
    if (piece) o.onDelta?.(piece)
  }
  const rest = out.end()
  if (rest) o.onDelta?.(rest)
  if (!out.text) throw new RpcError(INTERNAL_ERROR, "the model answered with no text for this selection — try again, or say more in the instruction")
  return out.text
}

export type { ResolvedModel }

// ── the editor block of a prompt ────────────────────────────────────────────────────────────

/** One line of plain text: control characters and line breaks out. */
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f\\u2028\\u2029]", "g")
function oneLine(s: string): string {
  return s.replace(CONTROL, "")
}

/** A path as the block says it: one line, no angle brackets (a name cannot close the block),
 *  relative to the project when inside it. */
function saidPath(p: unknown, root: string): string | undefined {
  if (typeof p !== "string") return undefined
  const clean = oneLine(p).replace(/[<>]/g, "").trim().slice(0, 1000)
  if (!clean) return undefined
  if (!isAbsolute(clean)) return clean
  const rel = relative(root, resolve(clean))
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : clean
}

/** Text of a file's or a tool's own inside the block: it cannot close the block or the selection
 *  (`</editor>` is written `< /editor>`); nothing else of it is touched. */
const cannotClose = (s: string) => s.replace(/<\/(editor|selection)\s*>/gi, "< /$1>")

const lineOf = (v: unknown): number | undefined => (Number.isInteger(v) && (v as number) >= 1 ? (v as number) : undefined)

const SEVERITIES = new Set(["error", "warning", "info", "hint"])

/** The block a prompt's `_meta.lembas.editor` becomes (`kind: context`), or undefined for none.
 *  Nothing is read for it: a path here is a name. */
export function editorBlock(editor: unknown, root: string, limits: Partial<typeof E.context> = {}): string | undefined {
  if (!editor || typeof editor !== "object" || Array.isArray(editor)) return undefined
  const L = { ...E.context, ...limits }
  const e = editor as Record<string, any>
  const lines: string[] = []
  const path = saidPath(e.path, root)
  const cursor = lineOf(e.cursor?.line)
  if (path) lines.push(`Open file: ${path}${cursor ? ` (cursor at line ${cursor})` : ""}`)
  else if (cursor) lines.push(`Cursor: line ${cursor}`)
  const sel = e.selection && typeof e.selection === "object" ? e.selection : undefined
  const start = lineOf(sel?.start)
  const end = lineOf(sel?.end)
  if (sel && start && end && end >= start) {
    const where = saidPath(sel.path, root) ?? path
    const range = start === end ? `line ${start}` : `lines ${start}-${end}`
    lines.push(`Selection: ${where ? `${where} ` : ""}${range}`)
    if (typeof sel.text === "string" && sel.text) {
      if (sel.text.length > L.selection_max_chars) lines.push(`(the selection is ${sel.text.length} characters long: read the file for it)`)
      else lines.push(`<selection>\n${cannotClose(sel.text.replace(/\n$/, ""))}\n</selection>`)
    }
  }
  const diagnostics = (Array.isArray(e.diagnostics) ? e.diagnostics : []).filter((d: any) => d && typeof d === "object" && typeof d.message === "string" && d.message.trim())
  if (diagnostics.length) {
    lines.push("Diagnostics:")
    for (const d of diagnostics.slice(0, L.diagnostics_max)) {
      const file = saidPath(d.path, root)
      const line = lineOf(d.line)
      const at = file ? `${file}${line ? `:${line}` : ""}` : line ? `line ${line}` : ""
      const severity = SEVERITIES.has(d.severity) ? (d.severity as string) : ""
      const head = [at, severity].filter(Boolean).join(" ")
      let message = cannotClose((d.message as string).replace(/\s+/g, " ").trim())
      if (message.length > L.diagnostic_max_chars) message = message.slice(0, L.diagnostic_max_chars) + "…"
      const source = typeof d.source === "string" && d.source.trim() ? ` (${oneLine(d.source).replace(/[<>]/g, "").trim().slice(0, 40)})` : ""
      lines.push(`- ${head ? `${head}: ` : ""}${message}${source}`)
    }
    if (diagnostics.length > L.diagnostics_max) lines.push(`(${diagnostics.length - L.diagnostics_max} more)`)
  }
  const open = (Array.isArray(e.open) ? e.open : []).map((p: unknown) => saidPath(p, root)).filter((p: string | undefined): p is string => p !== undefined && p !== path)
  if (open.length) lines.push(`Other open files: ${open.slice(0, L.open_max).join(", ")}${open.length > L.open_max ? ` (${open.length - L.open_max} more)` : ""}`)
  return lines.length ? `<editor>\n${lines.join("\n")}\n</editor>` : undefined
}

// ── edits as diffs ──────────────────────────────────────────────────────────────────────────

export type { FileChange }

/** The texts of `files` together, in UTF-8 bytes. */
export function changeBytes(files: readonly FileChange[]): number {
  return files.reduce((n, f) => n + bytes(f.oldText ?? "") + bytes(f.newText ?? ""), 0)
}

/** What the content of an approval card (`ask`) or of a finished edit's update (`done`) is made
 *  of (`kind: diff`): ACP diff items for a client that said it is an editor, while the texts fit. */
export function diffContent(o: { editor: boolean; when: "ask" | "done"; bytes: number; max?: number }): ("text" | "diff")[] {
  const items = o.editor && o.bytes <= (o.max ?? E.diff.max_bytes)
  if (o.when === "ask") return [items ? "diff" : "text"]
  return items ? ["text", "diff"] : ["text"]
}

/** ACP's diff items for `files`. */
export function diffItems(files: readonly FileChange[]) {
  return files.map((f) => ({
    type: "diff" as const,
    path: f.path,
    oldText: f.oldText,
    newText: f.newText ?? "",
    ...(f.newText === null ? { _meta: { lembas: { deleted: true } } } : {}),
  }))
}

export { LembasError }
