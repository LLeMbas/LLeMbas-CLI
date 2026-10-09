// Turn ids: the web UI's prompt carries its own message id, and a prompt with an id this
// session has already taken does not run twice. That closes the two races of reattaching after a
// dropped link — the instance not knowing whether its prompt arrived, and a terminal's turn matched
// to the wrong row by timing: the instance asks (`_lembas/session/status`) and, when in doubt,
// simply sends the prompt again.
//
// Per session, the last 200 ids, each queued, running or done; a repeat of a queued or running one
// waits for the original and answers what it answers, a repeat of a finished one answers at once.
// The finished ones are kept in one file per session, which the service and a terminal both read
// and write — whichever holds the session — so a turn run in a terminal is not run again by the
// service after the terminal lets go of it, nor the other way round, nor after a restart.

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { paths } from "../config/paths.ts"

export type TurnState = "queued" | "running" | "done"

interface Entry<R> {
  state: TurnState
  result: Promise<R>
}

export const TURNS_KEPT = 200
/** A session's file not written for this long goes, the next time a process opens turn files. */
const TURN_FILE_DAYS = 30

/** Where a session's finished turns are kept: `[id, answer | null]` in order, null for a turn this
 *  side did not answer (one typed in a terminal). */
export interface TurnStore<R> {
  load(): [string, R | null][]
  save(done: [string, R | null][]): void
}

/** The file's entries, those that are entries: a damaged file is an empty one, never a crash. */
function readEntries<R>(file: string): [string, R | null][] {
  try {
    const v = JSON.parse(readFileSync(file, "utf8"))
    if (!Array.isArray(v)) return []
    return v.filter((e): e is [string, R | null] => Array.isArray(e) && e.length === 2 && typeof e[0] === "string" && e[0].length > 0)
  } catch {
    return []
  }
}

/** A JSON file. Written whole to a temporary file and renamed over it, so a reader in the other
 *  process never sees half of one; what that process wrote meanwhile is merged in first. */
export function turnFile<R>(file: string): TurnStore<R> & { drop(): void } {
  return {
    load: () => readEntries<R>(file),
    save(done) {
      try {
        const merged = new Map<string, R | null>(readEntries<R>(file))
        for (const [id, v] of done) {
          // Ours last, so they stay the newest; an answer never replaced by "none known".
          const had = merged.get(id)
          merged.delete(id)
          merged.set(id, v ?? had ?? null)
        }
        const kept = [...merged].slice(-TURNS_KEPT)
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
        const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
        writeFileSync(tmp, JSON.stringify(kept), { mode: 0o600 })
        renameSync(tmp, file)
      } catch {}
    },
    drop() {
      rmSync(file, { force: true })
    },
  }
}

const turnsDir = () => join(paths.state, "turns")
let pruned = false

/** Files of sessions nobody has worked in for a month go (a deleted session's goes at once). */
export function pruneTurnFiles(dir = turnsDir(), maxAgeDays = TURN_FILE_DAYS) {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  const cutoff = Date.now() - maxAgeDays * 86_400_000
  for (const n of names) {
    const f = join(dir, n)
    try {
      if (statSync(f).mtimeMs < cutoff || n.endsWith(".tmp")) rmSync(f, { force: true })
    } catch {}
  }
}

/** The file of one session's turns. */
export function sessionTurnFile<R>(sessionId: string) {
  return turnFile<R>(join(turnsDir(), `${sessionId.replace(/[^\w.-]/g, "_")}.json`))
}

/** One session's turn log, on its file — the one the service and every terminal use. */
export function sessionTurns<R>(sessionId: string): TurnLog<R> {
  if (!pruned) {
    pruned = true
    pruneTurnFiles()
  }
  return new TurnLog<R>(sessionTurnFile<R>(sessionId))
}

export class TurnLog<R = unknown> {
  private entries = new Map<string, Entry<R>>()
  private values = new Map<string, R | null>()
  /** The turn running now, and the last one that finished. */
  running?: string
  last?: string

  constructor(private store?: TurnStore<R>) {
    this.sync()
  }

  /** What the file says now (another process may have written it), for ids not known here. */
  private sync() {
    for (const [id, value] of this.store?.load() ?? []) {
      if (this.entries.has(id)) continue
      this.entries.set(id, { state: "done", result: Promise.resolve(value as R) })
      this.values.set(id, value)
      if (!this.running) this.last = id
    }
  }

  has(id: string): boolean {
    if (!this.entries.has(id)) this.sync()
    return this.entries.has(id)
  }

  state(id: string): TurnState | undefined {
    return this.entries.get(id)?.state
  }

  /** The ids waiting their turn, oldest first. */
  queued(): string[] {
    return [...this.entries].filter(([, e]) => e.state === "queued").map(([id]) => id)
  }

  /** Run `fn` as turn `id` — or, for an id already taken, answer what that turn answers. `fn` gets
   *  `started`, to call when the turn stops waiting and runs. */
  run(id: string, fn: (started: () => void) => Promise<R>): Promise<R> {
    if (!this.entries.has(id)) this.sync()
    const known = this.entries.get(id)
    if (known) return known.result
    const entry: Entry<R> = { state: "queued", result: undefined as unknown as Promise<R> }
    this.entries.set(id, entry)
    this.trim()
    entry.result = fn(() => {
      entry.state = "running"
      this.running = id
    })
      .then((value) => {
        this.values.set(id, value)
        return value
      })
      .finally(() => {
        entry.state = "done"
        if (this.running === id) this.running = undefined
        this.last = id
        this.persist()
      })
    // A failed turn is answered as failed to a repeat too, and is not an unhandled rejection here.
    entry.result.catch(() => {})
    return entry.result
  }

  /** A turn this log did not start (one typed in a terminal), followed by its events. */
  started(id: string) {
    const e = this.entries.get(id)
    if (e) e.state = "running"
    else {
      this.entries.set(id, { state: "running", result: Promise.resolve(undefined as R) })
      this.trim()
    }
    this.running = id
  }

  ended(id: string) {
    const e = this.entries.get(id)
    if (e) e.state = "done"
    if (this.running === id) this.running = undefined
    this.last = id
    this.persist()
  }

  /** The oldest finished ones go first; one still queued or running is never forgotten. */
  private trim() {
    if (this.entries.size <= TURNS_KEPT) return
    for (const [id, e] of this.entries) {
      if (this.entries.size <= TURNS_KEPT) break
      if (e.state === "done") {
        this.entries.delete(id)
        this.values.delete(id)
      }
    }
  }

  /** The finished turns, to the store: with their answers where this side gave one. */
  private persist() {
    if (!this.store) return
    this.store.save([...this.entries].filter(([, e]) => e.state === "done").map(([id]) => [id, this.values.get(id) ?? null]))
  }
}
