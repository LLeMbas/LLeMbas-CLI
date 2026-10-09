// Ported from LLeMbas services/reasoning.py (© Jaroslav Beneš, MIT).
// Splits inline <think>…</think> (and <thinking>, <reasoning>) out of streamed content.
// Tags arrive split across chunks, so this scans as a stream and holds back only
// as much as a partial tag could occupy.

const TAGS: [string, string][] = [
  ["<thinking>", "</thinking>"],
  ["<think>", "</think>"],
  ["<reasoning>", "</reasoning>"],
]

export type Piece = { kind: "reasoning" | "text"; text: string }

export class ThinkSplitter {
  private buf = ""
  private closing = ""

  feed(chunk: string): Piece[] {
    this.buf += chunk
    return this.drain(false)
  }

  flush(): Piece[] {
    return this.drain(true)
  }

  private drain(final: boolean): Piece[] {
    const out: Piece[] = []
    while (this.buf) {
      if (this.closing) {
        const at = this.buf.indexOf(this.closing)
        if (at === -1) {
          const keep = final ? 0 : partialSuffix(this.buf, [this.closing])
          push(out, "reasoning", this.buf.slice(0, this.buf.length - keep))
          this.buf = this.buf.slice(this.buf.length - keep)
          return out
        }
        push(out, "reasoning", this.buf.slice(0, at))
        this.buf = this.buf.slice(at + this.closing.length)
        this.closing = ""
        continue
      }
      let best = -1
      let open = ""
      let close = ""
      for (const [o, c] of TAGS) {
        const i = this.buf.indexOf(o)
        if (i !== -1 && (best === -1 || i < best)) [best, open, close] = [i, o, c]
      }
      if (best === -1) {
        // Unlike the original, hold back only a tail that could really start a tag,
        // so ordinary text is never delayed.
        const keep = final ? 0 : partialSuffix(this.buf, TAGS.map((t) => t[0]))
        push(out, "text", this.buf.slice(0, this.buf.length - keep))
        this.buf = this.buf.slice(this.buf.length - keep)
        return out
      }
      push(out, "text", this.buf.slice(0, best))
      this.buf = this.buf.slice(best + open.length)
      this.closing = close
    }
    return out
  }
}

function push(out: Piece[], kind: Piece["kind"], text: string) {
  if (!text) return
  const last = out[out.length - 1]
  if (last && last.kind === kind) last.text += text
  else out.push({ kind, text })
}

/** Length of the longest suffix of `s` that is a proper prefix of one of `tags`. */
function partialSuffix(s: string, tags: string[]): number {
  let best = 0
  for (const tag of tags) {
    for (let n = Math.min(tag.length - 1, s.length); n > best; n--) {
      if (s.endsWith(tag.slice(0, n))) {
        best = n
        break
      }
    }
  }
  return best
}
