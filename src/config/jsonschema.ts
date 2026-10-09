// JSON Schemas for config.yaml and connections.yaml, made from the zod schemas — so an editor with
// a YAML language server (VS Code's YAML extension, Neovim's yamlls, Helix, Zed) completes keys,
// shows what each one does and marks mistakes as you type. `lembas config schema` writes them
// next to the config; schema/ in the repository holds the same files, for a project's .agent/config.yaml.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { paths } from "./paths.ts"
import { Config, ConnectionsFile } from "./schema.ts"

/** `{env:X}` and `{file:path}` can stand in for any string, so no string may be held to a
 *  format (a base_url of "{env:LLM_URL}" is not a URI until it is filled in). */
function loosen(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(loosen)
  if (!node || typeof node !== "object") return node
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node)) if (k !== "format") out[k] = loosen(v)
  return out
}

export const SCHEMA_FILES = { config: "config.schema.json", connections: "connections.schema.json" } as const

// draft-07: the version every YAML language server reads.
export function jsonSchemas(): Record<keyof typeof SCHEMA_FILES, Record<string, unknown>> {
  const make = (schema: z.ZodType, title: string, description: string) => ({
    ...(loosen(z.toJSONSchema(schema, { io: "input", unrepresentable: "any", target: "draft-7" })) as Record<string, unknown>),
    title,
    description,
  })
  return {
    config: make(Config, "LLeMbas CLI config.yaml", "~/.config/lembas/config.yaml, or a project's .agent/config.yaml. Strings may be {env:NAME} or {file:path}."),
    connections: make(ConnectionsFile, "LLeMbas CLI connections.yaml", "~/.config/lembas/connections.yaml: the LLM endpoints. Global only. Keys as {env:NAME}, {file:path} or key_cmd — never pasted."),
  }
}

export const schemaText = (s: Record<string, unknown>) => JSON.stringify(s, null, 2) + "\n"

/** The comment that points a YAML language server at a schema, relative to the YAML file. */
export const modeline = (file: string) => `# yaml-language-server: $schema=schema/${file}`

/** Write both schemas under ~/.config/lembas/schema/. `link`: also point config.yaml and
 *  connections.yaml at them — a comment on the first line, added once. */
export function installSchemas(dir = paths.config, link = false): string[] {
  const done: string[] = []
  mkdirSync(join(dir, "schema"), { recursive: true })
  const schemas = jsonSchemas()
  for (const [name, file] of Object.entries(SCHEMA_FILES) as [keyof typeof SCHEMA_FILES, string][]) {
    writeFileSync(join(dir, "schema", file), schemaText(schemas[name]))
    done.push(`wrote ${join(dir, "schema", file)}`)
    const yaml = join(dir, `${name}.yaml`)
    if (!link || !existsSync(yaml)) continue
    const text = readFileSync(yaml, "utf8")
    if (text.includes("yaml-language-server: $schema=")) continue
    // writeFileSync keeps the file's mode: connections.yaml stays 0600.
    writeFileSync(yaml, `${modeline(file)}\n${text}`)
    done.push(`${yaml}: added the schema comment on its first line`)
  }
  return done
}
