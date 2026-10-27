// The harness spec (harness/, shared with LLeMbas) and this implementation of it must agree: every
// tool the spec gives the CLI exists here with the same shape, flags and risk, and every
// built-in tool and prompt is in the spec. A change made on one side only fails here.
import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { z } from "zod"
import { fillDescription, forCli, HARNESS_VERSION, narrowParameters, PURPOSE_DEF, TOOL_SPECS } from "../src/harness.ts"
import { createApp, stricterMode } from "../src/app.ts"
import { paths } from "../src/config/paths.ts"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { MODE_ALIASES, MODES, type Mode } from "../src/config/schema.ts"
import { promptText } from "../src/prompt/assemble.ts"
import { normalise, type Plan } from "../src/plan/plan.ts"
import { canonicalToolNames, resolveCall } from "../src/tool/names.ts"
import { BUILTIN_TOOLS } from "../src/tool/registry.ts"
import { purposeKey, toSpec, type Tool, type ToolContext } from "../src/tool/tool.ts"

const HARNESS = join(import.meta.dir, "..", "harness")
const ours: Tool[] = [...BUILTIN_TOOLS]
const forUs = Object.values(TOOL_SPECS).filter(forCli)

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
  // X.Y.Z, or a pre-release while the spec runs ahead of both implementations (3.0.0-draft).
  expect(HARNESS_VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/)
  const files = readdirSync(join(HARNESS, "tools")).filter((f) => f.endsWith(".json"))
  expect(files.length).toBe(Object.keys(TOOL_SPECS).length)
  for (const f of files) expect(JSON.parse(readFileSync(join(HARNESS, "tools", f), "utf8")).name).toBe(f.replace(/\.json$/, ""))
})

test("every tool says how it is shown (block), from the spec's list", () => {
  const kinds = ["shell", "edit", "read", "search", "web", "task", "plan", "hidden", "tool"]
  // A plan change is not drawn as a call: the plan card refreshes instead.
  for (const name of ["plan_write", "plan_update"]) expect(TOOL_SPECS[name]!.block).toBe("plan")
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
    expect(t.description).toBe(t.vars ? fillDescription(s.description, t.vars) : s.description)
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

test("every prompt text is in harness/prompts, and every file there that is not the server's alone is one the CLI knows", () => {
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".md") ? [join(d, e.name)] : []))
  const files = walk(join(HARNESS, "prompts")).map((f) => relative(join(HARNESS, "prompts"), f))
  const index = JSON.parse(readFileSync(join(HARNESS, "prompts", "index.json"), "utf8")) as { prompts: Record<string, { scope: string }> }
  for (const f of files) {
    if (index.prompts[f]?.scope === "llembas") expect(() => promptText(f)).toThrow()
    else expect(() => promptText(f)).not.toThrow()
  }
})

test("prompts/index.json lists every prompt text, each with a scope", () => {
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".md") ? [join(d, e.name)] : []))
  const files = walk(join(HARNESS, "prompts")).map((f) => relative(join(HARNESS, "prompts"), f)).sort()
  const index = JSON.parse(readFileSync(join(HARNESS, "prompts", "index.json"), "utf8")) as { prompts: Record<string, { scope: string; llembas: string[] }> }
  expect(Object.keys(index.prompts).sort()).toEqual(files)
  for (const p of Object.values(index.prompts)) expect(["shared", "cli", "llembas"]).toContain(p.scope)
})

test("spec 3.0.0: every tool says where it is offered; the CLI's are the agent's, never a chat's", () => {
  for (const t of Object.values(TOOL_SPECS)) expect(["chat", "agent", "both"]).toContain(t.sessions)
  // The file tools are shared and offered in both worlds: here on the device's disk, in a chat over
  // the server's tree. multiedit, apply_patch and bash stay the agent's.
  for (const n of ["read", "write", "edit", "glob", "grep", "list"]) expect([TOOL_SPECS[n]!.scope, TOOL_SPECS[n]!.sessions]).toEqual(["shared", "both"])
  for (const n of ["apply_patch", "bash", "multiedit"]) expect([TOOL_SPECS[n]!.scope, TOOL_SPECS[n]!.sessions]).toEqual(["cli", "agent"])
  // A chat's own tools over the server's tree are not the CLI's, and none is built in here.
  const chats = ["branch", "commit", "merge", "mkdir", "mv", "pr", "python", "release", "rm", "search", "tag"]
  for (const n of chats) {
    expect(TOOL_SPECS[n]!.sessions).toBe("chat")
    expect(forCli(TOOL_SPECS[n]!)).toBe(false)
    expect(ours.some((t) => t.name === n)).toBe(false)
  }
  // The local library stays the CLI's alone; a chat's notes and knowledge are files now.
  for (const n of ["knowledge_get", "knowledge_search", "note_manage", "note_view", "notes_search"]) expect([TOOL_SPECS[n]!.scope, TOOL_SPECS[n]!.sessions]).toEqual(["cli", "agent"])
  // show needs a display: offered only where a client over the link shows files.
  expect(TOOL_SPECS.show!.requires).toEqual(["display"])
  expect(ours.find((t) => t.name === "show")!.requires).toBe("display")
  // The plan is one structure both keep (spec 1.1.0): its three tools are shared, and todo is
  // plan_write's former name rather than a tool.
  expect(TOOL_SPECS.todo).toBeUndefined()
  expect(TOOL_SPECS.plan_write!.aliases.cli).toEqual(["todo"])
  const shared = ["ask_user", "edit", "glob", "grep", "job_list", "job_output", "job_send", "job_stop", "list", "memory", "plan_submit", "plan_update", "plan_write", "read", "recall", "report", "session_search", "show", "skill_manage", "skill_view", "skills_list", "task", "web_fetch", "web_search", "write"]
  expect(Object.values(TOOL_SPECS).filter((t) => t.scope === "shared").map((t) => t.name).sort()).toEqual(shared.sort())
})

test("the personality presets are shared prompt texts, one paragraph each", () => {
  const index = JSON.parse(readFileSync(join(HARNESS, "prompts", "index.json"), "utf8")) as { prompts: Record<string, { scope: string; llembas_text?: string }> }
  for (const n of ["concise", "pragmatic", "optimistic", "funny", "formal", "socratic"]) {
    expect(index.prompts[`personality/${n}.md`]).toMatchObject({ scope: "shared", llembas_text: "identical" })
    expect(promptText(`personality/${n}.md`)).not.toContain("\n")
  }
})

test("every narrow in the spec is a subset its project can offer, of a shared tool", () => {
  for (const s of Object.values(TOOL_SPECS)) {
    for (const [project, n] of Object.entries(s.narrow ?? {})) {
      expect(s.scope).toBe("shared")
      expect(["cli", "llembas"]).toContain(project)
      expect(() => narrowParameters(s.parameters, n)).not.toThrow()
    }
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
    // In the description, and in any description inside the parameters.
    const text = s.description + JSON.stringify(s.parameters)
    const used = [...new Set([...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!))]
    expect(used.sort()).toEqual(Object.keys(s.variables ?? {}).sort())
  }
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(join(paths.config, "connections.yaml"), "connections:\n  f:\n    type: webui\n    url: http://127.0.0.1:9/v1\n    models: { f/m: {} }\n", { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), "model: f/m\nlimits: { bash_timeout: 90 }\n")
  const app = createApp({ cwd: mkdtempSync(join(tmpdir(), "ph-vars-")), store: false, snapshots: false, asker: { ask: async () => ({ kind: "once" }) } })
  for (const t of app.engine.o.tools) {
    expect(t.description).not.toContain("{{")
    expect(JSON.stringify(toSpec(t).parameters)).not.toContain("{{")
  }
  const bash = app.engine.o.tools.find((t) => t.name === "bash")!
  expect(bash.description).toContain("default 90 seconds, up to 10 minutes) is not killed: it goes on in the background as a job, and the call returns what it had printed with the job id. For a server")
  expect(PURPOSE_DEF.schema).toEqual({ type: "string", description: expect.stringContaining("what this call is for") })
  // Nor through the assembled system prompt, in any mode, with or without a plan, with the
  // instance's pieces or without them; the CLI's facts are in it and the bullets LLeMbas alone
  // fills are gone.
  const plan = normalise({ title: "T", phases: [{ title: "P", tasks: ["a"] }] }) as Plan
  for (const mode of MODES) {
    for (const p of [undefined, plan]) {
      const system = app.engine.o.system(mode, app.engine.model, p)
      expect(system).not.toContain("{{")
      expect(system).toContain("Use the instructions below and the tools you have to help with software engineering and with running the project.")
      expect(system).toContain("- Your output is shown in a terminal and rendered as GitHub-flavoured markdown in a monospace font. Be concise")
      expect(system).toContain("- Use the dedicated tools for files: read (not cat)")
      expect(system).toContain("- A long-running command (a server, a watcher) runs with bash `background: true`")
      expect(system).toContain("- For work with three or more steps, write a plan with plan_write")
      expect(system).toContain("- When a decision is genuinely the user's")
      expect(system).toContain("# Git\n- How git is used in this project")
      expect(system).not.toContain("- \n")
      if (p) expect(system).toContain("- ### The current plan\n\n# T\n## p1 P (pending)\n[t1] [ ] a\n\nThis is the plan as it stands now. Work to it, and quote the ids above rather than restating the plan in your answer.")
      else expect(system).not.toContain("The current plan")
    }
  }
  app.setContext({ instructions: "Be brief.", prototypes: { offered: true, sources: "" }, library: { bases: [{ id: "k", name: "K" }] } }, "example")
  const withContext = app.engine.o.system("manual", app.engine.model, plan)
  expect(withContext).not.toContain("{{")
  expect(withContext).toContain("## Instructions from example\n\nBe brief.")
  expect(withContext).toContain("prototype-page")
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
