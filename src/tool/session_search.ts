// session_search, after Hermes Agent (tools/session_search_tool.py, hermes_state_search.py; MIT,
// © Nous Research): find and read past sessions in the local store. Four shapes, by arguments:
// query = discovery, session_id + around_message_id = scroll, session_id = read, nothing = browse.
// No model is involved: what comes back is the stored messages themselves.
import { z } from "zod"
import type { Message } from "../provider/types.ts"
import type { Row, SessionRow, Store } from "../session/store.ts"
import { defineTool, ToolError, type ToolContext } from "./tool.ts"
import { described } from "../harness.ts"

/** A user's words made safe for FTS5 MATCH: quoted phrases kept, operators' punctuation dropped,
 *  terms with dots or hyphens quoted (FTS5 would read them as syntax). */
export function ftsQuery(q: string): string {
  const phrases: string[] = []
  let s = q.slice(0, 2048).replace(/"([^"]+)"/g, (_, p: string) => `\u0000${phrases.push(p.replace(/"/g, "")) - 1}\u0000`)
  s = s.replace(/[+{}():"^@/#&|~[\]<>,;!?$=\\'%`]/g, " ").replace(/\*+/g, "*").replace(/(^|\s)\*/g, "$1")
  let words = s.split(/\s+/).filter(Boolean)
  // An operator right after another (a AND NOT b, a OR OR b) is FTS5 syntax error: keep the last
  // of a run, except NOT after AND, which FTS5 spells NOT alone.
  words = words.filter((w, i) => !(/^(AND|OR|NOT)$/.test(w) && /^(AND|OR|NOT)$/.test(words[i + 1] ?? "")))
  while (words.length && /^(AND|OR|NOT)$/.test(words[0]!)) words.shift()
  while (words.length && /^(AND|OR|NOT)$/.test(words[words.length - 1]!)) words.pop()
  words = words.map((w) => (/^\u0000\d+\u0000$/.test(w) || /^(AND|OR|NOT)$/.test(w) ? w : /[.\-_]/.test(w.replace(/\*$/, "")) ? `"${w.replace(/\*$/, "")}"` : w))
  return words.join(" ").replace(/\u0000(\d+)\u0000/g, (_, i: string) => `"${phrases[Number(i)]}"`)
}

/** The same terms, any of them (the retry when all of them found nothing). */
export const anyOf = (q: string) => {
  const terms = q.match(/"[^"]*"|\S+/g) ?? []
  return terms.length > 1 && !terms.some((t) => /^(AND|OR|NOT)$/.test(t)) ? terms.join(" OR ") : undefined
}

/** What a person would read of a stored message. */
export function readable(json: string): { role: string; text: string } {
  const m = JSON.parse(json) as Message
  if (m.role === "tool") return { role: "tool", text: `[${m.name} result, ${m.content.length} chars]` }
  const text = m.parts
    .map((p) => (p.type === "text" ? p.text : p.type === "tool_call" ? `[called ${p.name}]` : p.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n")
  return { role: m.role, text }
}

const cap = (t: string, n: number) => (t.length > n ? `${t.slice(0, n)}… [${t.length - n} more chars]` : t)
const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ")
const line = (r: Row, n: number) => {
  const m = readable(r.json)
  return `#${r.id} ${m.role}: ${cap(m.text.trim(), n)}`
}
const header = (s: SessionRow) => `${s.id} · ${when(s.created)} · ${s.root}${s.title ? ` · "${s.title}"` : ""} · ${s.model}`

function snippet(text: string, query: string): string {
  const terms = (query.match(/"[^"]*"|\S+/g) ?? []).map((t) => t.replace(/^"|"$|\*$/g, "").toLowerCase()).filter((t) => t && !/^(and|or|not)$/.test(t))
  const low = text.toLowerCase()
  const at = Math.max(0, Math.min(...terms.map((t) => low.indexOf(t)).filter((i) => i >= 0), text.length))
  const start = Math.max(0, at - 60)
  return `${start ? "…" : ""}${text.slice(start, at + 140).replace(/\s+/g, " ").trim()}${at + 140 < text.length ? "…" : ""}`
}

function around(rows: Row[], id: number, window: number): Row[] {
  const i = rows.findIndex((r) => r.id === id)
  if (i < 0) throw new ToolError(`That session has no message #${id}.`)
  return rows.slice(Math.max(0, i - window), i + window + 1)
}

export const sessionSearchTool = defineTool({
  ...described("session_search"),
  purpose: false,
  access: "session_search",
  schema: z.object({
    query: z.string().optional(),
    session_id: z.string().optional(),
    around_message_id: z.number().int().optional(),
    window: z.number().int().optional(),
    limit: z.number().int().optional(),
    sort: z.enum(["newest", "oldest"]).optional(),
    this_project: z.boolean().optional(),
  }),
  permission: (a) => ({ permission: "session_search", class: "read", patterns: [a.query ?? a.session_id ?? "recent"] }),
  async run(a, ctx) {
    const src = ctx.sessions
    if (!src) throw new ToolError("There is no session store here (sessions are not being recorded).")
    const store = src.store
    const current = src.current()
    const inScope = (s: SessionRow | undefined) => !!s && s.id !== current && (!a.this_project || s.root === ctx.root)

    if (a.session_id) {
      const s = store.session(a.session_id)
      if (!s) throw new ToolError(`There is no session ${a.session_id}.`)
      if (s.id === current) throw new ToolError("That is this session — it is already in your context.")
      const rows = store.rows(s.id)
      if (a.around_message_id !== undefined) {
        const w = Math.min(20, Math.max(1, a.window ?? 5))
        const win = around(rows, a.around_message_id, w)
        const first = win[0]!.id
        const last = win[win.length - 1]!.id
        return {
          output: `${header(s)}\n\n${win.map((r) => line(r, 4000)).join("\n\n")}\n\n${first === rows[0]!.id ? "(start of the session) " : ""}${last === rows[rows.length - 1]!.id ? "(end of the session) " : ""}Scroll on with around_message_id=${last} (forward) or ${first} (back).`,
          title: `${s.id} #${first}–${last}`,
        }
      }
      const shown = rows.length > 30 ? [...rows.slice(0, 20), ...rows.slice(-10)] : rows
      const note = rows.length > 30 ? `\n\n(${rows.length} messages; showing the first 20 and the last 10 — pass around_message_id to read the middle.)` : ""
      return { output: `${header(s)}\n\n${shown.map((r) => line(r, 2000)).join("\n\n")}${note}`, title: `${s.id} · ${rows.length} messages` }
    }

    if (!a.query?.trim()) {
      const n = Math.min(10, Math.max(1, a.limit ?? 10))
      const list = store.sessions(n + 1, a.this_project ? ctx.root : undefined, true).filter((s) => s.id !== current).slice(0, n)
      if (!list.length) return { output: "No past sessions.", title: "0 sessions" }
      const out = list.map((s) => {
        const first = store.rows(s.id).find((r) => r.role === "user")
        return `${header(s)} · updated ${when(s.updated)}${first ? `\n  first: ${cap(readable(first.json).text.split("\n")[0]!, 120)}` : ""}`
      })
      return { output: out.join("\n"), title: `${list.length} recent sessions` }
    }

    const n = Math.min(10, Math.max(1, a.limit ?? 3))
    let match = ftsQuery(a.query)
    if (!match) throw new ToolError("The query has no searchable words.")
    const find = (m: string) => {
      try {
        return store.hits(m, { exclude: current ? [current] : [], sort: a.sort, root: a.this_project ? ctx.root : undefined, perSession: true, limit: n })
      } catch (e) {
        throw new ToolError(`The search could not be run (${(e as Error).message}). Use plain words, "quoted phrases", OR and NOT.`)
      }
    }
    let hits = find(match)
    let relaxed = false
    if (!hits.length && anyOf(match)) {
      match = anyOf(match)!
      hits = find(match)
      relaxed = hits.length > 0
    }
    // The best hit per session, the sessions in rank order.
    const seen = new Map<string, (typeof hits)[number]>()
    const info = new Map<string, SessionRow | undefined>()
    for (const h of hits) {
      if (seen.has(h.session_id)) continue
      if (!info.has(h.session_id)) info.set(h.session_id, store.session(h.session_id))
      if (!inScope(info.get(h.session_id))) continue
      seen.set(h.session_id, h)
      if (seen.size >= n) break
    }
    if (!seen.size)
      return { output: `No past session matches. All terms must match: try fewer words, OR between alternatives, "a quoted phrase", or a prefix like deploy*.`, title: "no match" }
    const blocks = [...seen.values()].map((h, i) => {
      const s = info.get(h.session_id)!
      const m = readable(h.json)
      const head = `${i + 1}. ${header(s)}\n   matched ${m.role} message #${h.id}: ${snippet(m.text, match)}`
      if (i > 0) return head
      const win = around(store.rows(s.id), h.id, 5).filter((r) => r.role !== "tool" || r.id === h.id)
      return `${head}\n\n${win.map((r) => `   ${line(r, 1500).replace(/\n/g, "\n   ")}`).join("\n\n")}`
    })
    return {
      output: `${relaxed ? "Nothing had all the terms; these have some of them.\n\n" : ""}${blocks.join("\n\n")}\n\nRead more with session_search(session_id, around_message_id).`,
      title: `${seen.size} session${seen.size === 1 ? "" : "s"}`,
    }
  },
})
