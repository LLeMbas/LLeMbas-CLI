// Subagents (harness spec 3.3.0, harness/subagents.md): which model a subagent — a task subagent or
// a team's member — runs on, and whether subagents are offered at all. The rules alone, without an
// engine: the conformance area `subagents` drives them, and the app (spawn, team_add) asks them.
import { LOOP } from "../harness.ts"
import type { Message } from "../provider/types.ts"
import { parallelFrom, type Capacity } from "./team.ts"

export const SUBAGENTS = LOOP.subagents
const TEXTS = SUBAGENTS.texts

/** A model the person may use: its served id (the ref), its id at its connection, its display name. */
export interface ModelInfo {
  ref: string
  id?: string
  name?: string
  capacity: Capacity
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const BEFORE = new RegExp(`${SUBAGENTS.named.before}$`, "u")
const AFTER = new RegExp(`^(?:${SUBAGENTS.named.after})`, "u")

/** The names a model goes by: the served id, the part after its provider, the display name. */
export function namesOf(m: Pick<ModelInfo, "ref" | "id" | "name">): string[] {
  const out = [m.ref]
  if (m.id) out.push(m.id)
  const slash = m.ref.lastIndexOf("/")
  if (slash >= 0) out.push(m.ref.slice(slash + 1))
  if (m.name?.trim()) out.push(m.name.trim())
  return [...new Set(out.filter(Boolean))]
}

/** Whether `name` occurs in `text` as a whole word, without case (subagents.md §2). White space in
 *  the name matches any run of white space. */
export function occursAsWord(text: string, name: string): boolean {
  const pattern = name
    .trim()
    .split(/\s+/)
    .map(escape)
    .join("\\s+")
  if (!pattern) return false
  const re = new RegExp(pattern, "giu")
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const before = text.slice(0, m.index)
    const after = text.slice(m.index + m[0].length)
    if (!BEFORE.test(before) && !AFTER.test(after)) return true
    re.lastIndex = m.index + 1
  }
  return false
}

/** Whether the person named the model in any of the messages they typed. */
export function named(m: Pick<ModelInfo, "ref" | "id" | "name">, said: readonly string[]): boolean {
  const names = namesOf(m)
  return said.some((t) => names.some((n) => occursAsWord(t, n)))
}

/** What the person typed in a session, oldest first: their prompts and what they sent mid-turn
 *  (after `steerMark`) — never a note, a job's or a team's marked message, or a machine turn. */
export function personTexts(messages: readonly Message[], steerMark: string): string[] {
  const out: string[] = []
  for (const m of messages) {
    if (m.role !== "user" || m.machine) continue
    const first = m.parts[0]
    if (!first || first.type !== "text") continue
    if (m.turn === false) {
      if (first.text.startsWith(steerMark)) out.push(first.text.slice(steerMark.length).trim())
      continue
    }
    out.push(first.text)
  }
  return out
}

/** Whether a model can be its own session's subagent: it serves two requests at once, or has no limit. */
export function servesOwn(c: Capacity): boolean {
  return parallelFrom(c) >= 2
}

/** subagents.md §4: whether subagents are offered for a session on `session`, given the models the
 *  person may use, and whether the session's model can serve its own. */
export function offer(session: ModelInfo, models: readonly ModelInfo[], subagents = true): { offered: boolean; own: boolean } {
  const own = servesOwn(session.capacity)
  const group = session.capacity.group
  const other = models.some((m) => m.ref !== session.ref && (group === undefined || m.capacity.group !== group))
  return { offered: subagents && (own || other), own }
}

/** subagents.md §2, §3: the model a subagent runs on — the session's, or `wanted` (already resolved
 *  to a model the person may use) — or the refusal, word for word. */
export function subagentModel(session: ModelInfo, wanted: ModelInfo | undefined, said: readonly string[]): { model: string } | { refused: string } {
  const m = wanted ?? session
  if (m.ref !== session.ref) {
    if (!named(m, said)) return { refused: TEXTS.not_named }
    const group = session.capacity.group
    if (group !== undefined && m.capacity.group === group) return { refused: TEXTS.same_group }
    return { model: m.ref }
  }
  if (!servesOwn(session.capacity)) return { refused: TEXTS.one_request }
  return { model: session.ref }
}
