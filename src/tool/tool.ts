import { existsSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"
import { z } from "zod"
import type { PermissionRequest } from "../permission/evaluate.ts"
import { expandHome } from "../config/paths.ts"
import type { ToolSpec } from "../provider/types.ts"
import { PURPOSE_DEF, TOOL_SPECS } from "../harness.ts"

export interface ToolContext {
  /** Absolute project root. */
  root: string
  /** Absolute working directory for relative paths and shells. */
  cwd: string
  signal: AbortSignal
  /** Absolute paths read in this session — `edit`/`write` of an existing file requires one. */
  readFiles: Set<string>
  /** mtime (ms) of each file when it was last read or written by a tool, to detect outside edits. */
  fileStamps: Map<string, number>
  bashTimeoutMs: number
  /** Instruction files (AGENTS.md / CLAUDE.md) the model has already been given. */
  instructionsSeen?: Set<string>
  /** Ask the user questions (the ask_user tool). Absent where nobody can answer. */
  question?: (req: import("./question.ts").QuestionRequest, callId?: string) => Promise<import("./question.ts").QuestionReply>
  /** Run a subagent (the task tool). Absent inside a subagent: no recursion. */
  spawn?: (agent: string, prompt: string, signal: AbortSignal, callId?: string, opts?: { worktree?: boolean; description?: string; model?: string }) => Promise<import("./task.ts").SubagentResult>
  /** The id of the call being run (set by the engine per call). */
  callId?: string
  /** The project directory (.agent), when the project has one. */
  projectDir?: string
  /** The plans directory (plan mode writes only there). */
  planDir?: string
  /** Present a plan for approval (plan_submit). Absent where nobody can answer. */
  plan?: (req: { path: string; text: string }, callId?: string) => Promise<import("./plan_exit.ts").PlanReply>
  /** Change the permission mode (plan_submit, on approval). */
  setMode?: (mode: import("../config/schema.ts").Mode) => void
  /** Web search and fetch settings (config `search:`). */
  search?: import("../search/index.ts").SearchConfig
  /** Persistent memory (the memory tool); the default store when absent. */
  memory?: import("../memory/store.ts").MemoryStore
  /** This project's own memory (.agent/local/MEMORY.md), in a trusted project with a .agent. */
  projectMemory?: import("../memory/store.ts").MemoryStore
  /** Skills as they are on disk now, and where a new one may go. */
  skills?: { list(): import("../skill/index.ts").Skill[]; projectDir?: string; changed?(): void }
  /** Past sessions (session_search). */
  sessions?: { store: import("../session/store.ts").Store; current(): string | undefined }
  /** Settings (the settings tool): read and change them; the configured models. */
  settings?: {
    get(key: string): import("../config/settings.ts").Entry
    list(): import("../config/settings.ts").Entry[]
    set(key: string, value: unknown, scope?: import("../config/settings.ts").Scope): import("../settings.ts").SetResult
    models(): string[]
  }
  /** The library: notes, and the knowledge bases this project searches (all, when
   *  `bases` is undefined); `project` is the scope of this project's notes. */
  library?: {
    lib: import("../library/store.ts").Library
    project?: string
    bases?: string[]
    embedder?: import("../library/store.ts").Embedder
  }
  /** The session's todo list (the todo tool). */
  todos?: { items: import("./todo.ts").Todo[]; changed?: (items: import("./todo.ts").Todo[]) => void }
}

export interface ToolResult {
  output: string
  /** One-line summary for the UI: `src/app.ts +12 −3`, `exit 0 · 0.4s`. */
  title?: string
  isError?: boolean
  /** UI-only extras (a unified diff, exit code…). Never sent to the model. */
  meta?: Record<string, unknown>
  /** Images for the model (view_image): sent in a user turn after the tool results. */
  images?: import("../provider/types.ts").ImagePart[]
}

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string
  /** The permission key the tool is checked under; several tools can share one (edit, write). */
  access: string
  /** Runs alone, never alongside other calls of the same step (it waits on the user). */
  exclusive?: boolean
  /** Offered only when this holds: a model with vision, plan mode, or a project directory. */
  requires?: "vision" | "plan" | "project" | "knowledge"
  description: string
  schema: S
  /** The JSON Schema sent to the model, when it does not come from `schema` (MCP tools). */
  jsonSchema?: Record<string, unknown>
  /** Where the model says what a call is for, shown when the user is asked to allow it: the
   *  `purpose` argument added to every tool (the default), a field of the tool's own (bash's
   *  `description`), or false for a tool that never asks. */
  purpose?: string | false
  permission(args: z.infer<S>, ctx: ToolContext): PermissionRequest
  /** What the call would change, as a unified diff, shown when the user is asked. Writes nothing. */
  preview?(args: z.infer<S>, ctx: ToolContext): Promise<string>
  run(args: z.infer<S>, ctx: ToolContext): Promise<ToolResult>
}

export function defineTool<S extends z.ZodType>(t: Tool<S>): Tool<S> {
  return t
}

export const PURPOSE = PURPOSE_DEF.name
// The argument's schema is the harness spec's (harness/purpose.json), as LLeMbas sends it too.
const PURPOSE_SPEC = PURPOSE_DEF.schema

/** The argument that carries a call's purpose for this tool, or undefined when it has none. A
 *  tool (an MCP server's) that already takes an argument named `purpose` keeps it as its own. */
export function purposeKey(t: Tool): string | undefined {
  if (t.purpose === false) return undefined
  if (typeof t.purpose === "string") return t.purpose
  const props = t.jsonSchema?.properties as Record<string, unknown> | undefined
  return props && PURPOSE in props ? undefined : PURPOSE
}

/** Take the injected `purpose` out of a call's arguments: the tool itself never sees it. */
export function splitPurpose(t: Tool, raw: unknown): { args: unknown; purpose?: string } {
  const key = purposeKey(t)
  if (!key || !raw || typeof raw !== "object" || Array.isArray(raw)) return { args: raw }
  const v = (raw as Record<string, unknown>)[key]
  const purpose = typeof v === "string" && v.trim() ? v.trim() : undefined
  if (key !== PURPOSE) return { args: raw, purpose }
  const { [PURPOSE]: _, ...rest } = raw as Record<string, unknown>
  return { args: rest, purpose }
}

export function toSpec(t: Tool): ToolSpec {
  let schema: Record<string, unknown>
  if (t.jsonSchema) schema = t.jsonSchema
  // A built-in tool's parameters are the harness spec's, as LLeMbas sends them too; its zod schema
  // validates the call, and tests/harness.test.ts keeps the two the same shape.
  else if (TOOL_SPECS[t.name]) schema = structuredClone(TOOL_SPECS[t.name]!.parameters)
  else {
    schema = z.toJSONSchema(t.schema, { target: "draft-7", io: "input" }) as Record<string, unknown>
    delete schema.$schema
  }
  if (purposeKey(t) === PURPOSE) schema = { ...schema, properties: { ...((schema.properties as Record<string, unknown>) ?? {}), [PURPOSE]: PURPOSE_SPEC } }
  return { name: t.name, description: t.description, parameters: schema }
}

/** A file's text exactly as it is, byte-order mark included. Bun's `.text()` drops a BOM, so a tool
 *  that read with it and wrote the result back took the mark off every file it changed. */
export async function readText(abs: string): Promise<string> {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(await Bun.file(abs).bytes())
}

/** A tool's path argument, absolute. Models send both absolute and relative paths. */
export function absPath(p: string, ctx: ToolContext): string {
  // A model writes ~/x as a shell would; without this it becomes a directory named "~".
  if (p === "~" || p.startsWith("~/")) return resolve(expandHome(p))
  if (isAbsolute(p)) return resolve(p)
  const rel = resolve(ctx.cwd, p)
  // Small models often drop the leading "/" of an absolute path ("home/me/proj/a.py"). When the
  // relative reading does not exist and the absolute one does, inside the project, take that.
  if (!existsSync(rel)) {
    const abs = resolve("/", p)
    if ((abs === ctx.root || abs.startsWith(ctx.root + "/")) && existsSync(abs)) return abs
  }
  return rel
}

/** For display and rule matching: relative to the root when inside it. */
export function showPath(abs: string, ctx: ToolContext): string {
  const rel = relative(ctx.root, abs)
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : abs
}

export class ToolError extends Error {}

/** Cap tool output sent to the model; the head and tail are what matter. */
export function truncate(text: string, max = 30_000): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.7)
  const tail = max - head
  return `${text.slice(0, head)}\n\n[… ${text.length - max} characters omitted …]\n\n${text.slice(-tail)}`
}
