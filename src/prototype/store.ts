// Where a terminal keeps the prototypes a session's model wrote: one file each, the model's
// output as it is, under the state directory — `prototypes/<sessionId>/<n>-<slug>.html` — never in
// the project, and only this user may read them (a page is a page: it may say anything). The web
// UI renders the same fences live; here `/prototype` lists them and a browser opens the file.
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { paths } from "../config/paths.ts"
import { titleFor, type PrototypeKind } from "./fence.ts"

export interface SavedPrototype {
  n: number
  name: string
  path: string
}

export const prototypeDir = (sessionId: string) => join(paths.state, "prototypes", sessionId.replace(/[^\w.-]/g, "_"))

const FILE = /^(\d+)-(.*)\.html$/

/** A file name's slug from a title: letters and digits, dashes between, at most 48; the kind
 *  when the title says nothing. */
export function slugOf(title: string, kind: PrototypeKind): string {
  const s = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "")
  return s || kind
}

/** This session's prototypes, in the order they were saved. */
export function listPrototypes(sessionId: string): SavedPrototype[] {
  const dir = prototypeDir(sessionId)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .map((name) => ({ name, m: FILE.exec(name) }))
    .filter((f): f is { name: string; m: RegExpExecArray } => f.m !== null)
    .map((f) => ({ n: Number(f.m[1]), name: f.name, path: join(dir, f.name) }))
    .sort((a, b) => a.n - b.n)
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex")

/** Save a prototype the first time it is seen: the fence's code written as it is, mode 0600, as
 *  the next number in the session's directory. The same code seen again (a session reopened,
 *  a reply redrawn) is the file already there. Returns the path. */
export function savePrototype(sessionId: string, code: string, o: { kind: PrototypeKind; title: string }): string {
  const dir = prototypeDir(sessionId)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const have = listPrototypes(sessionId)
  const h = hash(code)
  for (const f of have) {
    try {
      if (hash(readFileSync(f.path, "utf8")) === h) return f.path
    } catch {}
  }
  const n = (have.at(-1)?.n ?? 0) + 1
  const path = join(dir, `${n}-${slugOf(titleFor(code, o.title), o.kind)}.html`)
  writeFileSync(path, code, { mode: 0o600 })
  return path
}
