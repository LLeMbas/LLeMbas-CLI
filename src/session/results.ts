// Context hygiene (harness spec 3.0.0, harness/context.md; texts and numbers in loop.json `context`;
// conformance `context`): what a tool result becomes when it is inserted into the conversation.
// Every result gets an id; a read says its lines and its content's hash; an unchanged re-read inside
// an earlier read, and a listing or search repeated with the same result, are stubs pointing at the
// full result; large output keeps its head and tail; edits answer with their diff; `recall` shows any
// stored result again; compaction adds a table of the reads.
//
// The one rule: every measure acts when a result is inserted, and nothing already sent is ever
// rewritten — changing earlier context throws the prompt cache away from that point. A stub only
// ever points at a result in the request being built (`present`): after a compaction, an /undo or
// a rewind, the result it would point at is gone, so the read is answered in full.
import { createHash } from "node:crypto"
import { structuredPatch } from "diff"
import { LOOP } from "../harness.ts"

export const CONTEXT = LOOP.context

export type Cap = typeof CONTEXT.cap

/** One result as the session keeps it: everything needed to answer `recall`, and to decide a
 *  later stub. `text` is the full result (before any cap; for a stub, the text it stands for). */
export interface StoredResult {
  id: string
  kind: "read" | "edit" | "output" | "recall"
  /** Not a stub: a stub never becomes the target of another. */
  full: boolean
  tool?: string
  /** read: the path as the call gave it, and what identifies the file (its absolute path). */
  path?: string
  key?: string
  /** read: the full SHA-256 of the file's content, and the lines shown. */
  sha?: string
  from?: number
  to?: number
  of?: number
  /** output: the call's tool and arguments (JSON, keys sorted), and the hash of the result. */
  args?: string
  textSha?: string
  text: string
}

/** Where a session's results are kept: the session store, or memory without one. */
export interface ResultStore {
  /** How many ids this session has given: the next is one more. */
  count(): number
  save(r: StoredResult): void
  get(id: string): StoredResult | undefined
  /** Every result's fields, oldest first (the text may be left out). */
  all(): StoredResult[]
}

export function memoryResults(): ResultStore {
  const rows: StoredResult[] = []
  return {
    count: () => rows.length,
    save: (r) => void rows.push(r),
    get: (id) => rows.find((r) => r.id === id),
    all: () => rows,
  }
}

/** What a tool's result is, for its insertion (ToolResult.context, filled in by the tool). */
export type Insert =
  /** A file read: `body` the read tool's lines (and its note when lines remain). */
  | { kind: "read"; path: string; key: string; sha: string; from: number; to: number; of: number; body: string }
  /** One or more files changed: each with its new content's hash, and its hunks, or the number of
   *  lines of a file created, or deleted. `note` follows the diff (something the tool adds). */
  | { kind: "edit"; files: EditedFile[]; note?: string }
  /** Anything else: `args` as the tool got them. */
  | { kind: "output"; tool: string; args: unknown; text: string; error?: boolean }
  | { kind: "recall"; target: string; offset?: number; limit?: number }

/** What a tool hands over in its result (ToolResult.context): a read without its body, which is the
 *  result's output. */
export type ToolInsert = Exclude<Insert, { kind: "read" }> | Omit<Extract<Insert, { kind: "read" }>, "body">

export type EditedFile = { path: string; sha: string; hunks: string } | { path: string; sha: string; created: number } | { path: string; deleted: true }

export const sha256 = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex")

/** `{{name}}` filled from `vars` (loop.json's texts, which have no bullets to drop). */
const fill = (text: string, vars: Record<string, string | number>) => text.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))
const short = (sha: string) => sha.slice(0, CONTEXT.sha_digits)

/** JSON with every object's keys sorted: how two calls' arguments are compared. */
export function stableJson(v: unknown): string {
  const norm = (x: unknown): unknown =>
    Array.isArray(x) ? x.map(norm) : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, norm((x as Record<string, unknown>)[k])])) : x
  return JSON.stringify(norm(v ?? {}))
}

/** The unified diff of a change, hunks only (the path is in the bracket), three lines of context. */
export function hunks(before: string, after: string): string {
  const p = structuredPatch("a", "b", before, after, "", "", { context: 3 })
  return p.hunks.map((h) => [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines].join("\n")).join("\n")
}

/** How many lines a new file has, as the model wrote it (a final newline ends the last line). */
export function lineCount(text: string): number {
  if (!text) return 0
  const n = text.split("\n").length
  return text.endsWith("\n") ? n - 1 : n
}

/** A result over the cap's lines or characters: its head and its tail, with the elided line between
 *  (loop.json `cap`). The first line alone longer than the head is cut and marked. */
export function capOutput(text: string, id: string, cap: Cap = CONTEXT.cap): string {
  const lines = text.split("\n")
  if (lines.length <= cap.max_lines && text.length <= cap.max_chars) return text
  const head: string[] = []
  let chars = 0
  for (const l of lines) {
    if (head.length >= cap.head_lines) break
    const add = (head.length ? 1 : 0) + l.length
    if (chars + add > cap.head_chars) break
    head.push(l)
    chars += add
  }
  let used = head.length
  if (!head.length && lines.length) {
    head.push(`${lines[0]!.slice(0, cap.head_chars)} […cut]`)
    used = 1
  }
  const tail: string[] = []
  chars = 0
  for (let i = lines.length - 1; i >= used; i--) {
    if (tail.length >= cap.tail_lines) break
    const l = lines[i]!
    const add = (tail.length ? 1 : 0) + l.length
    if (chars + add > cap.tail_chars) break
    tail.unshift(l)
    chars += add
  }
  const elided = lines.length - used - tail.length
  return [...head, fill(CONTEXT.elided, { n: elided, id }), ...tail].join("\n")
}

/** A session's results: the ids it gives, what it keeps, and what each insertion says. */
export class ResultContext {
  constructor(
    private store: ResultStore,
    /** The ids of the results still in the conversation (a stub may point only at one of them). */
    private present: () => Set<string>,
    private cap: Cap = CONTEXT.cap,
  ) {}

  /** The next id: `#` and lowercase hex, at least ids.digits digits, never reused in the session. */
  nextId(): string {
    return `#${(this.store.count() + 1).toString(16).padStart(CONTEXT.ids.digits, "0")}`
  }

  /** The text the model is given for one result, which is stored in full. `id`: one given from
   *  outside (the conformance cases name theirs); otherwise the next. */
  insert(e: Insert, id = this.nextId()): string {
    if (e.kind === "read") return this.read(id, e)
    if (e.kind === "edit") return this.edit(id, e)
    if (e.kind === "recall") return this.recall(id, e)
    return this.output(id, e)
  }

  private read(id: string, e: Extract<Insert, { kind: "read" }>): string {
    const head = e.of === 0 ? fill(CONTEXT.read_header_empty, { id, path: e.path, sha: short(e.sha) }) : fill(CONTEXT.read_header, { id, path: e.path, from: e.from, to: e.to, of: e.of, sha: short(e.sha) })
    const base: StoredResult = { id, kind: "read", tool: "read", path: e.path, key: e.key, sha: e.sha, from: e.from, to: e.to, of: e.of, full: true, text: e.body }
    // By hash: an earlier full read of this file, unchanged, whose lines hold these — the newest.
    const earlier = e.of > 0 && CONTEXT.dedupe.by_hash.includes("read") ? this.table().filter((r) => r.kind === "read" && r.key === e.key && r.sha === e.sha && r.from! <= e.from && e.to <= r.to!).pop() : undefined
    if (earlier) {
      this.store.save({ ...base, full: false })
      return `${head} ${fill(CONTEXT.unchanged, { earlier: earlier.id, from: earlier.from!, to: earlier.to! })}`
    }
    this.store.save(base)
    return `${head}\n${e.body}`
  }

  private edit(id: string, e: Extract<Insert, { kind: "edit" }>): string {
    const one = (f: EditedFile): { bracket: string; body: string } =>
      "deleted" in f ? { bracket: `${f.path} deleted`, body: "" } : { bracket: `${f.path} sha ${short(f.sha)}`, body: "created" in f ? fill(CONTEXT.created, { n: f.created }) : f.hunks }
    let text: string
    if (e.files.length === 1) {
      const { bracket, body } = one(e.files[0]!)
      text = `[${id} ${bracket}]${body ? ("created" in e.files[0]! ? " " : "\n") + body : ""}`
    } else {
      // Several files (apply_patch): the id alone, then each file's bracket and its change.
      text = [`[${id}]`, ...e.files.map((f) => {
        const { bracket, body } = one(f)
        return `[${bracket}]${body ? ("created" in f ? " " : "\n") + body : ""}`
      })].join("\n")
    }
    if (e.note) text += e.note
    this.store.save({ id, kind: "edit", full: true, text: text.slice(text.indexOf("]") + 1).replace(/^[ \n]/, "") })
    // The diff is capped like any output, the bracket kept.
    const nl = text.indexOf("\n")
    return nl < 0 ? text : `${text.slice(0, nl)}\n${capOutput(text.slice(nl + 1), id, this.cap)}`
  }

  private output(id: string, e: Extract<Insert, { kind: "output" }>): string {
    const args = stableJson(e.args)
    const textSha = sha256(e.text)
    const base: StoredResult = { id, kind: "output", tool: e.tool, args, textSha, full: true, text: e.text }
    // By result: the same call, still in the table, whose result was this same text.
    const dedupe = !e.error && CONTEXT.dedupe.by_result.includes(e.tool)
    const earlier = dedupe ? this.table().filter((r) => r.kind === "output" && r.tool === e.tool && r.args === args).pop() : undefined
    if (earlier && earlier.textSha === textSha) {
      this.store.save({ ...base, full: false })
      return `${fill(CONTEXT.header, { id })} ${fill(CONTEXT.same_result, { earlier: earlier.id })}`
    }
    this.store.save(base)
    return `${fill(CONTEXT.header, { id })}\n${capOutput(e.text, id, this.cap)}`
  }

  private recall(id: string, e: Extract<Insert, { kind: "recall" }>): string {
    const raw = e.target.trim().toLowerCase()
    const target = raw.startsWith("#") ? raw : `#${raw}`
    const found = this.store.get(target)
    if (!found) {
      const text = fill(CONTEXT.no_result, { target })
      this.store.save({ id, kind: "recall", full: true, text })
      return `${fill(CONTEXT.header, { id })} ${text}`
    }
    const lines = found.text.split("\n")
    const from = Math.max(1, e.offset ?? 1)
    const to = Math.min(lines.length, from + (e.limit ?? 2000) - 1)
    const shown = lines.slice(from - 1, to).join("\n")
    this.store.save({ id, kind: "recall", full: true, text: shown })
    return `${fill(CONTEXT.recall_header, { id, target, from, to, of: lines.length })}\n${shown}`
  }

  /** The dedupe table: the full results in the request being built, oldest first. A stub names
   *  only one of them (context.md §2). */
  private table(): StoredResult[] {
    const here = this.present()
    return this.store.all().filter((r) => r.full && here.has(r.id))
  }

  /** The table compaction adds after its summary (context.md §7): of the full reads the summary
   *  covers — made since the previous compaction, in turns still in the history — the newest of
   *  each file, newest last, at most compaction.rows; "" with none. `reads` defaults to the dedupe
   *  table: the CLI resends every result, so the results in the conversation are exactly those
   *  (an /undo or a rewind took its reads with it). After it the conversation is the summary alone,
   *  so nothing is present and the dedupe table is empty by construction. */
  compactionTable(reads: StoredResult[] = this.table()): string {
    const newest = new Map<string, StoredResult>()
    for (const r of reads) if (r.kind === "read" && r.full && r.of! > 0) newest.delete(r.key!), newest.set(r.key!, r)
    const rows = [...newest.values()].slice(-CONTEXT.compaction.rows)
    if (!rows.length) return ""
    return [
      CONTEXT.compaction.heading,
      "",
      CONTEXT.compaction.line,
      "",
      "| Path | Lines | sha | Result |",
      "|---|---|---|---|",
      ...rows.map((r) => `| ${r.path} | ${r.from}-${r.to} of ${r.of} | ${short(r.sha!)} | ${r.id} |`),
    ].join("\n")
  }
}

/** The ids at the head of the tool results in a conversation: what is present for a stub. */
export function presentIds(messages: readonly { role: string; content?: unknown }[]): Set<string> {
  const out = new Set<string>()
  for (const m of messages) {
    if (m.role !== "tool" || typeof m.content !== "string") continue
    const hit = /^\[(#[0-9a-f]+)[\] ]/.exec(m.content)
    if (hit) out.add(hit[1]!)
  }
  return out
}
