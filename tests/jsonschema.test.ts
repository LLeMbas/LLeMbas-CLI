// The JSON Schemas editors check config.yaml and connections.yaml against.
import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Ajv from "ajv"
import { parse } from "yaml"
import { installSchemas, jsonSchemas, modeline, SCHEMA_FILES, schemaText } from "../src/config/jsonschema.ts"
import { Config, ConnectionsFile } from "../src/config/schema.ts"

const schemas = jsonSchemas()
const ajv = new Ajv({ strict: false, allErrors: true })
const checkConfig = ajv.compile(schemas.config)
const checkConnections = ajv.compile(schemas.connections)

test("schema/ in the repository is what the code makes (bun run schema)", () => {
  for (const [name, file] of Object.entries(SCHEMA_FILES) as [keyof typeof SCHEMA_FILES, string][])
    expect(readFileSync(join(import.meta.dir, "..", "schema", file), "utf8")).toBe(schemaText(schemas[name]))
})

test("draft-07, described, and no string held to a format ({env:} stands in for anything)", () => {
  expect(schemas.config.$schema).toBe("http://json-schema.org/draft-07/schema#")
  const text = JSON.stringify(schemas)
  expect(text).not.toContain('"format"')
  const props = (schemas.config as any).properties
  expect(props.mode.enum).toEqual(["manual", "edit", "auto", "plan"])
  expect(props.small_model.description).toContain("session titles")
  // 2.0: the login is the only kind of entry.
  const login = (schemas.connections as any).properties.connections.additionalProperties
  expect(login.properties.type.const ?? login.properties.type.enum[0]).toBe("webui")
  expect(login.properties.url.description).toContain("The instance's address")
  expect(login.properties.dialect).toBeUndefined()
})

const goodConfig = `
model: llama/qwen3
small_model: llama/tiny
titles: prompt
mode: edit
icons: plain
permission:
  bash: { "git push*": ask, "*": allow }
  read: allow
limits: { steps: 300 }
compaction: { auto_at: 0.8 }
instruction_files: [docs/style.md]
instructions: Answer in Slovak.
personality: custom
personality_custom: Dry and short.
search:
  order: [searxng, ddg]
  searxng: { base_url: "{env:SEARX}" }
  fetch: local
voice:
  stt: { base_url: https://voice.example/v1, api_key: "{file:~/.voice}", model: whisper-1 }
  tts: { provider: piper-cli, model_path: ~/voices/en.onnx }
  record_mode: hold
mcp:
  docs: { url: https://mcp.example/mcp, oauth: false }
  fs: { command: [npx, -y, some-server], env: { TOKEN: "{env:T}" } }
`
const goodConnections = `
connections:
  example:
    type: webui
    url: https://ai.example.org
    api_key: "{file:~/.config/lembas/lembas/example.key}"
    tls: { ca: ~/ca.crt }
    quirks: { stream_usage: off }
    models:
      llama/qwen3: { context: 131072, max_output: 65536, efforts: [low, high], effort: low, vision: true }
`

test("what the loader accepts, the schema accepts", () => {
  const c = parse(goodConfig)
  expect(Config.safeParse(c).success).toBe(true)
  expect(checkConfig(c)).toBe(true)
  const n = parse(goodConnections)
  expect(ConnectionsFile.safeParse(n).success).toBe(true)
  expect(checkConnections(n)).toBe(true)
  // The installer's starter files, comments and all.
  const install = readFileSync(join(import.meta.dir, "..", "install.sh"), "utf8")
  const starters = [...install.matchAll(/<<'YAML'\n([\s\S]*?)\nYAML/g)].map((m) => parse(m[1]!) ?? {})
  expect(starters).toHaveLength(2)
  expect(checkConfig(starters[0])).toBe(true)
  expect(checkConnections(starters[1])).toBe(true)
})

test("…and what it refuses, the schema marks", () => {
  for (const bad of [{ mode: "yolo" }, { modle: "x" }, { limits: { steps: 0 } }, { icons: "kaomoji" }, { search: { order: ["bing"] } }]) {
    expect(Config.safeParse(bad).success).toBe(false)
    expect(checkConfig(bad)).toBe(false)
  }
  // A custom connection (1.x): the loader reads past it with a warning, and the schema marks it.
  for (const bad of [{ connections: { x: { dialect: "openai-chat", base_url: "http://h/v1" } } }, { connections: { x: { type: "webui" } } }, { connections: { x: { type: "webui", url: "https://h", models: { m: { context: -1 } } } } }, { connections: { x: { type: "webui", url: "https://h", key_cmd: "pass x" } } }]) {
    expect(checkConnections(bad)).toBe(false)
  }
})

test("lembas config schema: files written; --link adds the comment once and keeps 0600", () => {
  const dir = mkdtempSync(join(tmpdir(), "ph-schema-"))
  writeFileSync(join(dir, "config.yaml"), "mode: edit\n")
  writeFileSync(join(dir, "connections.yaml"), "connections: {}\n", { mode: 0o600 })
  const plain = installSchemas(dir)
  expect(plain).toHaveLength(2)
  expect(readFileSync(join(dir, "config.yaml"), "utf8")).toBe("mode: edit\n")
  installSchemas(dir, true)
  installSchemas(dir, true)
  expect(readFileSync(join(dir, "config.yaml"), "utf8")).toBe(`${modeline("config.schema.json")}\nmode: edit\n`)
  expect(readFileSync(join(dir, "connections.yaml"), "utf8")).toBe(`${modeline("connections.schema.json")}\nconnections: {}\n`)
  expect(statSync(join(dir, "connections.yaml")).mode & 0o777).toBe(0o600)
  expect(JSON.parse(readFileSync(join(dir, "schema", "config.schema.json"), "utf8")).title).toBe("LLeMbas CLI config.yaml")
})
