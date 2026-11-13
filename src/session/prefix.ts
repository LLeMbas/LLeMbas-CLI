// The prefix (harness spec 3.1.0, context.md §10): what the model has already read stays exactly as
// it was, so its server can reuse it. The system prompt and the tool list are made once per session
// and resent byte for byte; what changes during the session goes as a note on the next user
// message. This file holds the rules and the texts, without the engine: what the model was last
// told, what a note says about the difference, which tools are offered, what a call answers when
// its requirement is not met, and what compaction asks for. The engine keeps the state
// (session/engine.ts); the conformance area `prefix` drives these functions directly.
import type { Mode } from "../config/schema.ts"
import { LOOP, TOOL_SPECS } from "../harness.ts"
import { fillPrompt } from "../prompt/fill.ts"
import { fill, promptText } from "../prompt/assemble.ts"

/** The note's texts (loop.json `context.note`). */
export const NOTE = LOOP.context.note

/** What a note says in place of something that is now empty: no plan, no memory, a file removed. */
export const NOTHING = NOTE.empty

/** The session_meta key the prefix is kept under (the prompt, the tools left out, what was told). */
export const PREFIX_META = "prefix"

/** What the system prompt holds that can change during a session: the app reads it as it is now,
 *  builds the prompt from it, and the engine compares it at every user message. Each is "" (or
 *  empty) where there is none. */
export interface Changing {
  /** The memory block as the prompt shows it. */
  memory: string
  /** The personality as the prompt shows it. */
  personality: string
  /** Instruction texts by what names them: an instruction file by its path; the person's own
   *  instructions and an instance's by their heading. */
  files: Record<string, string>
  /** MCP servers' instructions, by server. */
  mcp: Record<string, string>
  /** What the app needs to make the prompt from these same values; never compared or kept. */
  source?: unknown
}

export const NO_CHANGING: Changing = { memory: "", personality: "", files: {}, mcp: {} }

/** What the model was last told of each: by the system prompt when it was made, by a note since, or
 *  by its own tool's result (a plan it wrote, a mode its plan_submit set). `date` is absent until a
 *  note has said it. */
export interface Told extends Changing {
  date?: string
  mode: Mode
  /** The plan as rendered (plan.ts `render`), or "". */
  plan: string
}

/** What is true now, against which a Told is compared. */
export interface Now extends Changing {
  date: string
  mode: Mode
  plan: string
}

/** The prefix a session keeps (session_meta `prefix`): the prompt it sends, the tools left out of
 *  its list for the whole session (every other tool is offered, MCP tools as their servers
 *  connect), the model it was made for, and what the model has been told. */
export interface Kept {
  system: string
  left: string[]
  model: string
  told: Told
}

/** Told as of a prompt made now: everything as it is, except the date, which no prompt holds. */
export function toldAt(now: Now): Told {
  const { date: _date, source: _source, ...rest } = now
  return structuredClone(rest)
}

/** The note for a user message: a line for each thing that differs from what the model was told,
 *  in loop.json's order, inside the note's tags — "" when nothing does. `modeText` is the mode's
 *  text (modes/<mode>.md, filled as the prompt fills it). Returns what is told after it. */
export function noteFor(told: Told, now: Now, modeText: (mode: Mode) => string, extra: string[] = []): { note: string; told: Told } {
  const lines: string[] = []
  const say = (text: string, vars: Record<string, string>) => lines.push(fillPrompt(text, vars))
  const or = (s: string) => (s.trim() ? s : NOTHING)
  if (told.date !== now.date) say(NOTE.date, { date: now.date })
  if (told.mode !== now.mode) say(NOTE.mode, { mode: now.mode, mode_text: modeText(now.mode) })
  if (told.plan !== now.plan) say(NOTE.plan, { plan: or(now.plan) })
  if (told.memory !== now.memory) say(NOTE.memory, { memory: or(now.memory) })
  for (const path of union(told.files, now.files))
    if (told.files[path] !== now.files[path]) say(NOTE.instructions, { path, text: or(now.files[path] ?? "") })
  if (told.personality !== now.personality) say(NOTE.personality, { personality: or(now.personality) })
  // Only a server that has connected or changed since: one that went away takes its tools with it.
  const arrived = Object.keys(now.mcp).filter((name) => told.mcp[name] !== now.mcp[name])
  if (arrived.length) say(NOTE.mcp, { instructions: arrived.map((name) => mcpBlock(name, now.mcp[name]!)).join("\n") })
  // Spec 3.2.0: the team's size and members the person stopped (team.md §10), last.
  lines.push(...extra)
  return { note: lines.length ? noteBlock(lines) : "", told: { ...toldAt(now), date: now.date } }
}

/** The block a note is: its lines between the tags, a blank line between two. */
export function noteBlock(lines: string[]): string {
  return `${NOTE.open}\n${lines.join("\n\n")}\n${NOTE.close}`
}

/** Whether a text part of a user message is a note (not shown as the person's words). */
export function isNote(text: string): boolean {
  return text.startsWith(NOTE.open) && text.trimEnd().endsWith(NOTE.close)
}

/** One MCP server's instructions as the prompt and a note show them. */
export function mcpBlock(name: string, text: string): string {
  return `<server name="${name}">\n${text}\n</server>`
}

function union(a: Record<string, string>, b: Record<string, string>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
}

/** Today's date where this runs, as the note says it (YYYY-MM-DD). */
export function today(at = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0")
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`
}

/** A requirement a tool can have (the spec's `requires`, and the CLI's own: vision, project,
 *  knowledge). */
export type Requirement = "vision" | "plan" | "project" | "knowledge" | "display" | "page" | "forge" | "team" | "scheduled"

/** Rule 4: the tool list is fixed for the session. A tool is offered when every requirement it has
 *  is one the session could meet at some point (`could`), decided once as the prompt is made; a
 *  call while one is not met now answers `unavailable`. */
export function offeredFor(requires: readonly Requirement[] | undefined, could: ReadonlySet<Requirement>): boolean {
  return (requires ?? []).every((r) => could.has(r))
}

/** What a call answers when a requirement of its tool is not met now: the spec's text, word for
 *  word, or undefined when it is met (or the tool has no such text). */
export function unavailable(tool: string, requires: readonly Requirement[] | undefined, met: ReadonlySet<Requirement>): string | undefined {
  if ((requires ?? []).every((r) => met.has(r))) return undefined
  return TOOL_SPECS[tool]?.unavailable
}

/** §7: what the summary is asked with, as one more user message after the conversation —
 *  tasks/compact.md with `{{transcript}}` and `{{previous_summary}}` empty, since the model has the
 *  conversation, an earlier summary included, itself. */
export function compactAsk(): string {
  return fill(promptText("tasks/compact.md"), { previous_summary: "", transcript: "" })
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/** The summary in a reply to the compaction request: its text before any tool call (a call in it
 *  is not run), "" when there is none. */
export function summaryOf(parts: { type: string; text?: string }[]): string {
  const first = parts.findIndex((p) => p.type === "tool_call")
  return (first < 0 ? parts : parts.slice(0, first))
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("")
    .trim()
}
