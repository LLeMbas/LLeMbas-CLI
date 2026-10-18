// A prototype (harness/prompts/blocks/prototypes.md, shared with LLeMbas: services/prototypes.py):
// a complete HTML page the model writes in a fenced block whose language is `prototype-chat` or
// `prototype-page`, with a short title on the same line. The web UI renders it live; a terminal
// saves it as a file (prototype/store.ts) and draws one line in its place. How the fence's info
// string is read, and where the title comes from, is pinned by harness/conformance/prototype.json.

export type PrototypeKind = "chat" | "page"

export interface PrototypeInfo {
  kind: PrototypeKind
  /** The title given on the fence line, "" when none was. */
  title: string
}

/** The languages that make a fence a prototype; bare `prototype` is the inline kind. */
const KINDS: Record<string, PrototypeKind> = { "prototype-chat": "chat", "prototype-page": "page", prototype: "chat" }

export const TITLE_MAX = 80

const collapse = (s: string) => s.split(/\s+/).filter(Boolean).join(" ")
const cut = (s: string) => collapse(s).slice(0, TITLE_MAX).trim()

/** A fence's info string as a prototype, or null for any other code block. The first word
 *  (whatever its case) is the language; the rest of the line is the title. */
export function parseInfo(info: string): PrototypeInfo | null {
  const m = /^\s*(\S+)(?:\s+([\s\S]*))?$/.exec(info)
  if (!m) return null
  const kind = KINDS[m[1]!.toLowerCase()]
  if (!kind) return null
  return { kind, title: cut(m[2] ?? "") }
}

/** The prototype's title: the fence's, else the page's own <title> with its tags stripped,
 *  whitespace collapsed, at most TITLE_MAX characters; "" when neither says. */
export function titleFor(code: string, given: string): string {
  const own = cut(given)
  if (own) return own
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(code)
  return m ? cut(m[1]!.replace(/<[^>]*>/g, "")) : ""
}

/** A piece of a reply: markdown as it is, or a prototype fence — `closed` once its closing fence
 *  has arrived (a fence still streaming is drawn as the code block it is so far). `start` is where
 *  the fence begins in the text, which stays put as the reply grows: a key for what was saved. */
export type Segment = { kind: "text"; text: string } | { kind: "prototype"; start: number; info: PrototypeInfo; code: string; raw: string; closed: boolean }

const OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/
const CLOSE = (fence: string) => new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`)

/** The reply split into markdown and prototype fences. A fence of any other language is markdown.
 *  Inside a fence nothing opens another (a fence of the other character or a longer one is
 *  content), as CommonMark reads them. */
export function splitPrototypes(text: string): Segment[] {
  const out: Segment[] = []
  const lines = text.split("\n")
  let plain: string[] = []
  let offset = 0
  const flush = () => {
    if (plain.length) out.push({ kind: "text", text: plain.join("\n") })
    plain = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const open = OPEN.exec(line)
    if (!open) {
      plain.push(line)
      offset += line.length + 1
      continue
    }
    const fence = open[1]!
    const info = open[2] ?? ""
    const close = CLOSE(fence)
    let j = i + 1
    while (j < lines.length && !close.test(lines[j]!)) j++
    const closed = j < lines.length
    const proto = parseInfo(info)
    const body = lines.slice(i + 1, j)
    if (!proto) {
      // Some other code block: text, up to its end (or the end of the reply while it streams).
      const until = closed ? j : lines.length - 1
      for (let k = i; k <= until; k++) {
        plain.push(lines[k]!)
        offset += lines[k]!.length + 1
      }
      i = until
      continue
    }
    flush()
    const raw = lines.slice(i, closed ? j + 1 : lines.length).join("\n")
    out.push({ kind: "prototype", start: offset, info: proto, code: body.join("\n"), raw, closed })
    offset += raw.length + 1
    i = closed ? j : lines.length
  }
  flush()
  return out
}
