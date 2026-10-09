// The harness spec (harness/, shared with LLeMbas) and this implementation of it must agree: every
// tool the spec gives the CLI exists here with the same shape, flags and risk, and every
// built-in tool and prompt is in the spec. A change made on one side only fails here.
import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { z } from "zod"
import { HARNESS_VERSION, PURPOSE_DEF, TOOL_SPECS } from "../src/harness.ts"
import { createApp, stricterMode } from "../src/app.ts"
import { paths } from "../src/config/paths.ts"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { MODE_ALIASES, MODES, type Mode } from "../src/config/schema.ts"
import { promptText } from "../src/prompt/assemble.ts"
import { canonicalToolNames, resolveCall } from "../src/tool/names.ts"
import { BUILTIN_TOOLS } from "../src/tool/registry.ts"
import { purposeKey, type Tool, type ToolContext } from "../src/tool/tool.ts"

const HARNESS = join(import.meta.dir, "..", "harness")
const ours: Tool[] = [...BUILTIN_TOOLS]
const forUs = Object.values(TOOL_SPECS).filter((t) => t.scope !== "llembas")

/** A JSON Schema with its prose and zod's integer bounds taken out: the shape a call must have. */
function shape(o: unknown): unknown {
  if (Array.isArray(o)) return o.map(shape)
  if (!o || typeof o !== "object") return o
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) {
    if (k === "description" || k === "$schema") continue
    if ((k === "maximum" || k === "minimum") && typeof v === "number" && Math.abs(v) === Number.MAX_SAFE_INTEGER) continue
    out[k] = shape(v)
  }
  return out
}

function zodShape(t: Tool): unknown {
  return shape(z.toJSONSchema(t.schema, { target: "draft-7", io: "input" }))
}

/** Arguments that satisfy the spec's required fields, to ask a tool which risk a call carries. */
function sample(schema: Record<string, unknown>): Record<string, unknown> {
  const props = (schema.properties ?? {}) as Record<string, { type?: string; enum?: unknown[] }>
  const out: Record<string, unknown> = {}
  for (const k of (schema.required ?? []) as string[]) {
    const p = props[k] ?? {}
    out[k] = p.enum ? p.enum[0] : p.type === "integer" || p.type === "number" ? 1 : p.type === "array" ? [] : p.type === "object" ? {} : p.type === "boolean" ? false : "x"
  }
  return out
}

const ctx = { root: "/tmp/ph-spec", cwd: "/tmp/ph-spec", signal: new AbortController().signal, readFiles: new Set(), fileStamps: new Map(), bashTimeoutMs: 1000 } as unknown as ToolContext

test("the spec has a version, and one file per tool, named as the tool", () => {
  expect(HARNESS_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  const files = readdirSync(join(HARNESS, "tools")).filter((f) => f.endsWith(".json"))
  expect(files.length).toBe(Object.keys(TOOL_SPECS).length)
  for (const f of files) expect(JSON.parse(readFileSync(join(HARNESS, "tools", f), "utf8")).name).toBe(f.replace(/\.json$/, ""))
})

test("every tool says how it is shown (block), from the spec's list", () => {
  const kinds = ["shell", "edit", "read", "search", "web", "task", "hidden", "tool"]
  for (const s of Object.values(TOOL_SPECS)) expect(kinds).toContain(s.block)
  // The ones that carry their change carry its diff: the web UI draws it from result.meta.diff.
  for (const name of ["edit", "multiedit", "apply_patch", "write"]) expect(TOOL_SPECS[name]!.block).toBe("edit")
})

test("every tool the spec gives the CLI is built in, and every built-in tool is in the spec", () => {
  expect(ours.map((t) => t.name).sort()).toEqual(forUs.map((t) => t.name).sort())
})

for (const t of ours) {
  test(`${t.name}: the spec's parameters, description, flags and risk are this tool's`, () => {
    const s = TOOL_SPECS[t.name]!
    expect(t.description).toBe(s.description)
    expect(zodShape(t)).toEqual(shape(s.parameters))
    expect(t.exclusive === true).toBe(s.exclusive)
    expect(purposeKey(t) ?? false).toBe(s.purpose)
    // A tool with actions carries the strongest of them (only the CLI's own tasks and decisions
    // still mix a reader with a writer; a shared tool never does — see the next test).
    const actions = ((s.parameters.properties as Record<string, { enum?: string[] }> | undefined)?.action?.enum ?? [undefined]) as (string | undefined)[]
    const rank = ["read", "interact", "write", "execute"]
    const classes = actions.map((action) => t.permission({ ...sample(s.parameters), ...(action ? { action } : {}) } as never, ctx).class)
    expect(classes.reduce((a, b) => (rank.indexOf(b) > rank.indexOf(a) ? b : a))).toBe(s.risk)
  })
}

test("a former name in the spec is read as its tool; the spec's argument aliases are applied", () => {
  for (const s of forUs) {
    for (const old of s.aliases.cli) {
      if (old === "notes") expect(canonicalToolNames(["notes"])).toContain(s.name)
      else expect(resolveCall(old, {}).name).toBe(s.name)
    }
    for (const [old, now] of Object.entries(s.argument_aliases ?? {})) expect(resolveCall(s.name, { [old]: "v" }).raw).toEqual({ [now]: "v" })
  }
})

test("read and write never share a tool: every tool carries one risk, and a reader has no write action", () => {
  for (const s of forUs) expect(["read", "write", "execute", "interact"]).toContain(s.risk)
  for (const s of forUs.filter((x) => x.scope === "shared")) {
    const t = ours.find((x) => x.name === s.name)!
    const actions = ((s.parameters.properties as Record<string, { enum?: string[] }> | undefined)?.action?.enum ?? []) as string[]
    const classes = new Set(actions.map((action) => t.permission({ ...sample(s.parameters), action } as never, ctx).class))
    expect(classes.size).toBeLessThanOrEqual(1)
  }
  const readers = forUs.filter((s) => s.risk === "read").map((s) => s.name)
  for (const name of readers) {
    const props = (TOOL_SPECS[name]!.parameters.properties ?? {}) as Record<string, { enum?: string[] }>
    for (const w of ["create", "edit", "delete", "add", "remove", "set"]) expect(props.action?.enum ?? []).not.toContain(w)
  }
})

test("every prompt text is in harness/prompts, and every file there is one the CLI knows", () => {
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".md") ? [join(d, e.name)] : []))
  const files = walk(join(HARNESS, "prompts")).map((f) => relative(join(HARNESS, "prompts"), f))
  for (const f of files) expect(() => promptText(f)).not.toThrow()
})

test("prompts/index.json lists every prompt text, each with a scope", () => {
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".md") ? [join(d, e.name)] : []))
  const files = walk(join(HARNESS, "prompts")).map((f) => relative(join(HARNESS, "prompts"), f)).sort()
  const index = JSON.parse(readFileSync(join(HARNESS, "prompts", "index.json"), "utf8")) as { prompts: Record<string, { scope: string; llembas: string[] }> }
  expect(Object.keys(index.prompts).sort()).toEqual(files)
  for (const p of Object.values(index.prompts)) expect(["shared", "cli", "llembas"]).toContain(p.scope)
})

test("the execution tools are the CLI's alone; the web UI runs no agent", () => {
  // LLeMbas removed its SSH workplace, so nothing that runs a command or touches a file is shared.
  const exec = ["apply_patch", "bash", "bash_kill", "bash_list", "bash_output", "edit", "glob", "grep", "list", "multiedit", "read", "write", "todo", "plan_submit"]
  for (const n of exec) expect(TOOL_SPECS[n]!.scope).toBe("cli")
  const shared = ["ask_user", "knowledge_get", "knowledge_search", "memory", "note_manage", "note_view", "notes_search", "skill_manage", "skill_view", "skills_list", "task", "web_fetch", "web_search"]
  for (const n of shared) expect(TOOL_SPECS[n]!.scope).toBe("shared")
  expect(Object.values(TOOL_SPECS).filter((t) => t.scope === "shared").map((t) => t.name).sort()).toEqual(shared.sort())
})

test("the personality presets are shared prompt texts, one paragraph each", () => {
  const index = JSON.parse(readFileSync(join(HARNESS, "prompts", "index.json"), "utf8")) as { prompts: Record<string, { scope: string; llembas_text?: string }> }
  for (const n of ["concise", "pragmatic", "optimistic", "funny", "formal", "socratic"]) {
    expect(index.prompts[`personality/${n}.md`]).toMatchObject({ scope: "shared", llembas_text: "identical" })
    expect(promptText(`personality/${n}.md`)).not.toContain("\n")
  }
})

test("modes.json is the modes the CLI has, loosest first, with the same former names", () => {
  const modes = JSON.parse(readFileSync(join(HARNESS, "permission", "modes.json"), "utf8")) as { order: string[]; aliases: Record<string, string>; modes: Record<string, unknown> }
  expect([...MODES].sort() as string[]).toEqual(Object.keys(modes.modes).sort())
  expect(modes.aliases).toEqual(MODE_ALIASES)
  for (let i = 1; i < modes.order.length; i++) expect(stricterMode(modes.order[i - 1] as Mode, modes.order[i] as Mode)).toBe(modes.order[i] as Mode)
})

test("every {{variable}} in a description is declared, and none reaches a model", () => {
  for (const s of Object.values(TOOL_SPECS)) {
    const used = [...s.description.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!)
    expect(used.sort()).toEqual(Object.keys(s.variables ?? {}).sort())
  }
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(join(paths.config, "connections.yaml"), "connections:\n  f:\n    dialect: openai-chat\n    base_url: http://127.0.0.1:9/v1\n    models: { m: {} }\n", { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), "model: f/m\nlimits: { bash_timeout: 90 }\n")
  const app = createApp({ cwd: mkdtempSync(join(tmpdir(), "ph-vars-")), store: false, snapshots: false, asker: { ask: async () => ({ kind: "once" }) } })
  for (const t of app.engine.o.tools) expect(t.description).not.toContain("{{")
  const bash = app.engine.o.tools.find((t) => t.name === "bash")!
  expect(bash.description).toContain("default 90 seconds, `timeout` up to 10 minutes). For a server")
  expect(PURPOSE_DEF.schema).toEqual({ type: "string", description: expect.stringContaining("what this call is for") })
})

test("acp.md names every _lembas method the code handles or sends, and every capability", async () => {
  const doc = readFileSync(join(HARNESS, "acp.md"), "utf8")
  const code = readdirSync(join(import.meta.dir, "../src/acp"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => readFileSync(join(import.meta.dir, "../src/acp", f), "utf8"))
    .join("\n")
  const methods = new Set([...code.matchAll(/"(_lembas\/[a-z/]+)"/g)].map((m) => m[1]!))
  expect(methods.size).toBeGreaterThan(20)
  for (const m of methods) expect(doc).toContain(`\`${m}\``)
  const { CAPABILITIES } = await import("../src/acp/agent.ts")
  for (const c of [...CAPABILITIES, "terminal", "shell"]) expect(doc).toContain(`| \`${c}\` |`)
  // The protocol number it states is the code's.
  const { LEMBAS_PROTOCOL } = await import("../src/acp/agent.ts")
  expect(doc).toContain(`**${LEMBAS_PROTOCOL}**. CLI`)
})
