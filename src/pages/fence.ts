// HTML pages in answers (harness spec 3.8.0, harness/pages.md): a complete, self-contained HTML
// document the model writes in a fenced block whose info string begins with `html-view`, followed
// by a short title. The web UI and Desktop show it in a sealed frame; a terminal shows a note in
// its place (and keeps the page as a file, pages/store.ts). A terminal's own model is never
// offered pages — this reads replies that have them: a report, a chat seen over the link. How a
// fence is read, the note and the text projection are pinned by harness/conformance/pages.json.
import { LOOP } from "../harness.ts"
import { fillPrompt } from "../prompt/fill.ts"

const P = LOOP.pages

export const TITLE_MAX = P.title_max

const collapse = (s: string) => s.split(/\s+/).filter(Boolean).join(" ")
const cut = (s: string) => collapse(s).slice(0, TITLE_MAX).trim()

/** A fence's info string as a page's title given on the line ("" when none), or null for any
 *  other code block: the first word is exactly the fence word. */
export function parseInfo(info: string): { title: string } | null {
  const m = /^\s*(\S+)(?:\s+([\s\S]*))?$/.exec(info)
  if (!m || m[1] !== P.fence) return null
  return { title: cut(m[2] ?? "") }
}

/** A page's title: the fence's, else the page's own <title> with its tags stripped, else the
 *  word for a page without one. */
export function titleFor(code: string, given: string): string {
  const own = cut(given)
  if (own) return own
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(code)
  return (m ? cut(m[1]!.replace(/<[^>]*>/g, "")) : "") || P.untitled
}

/** A piece of a reply: markdown as it is, or a page fence — `closed` once its closing fence has
 *  arrived (a fence still streaming is not a page yet). `start` is where the fence begins in the
 *  text, which stays put as the reply grows: a key for what was saved. */
export type Segment = { kind: "text"; text: string } | { kind: "page"; start: number; title: string; code: string; raw: string; closed: boolean }

const OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/
const CLOSE = (fence: string) => new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`)

/** The reply split into markdown and page fences. A fence of any other language is markdown, to
 *  its end. Inside a fence nothing opens another (a fence of the other character or a shorter
 *  one is content), as CommonMark reads them. */
export function splitPages(text: string): Segment[] {
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
    const close = CLOSE(fence)
    let j = i + 1
    while (j < lines.length && !close.test(lines[j]!)) j++
    const closed = j < lines.length
    const page = parseInfo(open[2] ?? "")
    if (!page) {
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
    const code = lines.slice(i + 1, j).join("\n")
    const raw = lines.slice(i, closed ? j + 1 : lines.length).join("\n")
    out.push({ kind: "page", start: offset, title: titleFor(code, page.title), code, raw, closed })
    offset += raw.length + 1
    i = closed ? j : lines.length
  }
  flush()
  return out
}

/** Every finished page of a reply, in order. An unclosed fence is not a page. */
export function pagesOf(text: string): { title: string; html: string }[] {
  return splitPages(text).flatMap((s) => (s.kind === "page" && s.closed ? [{ title: s.title, html: s.code }] : []))
}

/** What a client that cannot render shows in a page's place. */
export const pageNote = (title: string) => fillPrompt(P.note, { title })

/** The reply as text, for anything that reads it as text: every finished page as its one line. */
export function textProjection(text: string): string {
  if (!text.includes(P.fence)) return text
  return splitPages(text)
    .map((s) => (s.kind === "text" ? s.text : s.closed ? fillPrompt(P.projection, { title: s.title }) : s.raw))
    .join("\n")
}

/** Whether the pages block is in a prompt (pages.md §4): the instance's switch, the model's flag
 *  and the chat's switch — a scheduled run has no chat switch — and never for a subagent, the
 *  phone assistant or an agent chat. */
export function pagesOffered(o: { instance?: boolean; model?: boolean; chat?: boolean; where?: string }): boolean {
  if (o.where && (P.never as string[]).includes(o.where)) return false
  if (o.instance !== true || o.model !== true) return false
  return o.where === "scheduled" ? true : o.chat === true
}
