// Settings the TUI remembers (/personality, /theme) go into the global config.yaml, keeping the
// comments and layout of whatever the user wrote there.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseDocument } from "yaml"
import { paths } from "./paths.ts"

export function setGlobalConfig(path: string[], value: unknown) {
  const file = join(paths.config, "config.yaml")
  mkdirSync(paths.config, { recursive: true })
  const doc = parseDocument(existsSync(file) ? readFileSync(file, "utf8") : "")
  if (!doc.contents) doc.contents = doc.createNode({}) as never
  doc.setIn(path, value)
  writeFileSync(file, doc.toString())
}
