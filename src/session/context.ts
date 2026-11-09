// /context: where the window goes. Estimates (≈4 characters a token) per part, scaled so they add
// up to what the server last reported when it reported anything.
import type { Engine } from "./engine.ts"
import { contextWindow } from "../provider/index.ts"
import { estimateTokens, imageTokens } from "../provider/tokens.ts"
import { toSpec, type Tool } from "../tool/tool.ts"

export interface ContextRow {
  label: string
  tokens: number
  indent?: boolean
}

export function contextBreakdown(engine: Engine, system: string, instructions: { path: string; text: string }[], git: string | undefined, tools: Tool[]) {
  const rows: ContextRow[] = []
  const sys = estimateTokens(system)
  rows.push({ label: "system prompt", tokens: sys })
  for (const f of instructions) rows.push({ label: f.path.split("/").slice(-2).join("/"), tokens: estimateTokens(f.text), indent: true })
  if (git) rows.push({ label: "git state", tokens: estimateTokens(git), indent: true })
  rows.push({ label: `tool definitions (${tools.length})`, tokens: estimateTokens(JSON.stringify(tools.map(toSpec))) })
  const by = { user: 0, assistant: 0, reasoning: 0, calls: 0, results: 0, images: 0 }
  let imageCount = 0
  for (const m of engine.messages) {
    if (m.role === "tool") by.results += estimateTokens(m.content)
    else
      for (const p of m.parts) {
        if (p.type === "text") by[m.role === "user" ? "user" : "assistant"] += estimateTokens(p.text)
        else if (p.type === "reasoning") by.reasoning += estimateTokens(p.text)
        else if (p.type === "tool_call") by.calls += estimateTokens(p.name + p.args)
        else {
          imageCount++
          by.images += imageTokens(p.data) // by its dimensions, as contextUsed counts it
        }
      }
  }
  rows.push({ label: "your messages and attachments", tokens: by.user })
  rows.push({ label: "replies", tokens: by.assistant })
  if (by.reasoning) rows.push({ label: "reasoning kept in the history", tokens: by.reasoning })
  rows.push({ label: "tool calls", tokens: by.calls })
  rows.push({ label: "tool results", tokens: by.results })
  if (imageCount) rows.push({ label: `images (${imageCount}, rough)`, tokens: by.images })
  const estimated = rows.filter((r) => !r.indent).reduce((n, r) => n + r.tokens, 0)
  const reported = engine.usage ? engine.contextUsed() : undefined
  // Where automatic compaction starts (EngineOptions compaction.autoAt): the reference's "N until
  // auto-compact". None without a window, or when it is switched off (1 or more).
  const autoAt = engine.o.compaction?.autoAt ?? 0.85
  return { rows, estimated, reported, window: contextWindow(engine.model), autoAt: autoAt < 1 ? autoAt : undefined, model: engine.model.ref, last: engine.lastRequest }
}

/** One glyph per category in the segmented bar, in the order the categories are listed. */
const SEGMENTS = ["█", "▓", "▒", "░", "▞", "▚", "▙", "▟"]

/** Plain text, for the transcript: what is used of the window and how much, one segmented bar of
 *  every category, each category with its tokens and its share of the window, and how far it is to
 *  automatic compaction (/compact compacts now). */
export function renderBreakdown(b: ReturnType<typeof contextBreakdown>): string {
  const width = 40
  const used = b.reported ?? b.estimated
  const total = b.window ?? Math.max(b.estimated, used)
  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
  const pct = (n: number) => (b.window ? `${Math.round((n / b.window) * 100)}%` : "")
  const cats = b.rows.filter((r) => !r.indent)
  // The categories' shares of the bar, scaled to what is in use (the server's count when it gave one).
  const scale = b.estimated ? used / b.estimated : 1
  let bar = ""
  cats.forEach((r, i) => {
    const cells = total && r.tokens > 0 ? Math.max(1, Math.round(((r.tokens * scale) / total) * width)) : 0
    bar += SEGMENTS[i % SEGMENTS.length]!.repeat(cells)
  })
  bar = bar.slice(0, width).padEnd(width, "·")
  const lines = [
    `context — ${b.model}: ${fmt(used)}${b.window ? ` / ${fmt(b.window)} tokens · ${pct(used)} used` : " tokens, window unknown"}`,
    `  ${bar}`,
  ]
  let i = 0
  for (const r of b.rows) {
    const mark = r.indent ? "   ↳" : ` ${SEGMENTS[i++ % SEGMENTS.length]} `
    lines.push(`${mark} ${r.label.padEnd(r.indent ? 30 : 31)} ${fmt(r.tokens).padStart(7)}  ${r.indent ? "" : pct(r.tokens * scale).padStart(4)}`.trimEnd())
  }
  if (b.window) lines.push(`  · ${"free".padEnd(31)} ${fmt(Math.max(0, b.window - used)).padStart(7)}  ${pct(Math.max(0, b.window - used)).padStart(4)}`)
  lines.push(`  ${"in use".padEnd(33)} ${fmt(used).padStart(7)}  ${pct(used).padStart(4)}`.trimEnd())
  if (b.window && b.autoAt !== undefined) {
    const until = Math.round(b.window * b.autoAt) - used
    lines.push(until > 0 ? `  ${fmt(until)} until auto-compact (at ${Math.round(b.autoAt * 100)}%) — /compact to compact now` : `  past auto-compact (${Math.round(b.autoAt * 100)}%): the next step compacts — /compact to compact now`)
  } else lines.push(b.window ? "  automatic compaction is off — /compact to compact now" : "  no automatic compaction without a window — /compact to compact now")
  lines.push(b.reported !== undefined ? "  (the server's own count from the last reply, plus an estimate since; the categories are estimates scaled to it)" : "  (estimated: ≈4 characters a token — no reply yet to count from)")
  // What the server reused of the last request (harness context.md §10 rule 6): a slow reply with
  // little of it cached was a re-read.
  const last = b.last?.usage
  if (last && !last.estimated)
    lines.push(
      last.cached !== undefined
        ? `  last request${b.last!.kind === "compaction" ? " (compaction)" : ""}: ${fmt(last.input)} in, ${fmt(last.cached)} of it cached${last.input ? ` (${Math.round((last.cached / last.input) * 100)}%)` : ""}`
        : `  last request: ${fmt(last.input)} in — the server did not say how much was cached`,
    )
  return lines.join("\n")
}
