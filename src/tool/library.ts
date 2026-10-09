// The library's tools: notes the agent keeps, and the knowledge bases the user filled.
// Wording of knowledge_search after LLeMbas's tool.knowledge prompt (© Jaroslav Beneš,
// MIT): look there before the web, and read the document before answering from it.
import { z } from "zod"
import { SNIPPET_CHARS } from "../library/store.ts"
import { defineTool, ToolError, type ToolContext } from "./tool.ts"
import { described } from "../harness.ts"

const MAX_GET = 40_000
const MAX_NOTE = 20_000

function lib(ctx: ToolContext) {
  if (!ctx.library) throw new ToolError("The library is not available here.")
  return ctx.library
}

// Notes are three tools (harness spec v1): reading and writing are never one tool, so a reviewer
// or a read-only helper is given the readers and nothing else.
function noteScopes(ctx: ToolContext) {
  const L = lib(ctx)
  return { L, scopes: ["global", ...(L.project ? [L.project] : [])] }
}
const scopeLabel = (scope: string) => (scope === "global" ? "global" : "project")

function ownNote(ctx: ToolContext, id: number) {
  const { L, scopes } = noteScopes(ctx)
  const n = L.lib.note(id)
  if (!n || !scopes.includes(n.scope)) throw new ToolError(`There is no note ${id} here.`)
  return { L, n }
}

export const notesSearchTool = defineTool({
  ...described("notes_search"),
  access: "notes",
  purpose: false,
  schema: z.object({
    query: z.string().optional(),
  }),
  permission: (a) => ({ permission: "notes", class: "read", patterns: [a.query || "*"] }),
  async run(a, ctx) {
    const { L, scopes } = noteScopes(ctx)
    const found = L.lib.notes(scopes, a.query, 15)
    if (!found.length) return { output: a.query ? `No note matches "${a.query}".` : "No notes yet.", title: "0 notes" }
    return { output: found.map((n) => `[${n.id}] ${n.title} (${scopeLabel(n.scope)}, ${new Date(n.updated).toISOString().slice(0, 10)})`).join("\n") + "\n\nRead one with note_view.", title: `${found.length} notes` }
  },
})

export const noteViewTool = defineTool({
  ...described("note_view"),
  access: "notes",
  purpose: false,
  schema: z.object({
    id: z.number().int(),
  }),
  permission: (a) => ({ permission: "notes", class: "read", patterns: [String(a.id)] }),
  async run(a, ctx) {
    const { n } = ownNote(ctx, a.id)
    return { output: `# ${n.title}\n(${scopeLabel(n.scope)}, updated ${new Date(n.updated).toISOString().slice(0, 16).replace("T", " ")})\n\n${n.body}`, title: n.title }
  },
})

export const noteManageTool = defineTool({
  ...described("note_manage"),
  access: "notes",
  purpose: false,
  schema: z.object({
    action: z.enum(["create", "edit", "delete"]),
    id: z.number().int().optional(),
    title: z.string().max(200).optional(),
    body: z.string().optional(),
    scope: z.enum(["project", "global"]).optional(),
  }),
  permission: (a) => ({ permission: "notes", class: "interact", patterns: [a.action] }),
  async run(a, ctx) {
    const { L } = noteScopes(ctx)
    if (a.action === "create") {
      if (!a.title?.trim() || !a.body?.trim()) throw new ToolError("create needs a title and a body.")
      if (a.body.length > MAX_NOTE) throw new ToolError(`A note is at most ${MAX_NOTE} characters; this one is ${a.body.length}.`)
      const scope = a.scope === "global" || !L.project ? "global" : L.project
      const n = L.lib.addNote(scope, a.title.trim(), a.body)
      return { output: `Saved note ${n.id} (${scopeLabel(scope)}).`, title: `+ ${n.title}` }
    }
    if (a.id === undefined) throw new ToolError(`${a.action} needs the note's id (notes_search finds it).`)
    const { n } = ownNote(ctx, a.id)
    if (a.action === "delete") {
      L.lib.deleteNote(n.id)
      return { output: `Deleted note ${n.id}.`, title: `− ${n.title}` }
    }
    if (a.body !== undefined && a.body.length > MAX_NOTE) throw new ToolError(`A note is at most ${MAX_NOTE} characters.`)
    L.lib.editNote(n.id, { title: a.title?.trim() || undefined, body: a.body })
    return { output: `Changed note ${n.id}.`, title: `~ ${a.title ?? n.title}` }
  },
})

export const knowledgeSearchTool = defineTool({
  ...described("knowledge_search"),
  access: "knowledge",
  purpose: false,
  requires: "knowledge",
  schema: z.object({
    query: z.string().min(1),
    base: z.string().optional(),
  }),
  permission: (a) => ({ permission: "knowledge", class: "read", patterns: [a.base ?? "*"] }),
  async run(a, ctx) {
    const L = lib(ctx)
    const bases = a.base ? [a.base] : L.bases
    if (a.base && L.bases && !L.bases.includes(a.base)) throw new ToolError(`"${a.base}" is not one of this project's knowledge bases: ${L.bases.join(", ")}`)
    let note = ""
    let hits
    try {
      hits = await L.lib.search(a.query, { bases, embedder: L.embedder, signal: ctx.signal })
    } catch (e) {
      // The embedding model is away: words alone, and said.
      note = `\n\n(searched by words only — the embedding model failed: ${(e as Error).message.split("\n")[0]})`
      hits = await L.lib.search(a.query, { bases, signal: ctx.signal })
    }
    if (!hits.length) return { output: `Nothing in the knowledge bases matches "${a.query}".${note}`, title: "0 found" }
    const out = hits.map((h) => `[${h.id}] ${h.title} (${h.base}${h.source !== h.title ? ` · ${h.source}` : ""})\n${h.snippet.slice(0, SNIPPET_CHARS)}`).join("\n\n---\n\n")
    return { output: `${out}\n\nRead a document whole with knowledge_get(id).${note}`, title: `${hits.length} found` }
  },
})

export const knowledgeGetTool = defineTool({
  ...described("knowledge_get"),
  access: "knowledge",
  purpose: false,
  requires: "knowledge",
  schema: z.object({ id: z.number().int(), offset: z.number().int().min(0).optional() }),
  permission: () => ({ permission: "knowledge", class: "read", patterns: ["*"] }),
  async run(a, ctx) {
    const L = lib(ctx)
    const d = L.lib.document(a.id)
    if (!d || (L.bases && !L.bases.includes(d.base))) throw new ToolError(`There is no document ${a.id} in this project's knowledge bases.`)
    if (d.error && !d.text) return { output: `[${d.id}] ${d.title}: no text — ${d.error}`, title: d.title, isError: true }
    const from = a.offset ?? 0
    const part = d.text.slice(from, from + MAX_GET)
    const rest = d.text.length - from - part.length
    const tail = rest > 0 ? `\n\n[…${rest.toLocaleString("en")} more characters: knowledge_get(id: ${d.id}, offset: ${from + part.length})]` : d.truncated ? "\n\n[the document was cut at 120,000 characters when it was added]" : ""
    return { output: `# ${d.title}\n(${d.base} · ${d.source})\n\n${part}${tail}`, title: `${d.title}${from ? ` @${from}` : ""}` }
  },
})
