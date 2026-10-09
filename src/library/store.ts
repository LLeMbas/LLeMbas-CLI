// The library, after LLeMbas's (services/library/, © Jaroslav Beneš, MIT):
// notes the agent keeps, and knowledge bases of documents — files, directories, web pages —
// split into pieces and searched by their words (FTS5, bm25) and, when an embedding model is
// set, by meaning too, the two fused by reciprocal rank. One SQLite file,
// ~/.local/share/lembas/library.db, shared by every project; a project may narrow which
// bases it searches (`knowledge:` in its config).
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { paths } from "../config/paths.ts"
import { anyOf, ftsQuery } from "../tool/session_search.ts"
import { split } from "./chunks.ts"

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
  created INTEGER NOT NULL, updated INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(title, body, content='notes', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts (rowid, title, body) VALUES (new.id, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts (notes_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts (notes_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
  INSERT INTO notes_fts (rowid, title, body) VALUES (new.id, new.title, new.body);
END;

CREATE TABLE IF NOT EXISTS bases (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT, base_id INTEGER NOT NULL REFERENCES bases(id) ON DELETE CASCADE,
  title TEXT NOT NULL, source TEXT NOT NULL, text TEXT NOT NULL, hash TEXT NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0, error TEXT, added INTEGER NOT NULL,
  UNIQUE (base_id, source)
);
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL, text TEXT NOT NULL, vector BLOB, dims INTEGER, model TEXT
);
CREATE INDEX IF NOT EXISTS chunks_doc ON chunks(doc_id, ordinal);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, content='chunks', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts (rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts (chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
`

/** Reciprocal-rank fusion: a result's score is the sum over the lists it is in of 1/(K + rank). */
export const RRF_K = 60
/** Pieces looked at per document wanted: a document scores as its best piece. */
const CHUNK_MULTIPLIER = 6
export const SNIPPET_CHARS = 1200

export interface Base {
  id: number
  name: string
  description: string
  documents: number
}

export interface Doc {
  id: number
  base: string
  title: string
  source: string
  chars: number
  truncated: boolean
  error?: string
  added: number
}

export interface Hit {
  id: number
  base: string
  title: string
  source: string
  snippet: string
}

export interface Note {
  id: number
  scope: string
  title: string
  body: string
  updated: number
}

/** An embedding model: turns texts into vectors (unit length), all of one width. */
export interface Embedder {
  model: string
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex")
const toBlob = (v: Float32Array) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
const fromBlob = (b: Uint8Array) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))

export class Library {
  readonly db: Database

  constructor(file = join(paths.data, "library.db")) {
    mkdirSync(paths.data, { recursive: true })
    this.db = new Database(file, { create: true })
    this.db.run("PRAGMA journal_mode = WAL")
    this.db.run("PRAGMA foreign_keys = ON")
    this.db.exec(SCHEMA)
  }

  close() {
    this.db.close()
  }

  // ── notes ────────────────────────────────────────────────────────────────────────────────
  addNote(scope: string, title: string, body: string): Note {
    const now = Date.now()
    const r = this.db.query("INSERT INTO notes (scope, title, body, created, updated) VALUES (?, ?, ?, ?, ?)").run(scope, title, body, now, now)
    return { id: Number(r.lastInsertRowid), scope, title, body, updated: now }
  }

  note(id: number): Note | undefined {
    return (this.db.query("SELECT id, scope, title, body, updated FROM notes WHERE id = ?").get(id) as Note | null) ?? undefined
  }

  editNote(id: number, change: { title?: string; body?: string }) {
    const n = this.note(id)
    if (!n) throw new Error(`there is no note ${id}`)
    this.db.query("UPDATE notes SET title = ?, body = ?, updated = ? WHERE id = ?").run(change.title ?? n.title, change.body ?? n.body, Date.now(), id)
  }

  deleteNote(id: number) {
    this.db.query("DELETE FROM notes WHERE id = ?").run(id)
  }

  /** Notes in these scopes ("global", and a project's root), by words — or the newest, with no query. */
  notes(scopes: string[], query?: string, limit = 10): Note[] {
    const inScope = `n.scope IN (${scopes.map(() => "?").join(",")})`
    if (!query?.trim()) return this.db.query(`SELECT id, scope, title, body, updated FROM notes n WHERE ${inScope} ORDER BY updated DESC LIMIT ?`).all(...scopes, limit) as Note[]
    const run = (match: string) =>
      this.db.query(`SELECT n.id, n.scope, n.title, n.body, n.updated FROM notes_fts f JOIN notes n ON n.id = f.rowid WHERE notes_fts MATCH ? AND ${inScope} ORDER BY bm25(notes_fts) LIMIT ?`).all(match, ...scopes, limit) as Note[]
    const q = ftsQuery(query)
    if (!q) return []
    const all = run(q)
    const any = all.length ? undefined : anyOf(q)
    return any ? run(any) : all
  }

  // ── knowledge bases ──────────────────────────────────────────────────────────────────────
  createBase(name: string, description = ""): Base {
    if (!/^[\w.-]{1,64}$/.test(name)) throw new Error(`"${name}" is not a base name: letters, digits, - _ . — up to 64`)
    if (this.base(name)) throw new Error(`there is a knowledge base "${name}" already`)
    const r = this.db.query("INSERT INTO bases (name, description, created) VALUES (?, ?, ?)").run(name, description, Date.now())
    return { id: Number(r.lastInsertRowid), name, description, documents: 0 }
  }

  base(name: string): Base | undefined {
    return (this.db.query("SELECT b.id, b.name, b.description, (SELECT count(*) FROM documents d WHERE d.base_id = b.id) AS documents FROM bases b WHERE b.name = ?").get(name) as Base | null) ?? undefined
  }

  bases(): Base[] {
    return this.db.query("SELECT b.id, b.name, b.description, (SELECT count(*) FROM documents d WHERE d.base_id = b.id) AS documents FROM bases b ORDER BY b.name").all() as Base[]
  }

  deleteBase(name: string) {
    this.db.query("DELETE FROM bases WHERE name = ?").run(name)
  }

  documents(base: string): Doc[] {
    return (
      this.db
        .query("SELECT d.id, b.name AS base, d.title, d.source, length(d.text) AS chars, d.truncated, d.error, d.added FROM documents d JOIN bases b ON b.id = d.base_id WHERE b.name = ? ORDER BY d.title")
        .all(base) as (Omit<Doc, "truncated" | "error"> & { truncated: number; error: string | null })[]
    ).map((d) => ({ ...d, truncated: !!d.truncated, error: d.error ?? undefined }))
  }

  document(id: number): (Doc & { text: string }) | undefined {
    const d = this.db
      .query("SELECT d.id, b.name AS base, d.title, d.source, d.text, length(d.text) AS chars, d.truncated, d.error, d.added FROM documents d JOIN bases b ON b.id = d.base_id WHERE d.id = ?")
      .get(id) as (Omit<Doc, "truncated" | "error"> & { text: string; truncated: number; error: string | null }) | null
    return d ? { ...d, truncated: !!d.truncated, error: d.error ?? undefined } : undefined
  }

  deleteDocument(id: number) {
    this.db.query("DELETE FROM documents WHERE id = ?").run(id)
  }

  /** Put a document into a base, or replace the one from the same source. Unchanged text is left as
   *  it is (its pieces and vectors kept). Returns the document's id and whether anything changed. */
  putDocument(base: string, d: { title: string; source: string; text: string; truncated?: boolean; error?: string }): { id: number; changed: boolean } {
    const b = this.base(base)
    if (!b) throw new Error(`there is no knowledge base "${base}"`)
    const h = hash(d.text)
    const old = this.db.query("SELECT id, hash FROM documents WHERE base_id = ? AND source = ?").get(b.id, d.source) as { id: number; hash: string } | null
    if (old && old.hash === h) return { id: old.id, changed: false }
    return this.db.transaction(() => {
      if (old) this.db.query("DELETE FROM documents WHERE id = ?").run(old.id)
      const r = this.db
        .query("INSERT INTO documents (base_id, title, source, text, hash, truncated, error, added) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(b.id, d.title, d.source, d.text, h, d.truncated ? 1 : 0, d.error ?? null, Date.now())
      const id = Number(r.lastInsertRowid)
      const insert = this.db.query("INSERT INTO chunks (doc_id, ordinal, text) VALUES (?, ?, ?)")
      split(d.text).forEach((t, i) => insert.run(id, i, t))
      return { id, changed: true }
    })()
  }

  /** Pieces with no vector from this model (new ones, or all of them after the model changed). */
  unembedded(model: string, limit = 256): { id: number; text: string }[] {
    return this.db.query("SELECT id, text FROM chunks WHERE vector IS NULL OR model IS NOT ? LIMIT ?").all(model, limit) as { id: number; text: string }[]
  }

  setVectors(model: string, rows: { id: number; vector: Float32Array }[]) {
    const q = this.db.query("UPDATE chunks SET vector = ?, dims = ?, model = ? WHERE id = ?")
    this.db.transaction(() => {
      for (const r of rows) q.run(toBlob(r.vector), r.vector.length, model, r.id)
    })()
  }

  /** Give every piece a vector from `e`, in batches; returns how many were embedded. */
  async embedAll(e: Embedder, signal?: AbortSignal, batch = 16): Promise<number> {
    let n = 0
    for (;;) {
      const rows = this.unembedded(e.model, batch)
      if (!rows.length) return n
      const vectors = await e.embed(rows.map((r) => r.text), signal)
      if (vectors.length !== rows.length) throw new Error(`the embedding model returned ${vectors.length} vectors for ${rows.length} texts`)
      this.setVectors(
        e.model,
        rows.map((r, i) => ({ id: r.id, vector: vectors[i]! })),
      )
      n += rows.length
    }
  }

  /** Documents for a query: words (bm25) and, with an embedder, meaning (cosine) — fused by RRF.
   *  `bases`: only these (undefined: every base). */
  async search(query: string, o: { bases?: string[]; limit?: number; embedder?: Embedder; signal?: AbortSignal } = {}): Promise<Hit[]> {
    const limit = o.limit ?? 6
    const want = limit * CHUNK_MULTIPLIER
    const inBases = o.bases ? `AND b.name IN (${o.bases.map(() => "?").join(",") || "''"})` : ""
    const bargs = o.bases ?? []
    const lists: number[][] = []

    const q = ftsQuery(query)
    if (q) {
      const run = (match: string) =>
        (
          this.db
            .query(`SELECT c.id FROM chunks_fts f JOIN chunks c ON c.id = f.rowid JOIN documents d ON d.id = c.doc_id JOIN bases b ON b.id = d.base_id WHERE chunks_fts MATCH ? ${inBases} ORDER BY bm25(chunks_fts) LIMIT ?`)
            .all(match, ...bargs, want) as { id: number }[]
        ).map((r) => r.id)
      let ids = run(q)
      const any = ids.length ? undefined : anyOf(q)
      if (any) ids = run(any)
      lists.push(ids)
    }

    if (o.embedder) {
      const [v] = await o.embedder.embed([query], o.signal)
      if (v) {
        const rows = this.db
          .query(`SELECT c.id, c.vector FROM chunks c JOIN documents d ON d.id = c.doc_id JOIN bases b ON b.id = d.base_id WHERE c.model = ? AND c.dims = ? ${inBases}`)
          .all(o.embedder.model, v.length, ...bargs) as { id: number; vector: Uint8Array }[]
        const scored = rows.map((r) => {
          const w = fromBlob(r.vector)
          let dot = 0
          for (let i = 0; i < w.length; i++) dot += w[i]! * v[i]!
          return { id: r.id, dot }
        })
        scored.sort((a, b) => b.dot - a.dot)
        lists.push(scored.slice(0, want).map((s) => s.id))
      }
    }

    // Fused per piece, then a document scores as its best piece.
    const score = new Map<number, number>()
    for (const list of lists) list.forEach((id, rank) => score.set(id, (score.get(id) ?? 0) + 1 / (RRF_K + rank + 1)))
    const best = new Map<number, { chunk: number; score: number }>()
    const docOf = this.db.query("SELECT doc_id FROM chunks WHERE id = ?")
    for (const [chunk, s] of score) {
      const doc = (docOf.get(chunk) as { doc_id: number }).doc_id
      const cur = best.get(doc)
      if (!cur || s > cur.score) best.set(doc, { chunk, score: s })
    }
    const top = [...best.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, limit)
    const meta = this.db.query("SELECT d.id, b.name AS base, d.title, d.source FROM documents d JOIN bases b ON b.id = d.base_id WHERE d.id = ?")
    const text = this.db.query("SELECT text FROM chunks WHERE id = ?")
    return top.map(([doc, { chunk }]) => {
      const m = meta.get(doc) as { id: number; base: string; title: string; source: string }
      const t = (text.get(chunk) as { text: string }).text
      return { ...m, snippet: t.length > SNIPPET_CHARS ? `${t.slice(0, SNIPPET_CHARS)}…` : t }
    })
  }
}
