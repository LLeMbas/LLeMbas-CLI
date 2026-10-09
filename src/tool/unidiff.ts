// Applying a unified diff — the second format apply_patch takes (harness spec v1), beside the
// "*** Begin Patch" envelope. Ported from LLeMbas services/agent/patch.py (© Jaroslav Beneš,
// MIT), where it is file_edit. Four behaviours carry it, each because of how models
// actually write patches rather than how the format is specified:
//
// - Fuzzy offset, exact content. `@@ -41,7 +41,8 @@` is a hint: the hinted position is tried
//   first, then the file is scanned outward (MAX_DRIFT) for an exact match of the context. One
//   match wins; more than one refuses — guessing between identical blocks silently corrupts a file.
// - Line endings are normalised in and restored out, or a CRLF file fails on every hunk.
// - A blank context line may have lost its leading space (trailing whitespace gets stripped).
// - Nothing is written unless every hunk applies; the caller writes the whole result or nothing.

export const MAX_HUNKS = 60
export const MAX_DRIFT = 200
const MISMATCH_WINDOW = 3
const HEADER = /^@@\s*-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s*@@/
const NO_NEWLINE = "\\ No newline at end of file"

export class UnidiffError extends Error {}

export interface UniHunk {
  oldStart: number
  oldCount: number
  lines: string[]
  /** `\ No newline at end of file` after a line this hunk adds: the result ends without one. */
  endsWithoutNewline: boolean
}

/** One file's part of a unified diff. `path` is the +++ side (the --- side for a deletion); absent
 *  when the diff carries no file headers, and then the call's `path` names the file. */
export interface UniFile {
  path?: string
  create: boolean
  remove: boolean
  hunks: UniHunk[]
}

const before = (h: UniHunk) => h.lines.filter((l) => l[0] === " " || l[0] === "-").map((l) => l.slice(1))
const after = (h: UniHunk) => h.lines.filter((l) => l[0] === " " || l[0] === "+").map((l) => l.slice(1))

/** A unified diff looks like one: a hunk header somewhere in it. */
export function isUnified(text: string): boolean {
  return /^@@\s*-\d+/m.test(text) && !/^\*\*\* Begin Patch/m.test(text)
}

function headerPath(raw: string): string | undefined {
  // `--- a/src/x.ts\t2026-…` → src/x.ts; /dev/null → undefined.
  const p = raw.slice(4).split("\t")[0]!.trim()
  if (p === "/dev/null") return undefined
  return p.replace(/^[ab]\//, "")
}

/** Read a unified diff into files and hunks. `diff --git` and `index` lines are tolerated and
 *  ignored; `---`/`+++` name the file when present. The `@@` header is required. */
export function parseUnified(patch: string): UniFile[] {
  const files: UniFile[] = []
  let file: UniFile | undefined
  let hunk: UniHunk | undefined
  const body = patch.replace(/\r\n?/g, "\n").split("\n")
  // The patch's own final newline is not a blank context line.
  if (body.at(-1) === "") body.pop()
  const flush = () => {
    if (hunk && file) file.hunks.push(hunk)
    hunk = undefined
  }
  for (let i = 0; i < body.length; i++) {
    const raw = body[i]!
    // A file header is the pair `--- a/x` / `+++ b/x`; a lone `--- …` inside a hunk is a removal.
    if (raw.startsWith("--- ") && body[i + 1]?.startsWith("+++ ")) {
      flush()
      const minus = headerPath(raw)
      const plus = headerPath(body[++i]!)
      file = { path: plus ?? minus, create: minus === undefined, remove: plus === undefined, hunks: [] }
      files.push(file)
      continue
    }
    const m = HEADER.exec(raw)
    if (m) {
      flush()
      if (!file) files.push((file = { create: false, remove: false, hunks: [] }))
      hunk = { oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]), lines: [], endsWithoutNewline: false }
      continue
    }
    if (!hunk) continue // preamble: diff --git, index, anything before the first @@
    if (raw.startsWith(NO_NEWLINE)) {
      // Only the new side is an instruction; the old side describes the file, which is read anyway.
      const last = hunk.lines.at(-1)
      if (last && (last[0] === "+" || last[0] === " ")) hunk.endsWithoutNewline = true
      continue
    }
    if (raw[0] === "+" || raw[0] === "-" || raw[0] === " ") hunk.lines.push(raw)
    else if (raw === "") hunk.lines.push(" ")
    else flush() // a stray line ends the hunk rather than corrupting it
  }
  flush()
  const hunks = files.reduce((n, f) => n + f.hunks.length, 0)
  if (!hunks)
    throw new UnidiffError("That patch has no hunks. A unified diff needs at least one `@@ -old,count +new,count @@` header, followed by the lines: ' ' for context, '-' to remove, '+' to add.")
  if (hunks > MAX_HUNKS) throw new UnidiffError(`That patch has ${hunks} hunks, and ${MAX_HUNKS} is the most applied at once. Rewrite the file with write instead, or send the change in pieces.`)
  return files
}

function find(lines: string[], wanted: string[], hint: number, floor: number): number {
  if (!wanted.length) return Math.max(floor, Math.min(hint, lines.length))
  const span = wanted.length
  const at = (i: number) => wanted.every((w, k) => lines[i + k] === w)
  if (hint >= floor && hint + span <= lines.length && at(hint)) return hint
  const matches: number[] = []
  for (let i = Math.max(floor, hint - MAX_DRIFT); i <= Math.min(lines.length - span, hint + MAX_DRIFT); i++) if (at(i)) matches.push(i)
  if (matches.length === 1) return matches[0]!
  if (matches.length > 1)
    throw new UnidiffError(
      `Those context lines appear ${matches.length} times in the file, and the line numbers in the hunk header do not point at any of them, so there is no way to tell which was meant. Include more unchanged lines around the change.`,
    )
  throw new UnidiffError("")
}

function around(lines: string[], hint: number): string {
  if (!lines.length) return "      (the file is empty)"
  const pad = (n: number) => String(n + 1).padStart(5)
  if (hint >= lines.length) {
    const start = Math.max(0, lines.length - MISMATCH_WINDOW)
    const shown = []
    for (let n = start; n < lines.length; n++) shown.push(`  ${pad(n)}  ${lines[n]}`)
    return [...shown, `      (the file ends at line ${lines.length})`].join("\n")
  }
  const shown = []
  for (let n = Math.max(0, hint - MISMATCH_WINDOW); n < Math.min(lines.length, hint + MISMATCH_WINDOW + 1); n++) shown.push(`${n === hint ? "->" : "  "} ${pad(n)}  ${lines[n]}`)
  return shown.join("\n")
}

/** The file with every hunk applied, or an UnidiffError naming the first that would not. Hunks
 *  apply in order against a cursor, so a duplicated hunk cannot apply the same change twice. */
export function applyUnified(text: string, hunks: UniHunk[]): string {
  const crlf = text.includes("\r\n")
  const lines = text.replace(/\r\n?/g, "\n").split("\n")
  const trailing = lines.at(-1) === ""
  if (trailing) lines.pop()
  const out: string[] = []
  let cursor = 0
  let reachedEnd = false
  hunks.forEach((h, i) => {
    const wanted = before(h)
    // A pure insertion names the line it goes after, not the line it replaces.
    const hint = h.oldCount === 0 ? h.oldStart : Math.max(h.oldStart - 1, 0)
    let at: number
    try {
      at = find(lines, wanted, hint, cursor)
    } catch (e) {
      const why = (e as Error).message
      if (why) throw new UnidiffError(`Hunk ${i + 1} did not apply. ${why} Nothing was written.`)
      const expected = h.lines.find((l) => l[0] === " " || l[0] === "-")?.slice(1) ?? ""
      throw new UnidiffError(
        `Hunk ${i + 1} did not apply. It expects line ${hint + 1} to be\n      ${expected}\nbut the file has\n${around(lines, hint)}\nand those lines are nowhere else nearby either. Nothing was written. Send a patch whose context matches what is printed above.`,
      )
    }
    out.push(...lines.slice(cursor, at), ...after(h))
    cursor = at + wanted.length
    reachedEnd = h.endsWithoutNewline && cursor >= lines.length
  })
  out.push(...lines.slice(cursor))
  let result = out.join("\n")
  if (trailing && !reachedEnd) result += "\n"
  return crlf ? result.replace(/\n/g, "\r\n") : result
}
