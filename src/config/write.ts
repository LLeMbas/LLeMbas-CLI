// Settings the TUI remembers (/personality, /theme) and `lembas remote` go into the global
// config.yaml, keeping the comments and layout of whatever the user wrote there.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseDocument } from "yaml"
import { paths } from "./paths.ts"

export function setGlobalConfig(path: string[], value: unknown) {
  updateGlobalConfig([[path, value]])
}

/** Several values at once, in one write: a reader (a running service) never sees half of them.
 *  Written in place, not renamed over: a config.yaml that is a link into a dotfiles repository
 *  stays one, and keeps its mode. A reader that catches it half written keeps what it read last. */
export function updateGlobalConfig(edits: [string[], unknown][]) {
  const file = join(paths.config, "config.yaml")
  mkdirSync(paths.config, { recursive: true })
  const doc = parseDocument(existsSync(file) ? readFileSync(file, "utf8") : "")
  if (!doc.contents) doc.contents = doc.createNode({}) as never
  for (const [path, value] of edits) doc.setIn(path, value)
  writeFileSync(file, doc.toString())
}
