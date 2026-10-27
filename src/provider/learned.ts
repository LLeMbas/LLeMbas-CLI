import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { Effort } from "../config/schema.ts"
import { paths } from "../config/paths.ts"

// What endpoints have taught us, kept across runs in ~/.local/state/lembas/learned.json.
// Only ever narrows behaviour; deleting the file is always safe.
interface Learned {
  /** A model ref → the efforts it actually accepts. */
  efforts: Record<string, Effort[]>
  /** base URLs that reject `stream_options`. */
  noStreamOptions: string[]
  /** base URLs that reject `return_progress`. */
  noProgress: string[]
}

let cache: Learned | undefined

function file() {
  return join(paths.state, "learned.json")
}

export function learned(): Learned {
  if (cache) return cache
  try {
    // An older file's `contexts` (what discovery found, before 2.0 took the server's word) is dropped.
    const { contexts: _, ...kept } = JSON.parse(readFileSync(file(), "utf8")) as Record<string, unknown>
    cache = { efforts: {}, noStreamOptions: [], noProgress: [], ...kept } as Learned
  } catch {
    cache = { efforts: {}, noStreamOptions: [], noProgress: [] }
  }
  return cache!
}

function save() {
  try {
    mkdirSync(dirname(file()), { recursive: true })
    writeFileSync(file(), JSON.stringify(learned(), null, 2))
  } catch {
    // bookkeeping must never fail a reply
  }
}

export function learnEfforts(ref: string, efforts: Effort[]) {
  learned().efforts[ref] = efforts
  save()
}

export function learnNoStreamOptions(baseUrl: string) {
  const l = learned()
  if (!l.noStreamOptions.includes(baseUrl)) l.noStreamOptions.push(baseUrl)
  save()
}

export function learnNoProgress(baseUrl: string) {
  const l = learned()
  if (!l.noProgress.includes(baseUrl)) l.noProgress.push(baseUrl)
  save()
}

/** Tests only. */
export function resetLearned() {
  cache = undefined
}
