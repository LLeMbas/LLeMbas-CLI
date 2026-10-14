// Deletes the instance has not heard about yet.
//
// A session deleted on this machine is deleted in the web UI too: the terminal tells the hub
// (`hub/deleted`), and the hub tells the instance (`_lembas/session/deleted`) over the link. Any of
// those steps may find the next one missing — a terminal with no hub (no service, no /remote), a
// hub with no link up (the instance down, the network out), `lembas sessions delete` with neither
// — and the chat would stay in the web UI, pointing at a session that no longer exists. So whoever
// cannot pass the word on writes it here, and the service sends everything here once the next
// link has initialized, then clears it.
//
// A plain JSON list of session ids in the state directory, beside the hub's socket. Written whole
// through a rename, so a reader never sees half of it; deduplicated; the newest DELETED_MAX kept —
// a machine whose link never comes back must not grow it for ever, and a chat that old is long
// out of anybody's mind.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { isLocal, paths } from "../config/paths.ts"

export const DELETED_MAX = 500

export const deletedFile = () => join(paths.state, "deleted.json")

/** The session ids waiting to be told to the instance, oldest first. */
export function pendingDeleted(): string[] {
  try {
    const v = JSON.parse(readFileSync(deletedFile(), "utf8"))
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : []
  } catch {
    return []
  }
}

function write(ids: string[]) {
  const file = deletedFile()
  if (!ids.length) return void rmSync(file, { force: true })
  mkdirSync(paths.state, { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(ids), { mode: 0o600 })
  renameSync(tmp, file)
}

/** Remember deletes to tell the instance later. Never in the way of the delete itself: a state
 *  directory that cannot be written to only loses the word. */
export function addPendingDeleted(ids: string[]) {
  const add = ids.filter(Boolean)
  // Local mode tells the instance nothing, now or later.
  if (!add.length || isLocal()) return
  try {
    // An id already waiting moves to the end: it is the newest word about it.
    const list = [...pendingDeleted().filter((x) => !add.includes(x)), ...new Set(add)]
    write(list.slice(-DELETED_MAX))
  } catch {}
}

/** Forget the ones that were told. Re-read first, so an id another process added meanwhile (a
 *  terminal, `lembas sessions delete`) is kept for the next link. */
export function clearPendingDeleted(sent: string[]) {
  if (!sent.length || !existsSync(deletedFile())) return
  try {
    write(pendingDeleted().filter((x) => !sent.includes(x)))
  } catch {}
}
