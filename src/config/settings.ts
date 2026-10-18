// What can be set while LLeMbas CLI runs, and how: one list shared by /settings, `lembas
// config get|set|list` and the agent's settings tool. A setting has a scope —
//   session  this session only, nothing written;
//   global   ~/.config/lembas/config.yaml (its comments kept);
//   project  the project's .agent/config.yaml (a trusted project only).
// Anything not listed here is not settable this way: permission rules, the hardline, MCP servers,
// connections and where updates come from are edited in the files by hand, never by the agent.
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parse, parseDocument } from "yaml"
import { z } from "zod"
import { paths } from "./paths.ts"
import { asMode, Config, EFFORTS, MODES, PERSONALITIES, UPDATE_CHANNELS } from "./schema.ts"

export class SettingError extends Error {}

export type Scope = "session" | "global" | "project"
export type Source = "default" | "global" | "project" | "session"

export interface SettingDef {
  key: string
  /** model: a configured `connection/model`; effort: one the model takes, or off; list: comma-separated. */
  kind: "enum" | "model" | "effort" | "number" | "boolean" | "list" | "string"
  values?: readonly string[]
  /** The agent may change it (through the settings tool, with approval). */
  agent: boolean
  scopes: Scope[]
  /** Takes effect from the next start (/reload), not at once. */
  reload?: boolean
  /** What it is when nothing sets it. */
  fallback?: string
}

const ALL: Scope[] = ["session", "global", "project"]
const USER: Scope[] = ["session", "global"]

export const SETTINGS: SettingDef[] = [
  { key: "model", kind: "model", agent: true, scopes: ALL },
  { key: "effort", kind: "effort", agent: true, scopes: ALL, fallback: "the model's default" },
  { key: "mode", kind: "enum", values: MODES, agent: true, scopes: ALL, fallback: "manual" },
  { key: "small_model", kind: "model", agent: true, scopes: ALL, fallback: "the session's model" },
  { key: "knowledge", kind: "list", agent: true, scopes: ALL, fallback: "every base" },
  { key: "embedding", kind: "string", agent: false, scopes: ["global"], reload: true, fallback: "none (words only)" },
  { key: "titles", kind: "enum", values: ["model", "prompt"], agent: true, scopes: ALL, fallback: "model" },
  // The person's own words, put last in the system prompt as theirs: never the agent's to write, and
  // the text never a project's (load.ts GLOBAL_ONLY) — a preset's name may be.
  { key: "personality", kind: "enum", values: ["none", ...PERSONALITIES], agent: false, scopes: ALL, fallback: "none" },
  { key: "personality_custom", kind: "string", agent: false, scopes: USER, fallback: "none" },
  { key: "instructions", kind: "string", agent: false, scopes: USER, fallback: "none" },
  { key: "theme", kind: "string", agent: true, scopes: USER, fallback: "moria" },
  { key: "theme_background", kind: "enum", values: ["theme", "terminal"], agent: true, scopes: USER, fallback: "theme" },
  { key: "busy_input", kind: "enum", values: ["steer", "queue"], agent: true, scopes: USER, fallback: "steer" },
  { key: "icons", kind: "enum", values: ["emoji", "plain"], agent: true, scopes: USER, fallback: "emoji" },
  { key: "mouse", kind: "boolean", agent: true, scopes: ["global"], reload: true, fallback: "true" },
  { key: "compaction.auto_at", kind: "number", agent: true, scopes: ALL, fallback: "0.85" },
  { key: "compaction.prune", kind: "boolean", agent: true, scopes: ALL, fallback: "true" },
  { key: "search.order", kind: "list", values: ["searxng", "firecrawl", "ddg"], agent: true, scopes: ALL, fallback: "those configured, then ddg" },
  { key: "search.max_results", kind: "number", agent: true, scopes: ALL, fallback: "8" },
  { key: "memory.enabled", kind: "boolean", agent: true, scopes: ALL, reload: true, fallback: "true" },
  { key: "limits.steps", kind: "number", agent: true, scopes: ALL, fallback: "200" },
  { key: "limits.bash_timeout", kind: "number", agent: true, scopes: ALL, fallback: "120" },
  { key: "limits.wall_seconds", kind: "number", agent: true, scopes: ALL, fallback: "none" },
  { key: "limits.output_bytes", kind: "number", agent: true, scopes: ALL, fallback: "none" },
  { key: "limits.completion_tokens", kind: "number", agent: true, scopes: ALL, fallback: "none" },
  { key: "question.unattended", kind: "enum", values: ["recommended", "first", "fail"], agent: true, scopes: ALL, fallback: "recommended" },
  // Never the agent's: what binary runs, and its own gate.
  { key: "update.channel", kind: "enum", values: UPDATE_CHANNELS, agent: false, scopes: ["global"], fallback: "stable" },
  { key: "update.auto", kind: "enum", values: ["install", "notify", "off"], agent: false, scopes: ["global"], fallback: "install" },
  { key: "settings_tool", kind: "enum", values: ["ask", "allow", "off"], agent: false, scopes: ["global"], reload: true, fallback: "ask" },
]

export const findSetting = (key: string) => SETTINGS.find((s) => s.key === key)

/** The schema for one key of config.yaml, walked down through objects and optionals. */
function schemaAt(path: string[]): z.ZodType | undefined {
  let s: z.ZodType | undefined = Config
  for (const part of path) {
    while (s instanceof z.ZodOptional || s instanceof z.ZodDefault) s = s.unwrap() as z.ZodType
    if (!(s instanceof z.ZodObject)) return undefined
    s = (s.shape as Record<string, z.ZodType>)[part]
  }
  return s
}

export function describe(def: SettingDef): string {
  return schemaAt(def.key.split("."))?.description ?? ""
}

/** A value as typed (a string from the CLI or the dialog) or sent (JSON from the model), checked
 *  against the config schema. Throws with a message meant for whoever set it. */
export function parseValue(def: SettingDef, raw: unknown): unknown {
  // A placeholder would be filled in when the file is next read — the environment or a file put
  // into a setting the agent can read back. Only the user writes those, by hand.
  if (JSON.stringify(raw ?? "").match(/\{(env|file):/)) throw new SettingError(`${def.key}: {env:} and {file:} are written into config.yaml by hand, not set here`)
  let v = raw
  if (typeof raw === "string") {
    const t = raw.trim()
    if (def.kind === "number") v = Number(t)
    else if (def.kind === "boolean") v = t === "true" || t === "on" || t === "yes" ? true : t === "false" || t === "off" || t === "no" ? false : t
    else if (def.kind === "list") v = t.split(/[\s,]+/).filter(Boolean)
    else v = t
  }
  if (def.key === "mode") v = asMode(v) ?? v
  // "none" is how a dialog or a person says it; the file keeps the web UI's empty string.
  if (def.key === "personality" && typeof v === "string" && ["none", "off", "default"].includes(v.toLowerCase())) v = ""
  if (def.kind === "effort" && v !== "off" && !(EFFORTS as readonly string[]).includes(String(v))) throw new SettingError(`effort: one of ${EFFORTS.join(", ")} or off`)
  const schema = schemaAt(def.key.split("."))
  const r = schema?.safeParse(v)
  if (!r || !r.success) throw new SettingError(`${def.key}: ${def.values ? `one of ${def.values.join(", ")}` : (r?.error.issues.map((i) => i.message).join("; ") ?? "not settable")}`)
  return r.data
}

export function show(v: unknown): string {
  if (v === undefined) return ""
  if (Array.isArray(v)) return v.join(", ")
  return String(v)
}

function getIn(o: unknown, path: string[]): unknown {
  let cur = o
  for (const p of path) {
    if (!cur || typeof cur !== "object") return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

/** A config file as written (no substitution, no validation): where a value is set. */
export function readRaw(file: string): Record<string, unknown> {
  try {
    const v = existsSync(file) ? parse(readFileSync(file, "utf8")) : undefined
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export const globalConfigFile = () => join(paths.config, "config.yaml")

/** Set one key in a YAML file, keeping the rest of it (comments, order, layout) as it was. Returns
 *  what else the write had to change to keep the file meaning what it did (said to whoever set it). */
export function writeKey(file: string, path: string[], value: unknown, write: (file: string, text: string) => void): string[] {
  const doc = parseDocument(existsSync(file) ? readFileSync(file, "utf8") : "")
  if (!doc.contents) doc.contents = doc.createNode({}) as never
  const notes: string[] = []
  // `instructions` was once the list of instruction files, and is the custom-instructions
  // text now; loading reads an old list as instruction_files, but only in memory. Writing the text
  // over the list would quietly throw the file names away, so the list moves to instruction_files
  // in the same write (after any already there) and the text takes its place.
  if (path.length === 1 && path[0] === "instructions") {
    const moved = legacyInstructionFiles(doc.toJS()?.instructions)
    if (moved) {
      const had = doc.getIn(["instruction_files"])
      const before = doc.toJS()?.instruction_files
      const kept = Array.isArray(before) ? before.map(String) : typeof before === "string" && before.trim() ? [before] : []
      doc.setIn(["instruction_files"], [...kept, ...moved.filter((f) => !kept.includes(f))])
      notes.push(`the list of files that was under instructions (${moved.join(", ")}) is instruction_files now${had !== undefined ? ", after the ones already there" : ""}`)
    }
  }
  doc.setIn(path, value)
  write(file, doc.toString())
  return notes
}

/** A list under `instructions`: the instruction files of an older config. */
export function legacyInstructionFiles(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.map(String) : undefined
}

export interface Entry {
  def: SettingDef
  value: unknown
  source: Source
  /** Something to know about the value: where an old config's list of files went. */
  note?: string
}

/** Where a setting's value comes from, given the files as written and the session's changes. */
export function sourceOf(key: string, session: Map<string, unknown>, project: Record<string, unknown> | undefined, global: Record<string, unknown>): { value: unknown; source: Source } {
  const path = key.split(".")
  if (session.has(key)) return { value: session.get(key), source: "session" }
  const p = project ? getIn(project, path) : undefined
  if (p !== undefined) return { value: p, source: "project" }
  const g = getIn(global, path)
  if (g !== undefined) return { value: g, source: "global" }
  return { value: undefined, source: "default" }
}
