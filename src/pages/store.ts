// Where a terminal keeps the HTML pages of the replies it shows (harness pages.md): one file each,
// as written, under the state directory — `pages/<sessionId>/<n>-<slug>.html` — never in the
// project, and only this user may read them (a page is a page: it may say anything). The web UI
// and Desktop show the same fences in a sealed frame; here `/pages` lists them and a browser
// opens the file.
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { paths } from "../config/paths.ts"
import { titleFor } from "./fence.ts"

export interface SavedPage {
  n: number
  name: string
  path: string
}

export const pageDir = (sessionId: string) => join(paths.state, "pages", sessionId.replace(/[^\w.-]/g, "_"))

const FILE = /^(\d+)-(.*)\.html$/

/** A file name's slug from a title: letters and digits, dashes between, at most 48; `page` when
 *  the title has neither. */
export function slugOf(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "")
  return s || "page"
}

/** This session's pages, in the order they were saved. */
export function listPages(sessionId: string): SavedPage[] {
  const dir = pageDir(sessionId)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .map((name) => ({ name, m: FILE.exec(name) }))
    .filter((f): f is { name: string; m: RegExpExecArray } => f.m !== null)
    .map((f) => ({ n: Number(f.m[1]), name: f.name, path: join(dir, f.name) }))
    .sort((a, b) => a.n - b.n)
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex")

/** Save a page the first time it is seen: the fence's code written as it is, mode 0600, as
 *  the next number in the session's directory. The same code seen again (a session reopened,
 *  a reply redrawn) is the file already there. Returns the path. */
export function savePage(sessionId: string, code: string, title: string): string {
  const dir = pageDir(sessionId)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const have = listPages(sessionId)
  const h = hash(code)
  for (const f of have) {
    try {
      if (hash(readFileSync(f.path, "utf8")) === h) return f.path
    } catch {}
  }
  const n = (have.at(-1)?.n ?? 0) + 1
  const path = join(dir, `${n}-${slugOf(titleFor(code, title))}.html`)
  writeFileSync(path, code, { mode: 0o600 })
  return path
}
