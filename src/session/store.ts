import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { paths } from "../config/paths.ts"
import type { Message } from "../provider/types.ts"

// Sessions and their messages, in ~/.local/share/lembas/sessions.db. Message text is also
// indexed with FTS5 so past sessions can be searched (session_search).

export interface SessionRow {
  id: string
  created: number
  updated: number
  title: string
  root: string
  model: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, created INTEGER NOT NULL, updated INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '', root TEXT NOT NULL, model TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL, json TEXT NOT NULL, created INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'message'
);
CREATE INDEX IF NOT EXISTS messages_session_kind ON messages(session_id, kind, id);
CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, id);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, content='', contentless_delete=1);
CREATE TABLE IF NOT EXISTS session_meta (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, key TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY (session_id, key)
);
`

/** The session_meta key saying a session has been in the web UI's hands (its rules are in
 *  acp/agent.ts, which re-exports it). Here, so the app can ask it too without importing the
 *  agent, which imports the app. */
export const REMOTE_META = "remote"

/** The session_meta key holding the directory a session was started in: a session started
 *  in a subdirectory of its project is reopened there, not at the project's root. */
export const CWD_META = "cwd"

export function plainText(m: Message): string {
  if (m.role === "tool") return m.content
  return m.parts.map((p) => (p.type === "text" || p.type === "reasoning" ? p.text : p.type === "tool_call" ? `${p.name} ${p.args}` : "")).join("\n")
}

export interface Row {
  id: number
  role: string
  json: string
  created: number
}
export interface Hit extends Row {
  session_id: string
}

export class Store {
  readonly db: Database

  constructor(file = join(paths.data, "sessions.db")) {
    if (file !== ":memory:") mkdirSync(paths.data, { recursive: true })
    this.db = new Database(file, { create: true })
    this.db.run("PRAGMA journal_mode = WAL")
    // Several writers share this file: every terminal, the service, and in the service one
    // connection per session it holds. Without a timeout a write that meets another's lock fails at
    // once with "database is locked" — a delete from the web UI among them, which the instance then
    // only saw as a refusal. Writes here are short; waiting for one is always right.
    this.db.run("PRAGMA busy_timeout = 5000")
    this.db.run("PRAGMA foreign_keys = ON")
    // Additive migrations: a column is added when missing, never renamed or dropped.
    this.db.exec(SCHEMA.split("CREATE INDEX IF NOT EXISTS messages_session_kind")[0]!)
    const cols = (this.db.query("PRAGMA table_info(messages)").all() as { name: string }[]).map((c) => c.name)
    if (!cols.includes("kind")) this.db.run("ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'message'")
    this.db.exec(SCHEMA)
  }

  createSession(root: string, model: string): SessionRow {
    const now = Date.now()
    const id = `ses_${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`
    this.db.query("INSERT INTO sessions (id, created, updated, root, model) VALUES (?, ?, ?, ?, ?)").run(id, now, now, root, model)
    return { id, created: now, updated: now, title: "", root, model }
  }

  append(sessionId: string, m: Message): number {
    const now = Date.now()
    const r = this.db.query("INSERT INTO messages (session_id, role, json, created) VALUES (?, ?, ?, ?)").run(sessionId, m.role, JSON.stringify(m), now)
    const text = plainText(m)
    if (text.trim()) this.db.query("INSERT INTO messages_fts (rowid, text) VALUES (?, ?)").run(r.lastInsertRowid, text)
    this.db.query("UPDATE sessions SET updated = ? WHERE id = ?").run(now, sessionId)
    return Number(r.lastInsertRowid)
  }

  /** Delete a session and everything in it: /sessions delete, /delete, or the web UI
   *  deleting the chat it is. The search index has no content of its own, so its rows go by id. */
  deleteSession(sessionId: string): boolean {
    const del = this.db.transaction(() => {
      this.db.query("DELETE FROM messages_fts WHERE rowid IN (SELECT id FROM messages WHERE session_id = ?)").run(sessionId)
      return this.db.query("DELETE FROM sessions WHERE id = ?").run(sessionId).changes > 0
    })
    // IMMEDIATE: the write lock taken up front, so busy_timeout applies. A deferred
    // transaction starts by reading (the subquery), and one that then meets another process's
    // write lock is refused at once — SQLite will not wait in a way that could deadlock — so a
    // delete from the web UI that met a terminal writing a turn failed as "database is locked".
    return del.immediate()
  }

  /** /undo and /redo: hide or bring back the rows of a turn. They are never deleted. */
  setKind(sessionId: string, fromId: number, toId: number, kind: "message" | "reverted") {
    const other = kind === "message" ? "reverted" : "message"
    this.db.query("UPDATE messages SET kind = ? WHERE session_id = ? AND id BETWEEN ? AND ? AND kind = ?").run(kind, sessionId, fromId, toId, other)
  }

  /** The row of the user message that started turn `turnId` (kept with the message, engine.ts),
   *  or undefined for a turn this session does not have. */
  turnRow(sessionId: string, turnId: string): number | undefined {
    // The LIKE is a prefilter; the message itself says.
    const rows = this.db.query("SELECT id, json FROM messages WHERE session_id = ? AND role = 'user' AND kind = 'message' AND json LIKE ? ORDER BY id").all(sessionId, `%${JSON.stringify(turnId)}%`) as { id: number; json: string }[]
    return rows.find((r) => (JSON.parse(r.json) as Message).role === "user" && (JSON.parse(r.json) as { turnId?: string }).turnId === turnId)?.id
  }

  /** The turns that start at row `fromId` or after it, oldest first: the ids the visible user
   *  messages carry. */
  turnIdsFrom(sessionId: string, fromId: number): string[] {
    const rows = this.db.query("SELECT json FROM messages WHERE session_id = ? AND role = 'user' AND kind = 'message' AND id >= ? ORDER BY id").all(sessionId, fromId) as { json: string }[]
    return rows.map((r) => (JSON.parse(r.json) as { turnId?: string }).turnId).filter((id): id is string => typeof id === "string")
  }

  /** Record a compaction: what the model sees from here on starts with this summary. */
  compaction(sessionId: string, summary: string) {
    this.db
      .query("INSERT INTO messages (session_id, role, json, created, kind) VALUES (?, 'user', ?, ?, 'compaction')")
      .run(sessionId, JSON.stringify({ summary }), Date.now())
  }

  /** The conversation as the model sees it: from the last compaction on, the summary first. */
  context(sessionId: string): Message[] {
    const last = this.db
      .query("SELECT id, json FROM messages WHERE session_id = ? AND kind = 'compaction' ORDER BY id DESC LIMIT 1")
      .get(sessionId) as { id: number; json: string } | null
    const after = last?.id ?? 0
    const rows = this.db
      .query("SELECT json FROM messages WHERE session_id = ? AND kind = 'message' AND id > ? ORDER BY id")
      .all(sessionId, after) as { json: string }[]
    const msgs = rows.map((r) => JSON.parse(r.json) as Message)
    return last ? [...summaryTurns(JSON.parse(last.json).summary as string), ...msgs] : msgs
  }

  /** Something a session keeps besides its messages, as JSON. */
  meta<T>(sessionId: string, key: string): T | undefined {
    const r = this.db.query("SELECT value FROM session_meta WHERE session_id = ? AND key = ?").get(sessionId, key) as { value: string } | null
    return r ? (JSON.parse(r.value) as T) : undefined
  }

  setMeta(sessionId: string, key: string, value: unknown) {
    this.db.query("INSERT INTO session_meta (session_id, key, value) VALUES (?, ?, ?) ON CONFLICT (session_id, key) DO UPDATE SET value = excluded.value").run(sessionId, key, JSON.stringify(value))
  }

  setTitle(sessionId: string, title: string) {
    this.db.query("UPDATE sessions SET title = ? WHERE id = ?").run(title, sessionId)
  }

  /** The text of a session's first user message (sessions from before titles have only this). */
  firstPrompt(sessionId: string): string {
    const r = this.db.query("SELECT json FROM messages WHERE session_id = ? AND role = 'user' AND kind = 'message' ORDER BY id LIMIT 1").get(sessionId) as { json: string } | null
    if (!r) return ""
    const m = JSON.parse(r.json) as Message
    return m.role === "user" ? m.parts.map((p) => (p.type === "text" ? p.text : "")).find((t) => t.trim()) ?? "" : ""
  }

  messages(sessionId: string): Message[] {
    return (this.db.query("SELECT json FROM messages WHERE session_id = ? AND kind = 'message' ORDER BY id").all(sessionId) as { json: string }[]).map(
      (r) => JSON.parse(r.json) as Message,
    )
  }

  /** Newest first. `withMessages`: only sessions somebody said something in (every start and /new
   *  makes one, so the empty ones would crowd out the rest). */
  sessions(limit = 50, root?: string, withMessages = false): SessionRow[] {
    const where = [root ? "s.root = ?" : "", withMessages ? "EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id AND m.kind = 'message')" : ""].filter(Boolean)
    return this.db
      .query(`SELECT s.* FROM sessions s ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY s.updated DESC LIMIT ?`)
      .all(...(root ? [root] : []), limit) as SessionRow[]
  }

  /** FTS hits in visible user/assistant messages (not reverted, not tool output), best first.
   *  `root` keeps one project's sessions; `perSession` the best hit of each session. Both are done
   *  before the limit, so a busy other project cannot push this one's hits out. */
  hits(match: string, o: { exclude?: string[]; sort?: "newest" | "oldest"; limit?: number; roles?: string[]; root?: string; perSession?: boolean } = {}): Hit[] {
    const roles = o.roles ?? ["user", "assistant"]
    const ex = o.exclude ?? []
    const order = (t: string) => (o.sort === "newest" ? `${t}.created DESC, ${t}.id DESC` : o.sort === "oldest" ? `${t}.created ASC, ${t}.id ASC` : `${t}.r, ${t}.id`)
    const inner = `SELECT m.session_id, m.id, m.role, m.json, m.created, f.rank AS r FROM messages_fts f JOIN messages m ON m.id = f.rowid
         ${o.root !== undefined ? "JOIN sessions s ON s.id = m.session_id AND s.root = ?" : ""}
         WHERE messages_fts MATCH ? AND m.kind = 'message' AND m.role IN (${roles.map(() => "?").join(",")})
         ${ex.length ? `AND m.session_id NOT IN (${ex.map(() => "?").join(",")})` : ""}`
    const sql = o.perSession
      ? `SELECT session_id, id, role, json, created FROM (SELECT h.*, row_number() OVER (PARTITION BY h.session_id ORDER BY ${order("h")}) AS n FROM (${inner}) h) x WHERE x.n = 1 ORDER BY ${order("x")} LIMIT ?`
      : `SELECT session_id, id, role, json, created FROM (${inner}) h ORDER BY ${order("h")} LIMIT ?`
    return this.db.query(sql).all(...(o.root !== undefined ? [o.root] : []), match, ...roles, ...ex, o.limit ?? 300) as Hit[]
  }

  session(id: string): (SessionRow & { count: number }) | undefined {
    return (this.db.query("SELECT s.*, (SELECT count(*) FROM messages m WHERE m.session_id = s.id AND m.kind = 'message') AS count FROM sessions s WHERE s.id = ?").get(id) ?? undefined) as
      | (SessionRow & { count: number })
      | undefined
  }

  /** Nothing was ever said in it: no rows at all — a turn undone still counts as said,
   *  since /redo could bring it back. */
  isEmpty(sessionId: string): boolean {
    return !this.db.query("SELECT 1 FROM messages WHERE session_id = ? LIMIT 1").get(sessionId)
  }

  /** Visible messages with their ids, in order. */
  rows(sessionId: string): Row[] {
    return this.db.query("SELECT id, role, json, created FROM messages WHERE session_id = ? AND kind = 'message' ORDER BY id").all(sessionId) as Row[]
  }

  search(query: string, limit = 20): { session_id: string; id: number }[] {
    return this.db
      .query(
        "SELECT m.session_id, m.id FROM messages_fts f JOIN messages m ON m.id = f.rowid WHERE messages_fts MATCH ? ORDER BY rank LIMIT ?",
      )
      .all(query, limit) as { session_id: string; id: number }[]
  }
}

/** A compaction summary replayed as a user turn and an acknowledgement (LLeMbas compaction). */
export function summaryTurns(summary: string): Message[] {
  return [
    { role: "user", parts: [{ type: "text", text: `The earlier part of this conversation was compacted. Its summary:\n\n${summary}` }] },
    { role: "assistant", parts: [{ type: "text", text: "Understood — I will carry on from that summary." }] },
  ]
}
