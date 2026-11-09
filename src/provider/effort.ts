// Reasoning effort. Logic ported from LLeMbas services/chat.py and generation.py
// (© Jaroslav Beneš, MIT), where the reasons are written up at length:
// - llama.cpp silently drops a top-level `reasoning_effort`; what reaches a gpt-oss behind it is
//   `chat_template_kwargs.reasoning_effort`, so by default both are sent — and only when chosen.
// - A template that does not know a value raises and fails the whole request (Bonsai refuses
//   `high`), so a refusal is detected, the model's vocabulary narrowed, and the request retried once.
import { EFFORTS, type Effort } from "../config/schema.ts"
import type { ResolvedModel } from "./types.ts"
import { learned } from "./learned.ts"

export const DEFAULT_EFFORTS: Effort[] = ["low", "medium", "high"]

/** The efforts this model accepts, in offering order: learned > the server's > the common three.
 *  `[]` from the server: it takes none (its one level is `default`). */
export function effortsFor(m: ResolvedModel): Effort[] {
  const list = learned().efforts[m.ref] ?? m.spec.efforts ?? DEFAULT_EFFORTS
  return EFFORTS.filter((e) => list.includes(e))
}

/** An effort level (harness models/schema.json `levels`, spec 3.2.0): an effort; `off` — thinking
 *  switched off, only on a model with `thinking_switch`; `default` — nothing sent, the model's own,
 *  only on a model that takes no efforts. */
export type Level = Effort | "off" | "default"
export const LEVEL_WORDS: readonly Level[] = [...EFFORTS, "off", "default"]
export type Control = "none" | "switch" | "slider"

/** What the levels are read from: the model's metadata, efforts as given (never absent here: an
 *  absent list is each project's fallback, effortsFor's). */
export interface LevelMeta {
  thinking_switch?: boolean
  efforts: readonly Effort[]
  effort?: string
  effort_style?: "top" | "kwargs" | "both"
}

export function isLevel(v: unknown): v is Level {
  return typeof v === "string" && (LEVEL_WORDS as readonly string[]).includes(v)
}

/** The levels a chat offers, how they are shown, and where a new conversation starts. */
export function levelsOf(meta: LevelMeta): { levels: Level[]; control: Control; start: Level } {
  const levels: Level[] = [...(meta.thinking_switch === true ? (["off"] as Level[]) : []), ...(meta.efforts.length ? meta.efforts : (["default"] as Level[]))]
  const control: Control = levels.length === 1 ? "none" : levels.length === 2 && levels.includes("off") ? "switch" : "slider"
  const start: Level =
    meta.effort && (levels as string[]).includes(meta.effort) ? (meta.effort as Level) : meta.efforts.includes("medium") ? "medium" : (meta.efforts[0] ?? "default")
  return { levels, control, start }
}

/** A model's levels: its switch, its efforts (learned > the server's > the common three). */
export function levelsFor(m: ResolvedModel) {
  return levelsOf({ thinking_switch: m.spec.thinking_switch, efforts: effortsFor(m), effort: m.spec.effort, effort_style: m.spec.effort_style })
}

/** The level a request uses for `asked`: itself when the model offers it, else the start level (a
 *  level the model does not offer — an `off` from an older client — is read as the start level). */
export function levelOf(meta: LevelMeta, asked: string | null | undefined): Level {
  const { levels, start } = levelsOf(meta)
  return asked && (levels as string[]).includes(asked) ? (asked as Level) : start
}

/** A model's level for `asked` (levelOf), or its start level when nothing is asked. */
export function readLevel(m: ResolvedModel, asked?: string | null): Level {
  return levelOf({ thinking_switch: m.spec.thinking_switch, efforts: effortsFor(m), effort: m.spec.effort }, asked)
}

/** The model's start level. */
export function defaultEffort(m: ResolvedModel): Level {
  return levelsFor(m).start
}

/** What an OpenAI chat request body carries for a level: `off` — enable_thinking false in
 *  chat_template_kwargs and no effort anywhere; `default` — nothing; an effort — where
 *  effort_style puts it, and no enable_thinking. A level the model does not offer is read as its
 *  start level. */
export function levelFields(meta: LevelMeta, asked: string | null | undefined): { reasoning_effort?: Effort; chat_template_kwargs?: Record<string, unknown> } {
  const level = levelOf(meta, asked)
  if (level === "default") return {}
  if (level === "off") return { chat_template_kwargs: { enable_thinking: false } }
  const style = meta.effort_style ?? "both"
  return { ...(style !== "kwargs" ? { reasoning_effort: level } : {}), ...(style !== "top" ? { chat_template_kwargs: { reasoning_effort: level } } : {}) }
}

/** Put the level into an openai-chat request body. `null`/undefined: nothing sent (a small job
 *  of the harness's own — a title, a commit message — sends no level). */
export function applyEffort(body: Record<string, unknown>, m: ResolvedModel, level: Level | null | undefined) {
  if (!level) return
  const f = levelFields({ thinking_switch: m.spec.thinking_switch, efforts: effortsFor(m), effort: m.spec.effort, effort_style: m.spec.effort_style }, level)
  if (f.reasoning_effort) body.reasoning_effort = f.reasoning_effort
  if (f.chat_template_kwargs) body.chat_template_kwargs = { ...((body.chat_template_kwargs as Record<string, unknown>) ?? {}), ...f.chat_template_kwargs }
}

export function stripEffort(body: Record<string, unknown>): Record<string, unknown> {
  const out = { ...body }
  delete out.reasoning_effort
  const kwargs = { ...((out.chat_template_kwargs as Record<string, unknown>) ?? {}) }
  delete kwargs.reasoning_effort
  delete kwargs.enable_thinking
  if (Object.keys(kwargs).length) out.chat_template_kwargs = kwargs
  else delete out.chat_template_kwargs
  return out
}

/** Whether an error is a chat template refusing the effort. Deliberately narrow. */
export function effortRefused(message: string): boolean {
  const m = message.toLowerCase()
  return m.includes("effort") && (m.includes("unexpected") || m.includes("supported"))
}

/** Efforts an error message advertises ("Supported types are xhigh (default), medium, and low"). */
export function advertisedEfforts(message: string): Effort[] {
  const m = message.toLowerCase()
  const at = m.indexOf("supported")
  if (at === -1) return []
  // Whole words: "high" is a substring of "xhigh".
  const words = new Set(m.slice(at).match(/[a-z]+/g) ?? [])
  return EFFORTS.filter((e) => words.has(e))
}

/** Read the accepted efforts out of a Jinja chat template (llama-server /props). ≥2 or nothing. */
export function effortsFromTemplate(template: string): Effort[] {
  if (!template || !template.includes("reasoning_effort")) return []
  const found = new Set<string>()
  for (const match of template.matchAll(/reasoning_effort/g)) {
    let window = template.slice(match.index, match.index + 400)
    if (window.includes("%}")) window = window.split("%}")[0]!
    for (const lit of window.matchAll(/['"]([a-z]{3,8})['"]/g)) found.add(lit[1]!)
  }
  for (const group of template.matchAll(/[[(]((?:\s*['"][a-z]{3,8}['"]\s*,?)+)[\])]/g)) {
    const lits = [...group[1]!.matchAll(/['"]([a-z]{3,8})['"]/g)].map((x) => x[1]!)
    if (lits.length >= 2 && lits.every((v) => (EFFORTS as readonly string[]).includes(v))) lits.forEach((v) => found.add(v))
  }
  const out = EFFORTS.filter((e) => found.has(e))
  return out.length >= 2 ? out : []
}

/** The level as a status line says it, by how the model's levels are shown: nothing for a model
 *  with one level, "thinking" / "thinking off" for a Thinking switch, else the level's name. */
export function levelLabel(m: ResolvedModel, level: Level): string {
  const { control } = levelsFor(m)
  if (control === "none") return ""
  if (control === "switch") return level === "off" ? "thinking off" : "thinking"
  return level
}
