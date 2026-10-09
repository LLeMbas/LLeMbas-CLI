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

/** The efforts this model accepts, in offering order: learned > configured > the common three. */
export function effortsFor(m: ResolvedModel): Effort[] {
  const list = learned().efforts[m.ref] ?? m.spec.efforts ?? DEFAULT_EFFORTS
  return EFFORTS.filter((e) => list.includes(e))
}

/** The model's default effort, or null for off / not a reasoning model. */
export function defaultEffort(m: ResolvedModel): Effort | null {
  const e = m.spec.effort
  if (!e || e === "off") return null
  return effortsFor(m).includes(e) ? e : null
}

/** Put the effort into an openai-chat request body. An effort outside the vocabulary is dropped. */
export function applyEffort(body: Record<string, unknown>, m: ResolvedModel, effort: Effort | null | undefined) {
  if (!effort || !effortsFor(m).includes(effort)) return
  const style = m.spec.effort_style ?? "both"
  if (style !== "kwargs") body.reasoning_effort = effort
  if (style !== "top") {
    const kwargs = { ...((body.chat_template_kwargs as Record<string, unknown>) ?? {}) }
    kwargs.reasoning_effort = effort
    body.chat_template_kwargs = kwargs
  }
}

export function stripEffort(body: Record<string, unknown>): Record<string, unknown> {
  const out = { ...body }
  delete out.reasoning_effort
  const kwargs = { ...((out.chat_template_kwargs as Record<string, unknown>) ?? {}) }
  delete kwargs.reasoning_effort
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
