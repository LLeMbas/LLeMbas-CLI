// Every call can say what it is for; the user sees that when asked. The tool never sees the
// added argument — an MCP server, which gets arguments as they are, least of all.
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { createApp } from "../src/app.ts"
import type { AskReply } from "../src/bus/index.ts"
import { paths } from "../src/config/paths.ts"
import { BUILTIN_TOOLS } from "../src/tool/registry.ts"
import { splitPurpose, toSpec, type Tool } from "../src/tool/tool.ts"
import { delta, fakeProvider, toolCall, type Fake } from "./fake-provider.ts"

let fake: Fake | undefined
afterEach(() => fake?.stop())

const spec = (name: string) => toSpec(BUILTIN_TOOLS.find((t) => t.name === name)!).parameters as { properties: Record<string, { description?: string }> }

const mcpLike = (props: Record<string, unknown>, seen: unknown[]): Tool =>
  ({
    name: "mcp__srv__do",
    access: "mcp__srv__do",
    description: "an MCP tool",
    schema: z.looseObject({}),
    jsonSchema: { type: "object", properties: props },
    permission: () => ({ permission: "mcp__srv__do", class: "execute", patterns: ["*"] }),
    run: async (args: unknown) => (seen.push(args), { output: "done" }),
  }) as Tool

test("every tool that can ask takes a purpose; bash says it in description; tools that never ask do not", () => {
  for (const name of ["edit", "write", "read", "web_fetch", "skill_manage", "task"]) expect(spec(name).properties.purpose?.description).toContain("what this call is for")
  expect(spec("bash").properties.purpose).toBeUndefined()
  expect(spec("bash").properties.description?.description).toContain("what this command is for")
  for (const name of ["ask_user", "plan_write", "plan_update", "plan_submit", "bash_output", "bash_list", "notes_search", "note_view", "note_manage"]) expect(spec(name).properties.purpose).toBeUndefined()
})

test("split: taken out of the arguments; a server's own `purpose` stays its own", () => {
  const seen: unknown[] = []
  expect(splitPurpose(mcpLike({ q: {} }, seen), { q: 1, purpose: " find it " })).toEqual({ args: { q: 1 }, purpose: "find it" })
  const own = mcpLike({ purpose: { type: "string" } }, seen)
  expect(toSpec(own).parameters).toEqual({ type: "object", properties: { purpose: { type: "string" } } })
  expect(splitPurpose(own, { purpose: "theirs" })).toEqual({ args: { purpose: "theirs" } })
  const bash = BUILTIN_TOOLS.find((t) => t.name === "bash")!
  expect(splitPurpose(bash, { command: "ls", description: "See what is here" })).toEqual({ args: { command: "ls", description: "See what is here" }, purpose: "See what is here" })
})

test("the asker is told the purpose, and the tool runs without it", async () => {
  fake = fakeProvider([
    { chunks: [toolCall(0, "c1", "mcp__srv__do", JSON.stringify({ q: "x", purpose: "Check the ticket is still open before closing it" }))] },
    { chunks: [delta({ content: "ok" }, "stop")] },
  ])
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  f:\n    dialect: openai-chat\n    base_url: ${fake.url}\n    models: { m: {} }\n`, { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), "model: f/m\n")
  const asked: (string | undefined)[] = []
  const app = createApp({ cwd: mkdtempSync(join(tmpdir(), "ph-purpose-")), store: false, snapshots: false, asker: { ask: async (r): Promise<AskReply> => (asked.push(r.purpose), { kind: "once" }) } })
  const seen: unknown[] = []
  app.engine.o.tools.push(mcpLike({ q: { type: "string" } }, seen))
  expect(await app.engine.prompt("go")).toBe("stop")
  expect(asked).toEqual(["Check the ticket is still open before closing it"])
  expect(seen).toEqual([{ q: "x" }])
  expect(fake.requests[0].tools.find((t: any) => t.function.name === "mcp__srv__do").function.parameters.properties.purpose).toBeDefined()
})
