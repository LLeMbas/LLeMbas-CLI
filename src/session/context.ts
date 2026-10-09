// /context: where the window goes. Estimates (≈4 characters a token) per part, scaled so they add
// up to what the server last reported when it reported anything.
import type { Engine } from "./engine.ts"
import { contextWindow } from "../provider/discover.ts"
import { estimateTokens } from "../provider/tokens.ts"
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
          by.images += 800 // providers bill an image at roughly this for a typical screenshot
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
  return { rows, estimated, reported, window: contextWindow(engine.model), model: engine.model.ref }
}

/** Plain text, for the transcript. */
export function renderBreakdown(b: ReturnType<typeof contextBreakdown>): string {
  const width = 24
  const total = b.window ?? Math.max(b.estimated, b.reported ?? 0)
  const bar = (n: number) => {
    const cells = total ? Math.max(n > 0 ? 1 : 0, Math.round((n / total) * width)) : 0
    return "█".repeat(Math.min(width, cells)).padEnd(width, "·")
  }
  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
  const lines = [`context — ${b.model}${b.window ? `, window ${fmt(b.window)}` : ", window unknown"}`]
  for (const r of b.rows) lines.push(`${r.indent ? "   ↳ " : "  "}${r.label.padEnd(r.indent ? 30 : 33)} ${fmt(r.tokens).padStart(7)}  ${r.indent ? "" : bar(r.tokens)}`)
  const used = b.reported ?? b.estimated
  lines.push(`  ${"in use".padEnd(33)} ${fmt(used).padStart(7)}  ${bar(used)}${b.window ? `  ${Math.round((used / b.window) * 100)}%` : ""}`)
  lines.push(b.reported !== undefined ? "  (the server's own count from the last reply, plus an estimate since)" : "  (estimated: ≈4 characters a token — no reply yet to count from)")
  return lines.join("\n")
}
