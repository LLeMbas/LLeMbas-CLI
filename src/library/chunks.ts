// Text in pieces for searching, after LLeMbas services/library/chunks.py (© Jaroslav Beneš,
// MIT): about `size` characters each, overlapping by `overlap`, cut where the text
// breaks — a paragraph, else a line, else a sentence — looked for only in the last third of the
// window, so a piece is never much shorter than asked. Pieces under 40 characters are dropped.

export const CHUNK_CHARS = 1200
export const CHUNK_OVERLAP = 150
const MIN_CHUNK = 40
const MIN_SIZE = 200

export function split(text: string, size = CHUNK_CHARS, overlap = CHUNK_OVERLAP): string[] {
  const t = text.replace(/\r\n/g, "\n").trim()
  if (!t) return []
  // The harness spec's rule (conformance/chunk.json), LLeMbas's: a size under 200 is raised to it,
  // and the overlap is at most half the size — at or past it, every piece would start where the
  // last one did and the loop would never advance.
  size = Math.max(MIN_SIZE, Math.floor(size))
  overlap = Math.max(0, Math.min(Math.floor(overlap), Math.floor(size / 2)))
  // A short text is one piece, however short: it is still somebody's document.
  if (t.length <= size) return [t]
  const out: string[] = []
  let start = 0
  while (start < t.length) {
    let end = Math.min(start + size, t.length)
    if (end < t.length) end = boundary(t, start, end)
    const piece = t.slice(start, end).trim()
    if (piece.length >= MIN_CHUNK) out.push(piece)
    if (end >= t.length) break
    start = Math.max(end - overlap, start + 1)
  }
  return out
}

/** Where to cut: just after a paragraph break, else a line break, else a sentence's ". ", searched
 *  backwards and only in the window's last third — a break near the start would make a piece a
 *  fraction of the size. */
function boundary(t: string, start: number, end: number): number {
  const floor = start + Math.floor(((end - start) * 2) / 3)
  for (const marker of ["\n\n", "\n", ". "]) {
    const found = t.lastIndexOf(marker, end - marker.length)
    if (found > floor) return found + marker.length
  }
  return end
}
