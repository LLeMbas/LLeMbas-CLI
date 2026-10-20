// The names harness spec v1 changed (shared with LLeMbas): question → ask_user, plan_exit →
// plan_submit, websearch/webfetch → web_search/web_fetch, notes → notes_search/note_view/
// note_manage, bash's workdir → cwd, the mode unrestricted → auto; and 1.1.0's todo → plan_write. Whatever was written under an
// old name — a stored session, a config file, an agent file, a prompt override — keeps working.
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../src/app.ts"
import { paths } from "../src/config/paths.ts"
import { findSetting, parseValue } from "../src/config/settings.ts"
import { asMode, renamePermissionKeys } from "../src/config/schema.ts"
import { loadConfig } from "../src/config/load.ts"
import { promptText } from "../src/prompt/assemble.ts"
import { canonicalToolNames, resolveCall } from "../src/tool/names.ts"
import { delta, fakeProvider, toolCall, type Fake } from "./fake-provider.ts"

let fake: Fake | undefined
afterEach(() => fake?.stop())

test("a call under a former name runs the tool it now is, with its arguments", () => {
  expect(resolveCall("question", { questions: [] })).toEqual({ name: "ask_user", raw: { questions: [] } })
  expect(resolveCall("plan_exit", { path: "p.md" }).name).toBe("plan_submit")
  expect(resolveCall("websearch", { query: "x" }).name).toBe("web_search")
  expect(resolveCall("webfetch", { url: "https://x" }).name).toBe("web_fetch")
  // bash's workdir is cwd now; a call that names both keeps cwd.
  expect(resolveCall("bash", { command: "ls", workdir: "src" })).toEqual({ name: "bash", raw: { command: "ls", cwd: "src" } })
  expect(resolveCall("bash", { command: "ls", workdir: "a", cwd: "b" }).raw).toEqual({ command: "ls", cwd: "b" })
  // notes was one tool with an action: by what the action does.
  expect(resolveCall("notes", { action: "search", query: "pump" })).toEqual({ name: "notes_search", raw: { query: "pump" } })
  expect(resolveCall("notes", { action: "get", id: 3 })).toEqual({ name: "note_view", raw: { id: 3 } })
  expect(resolveCall("notes", { action: "delete", id: 3 })).toEqual({ name: "note_manage", raw: { action: "delete", id: 3 } })
  // A name that is not a former one is left alone.
  expect(resolveCall("read", { path: "a" })).toEqual({ name: "read", raw: { path: "a" } })
  expect(canonicalToolNames(["read", "webfetch", "notes"])).toEqual(["read", "web_fetch", "notes_search", "note_view", "note_manage"])
})

test("spec 2.0.0: bash_output, bash_list and bash_kill are job_output, job_list and job_stop, in calls and in permission rules", () => {
  expect(resolveCall("bash_output", { id: "job1" })).toEqual({ name: "job_output", raw: { id: "job1" } })
  expect(resolveCall("bash_list", {}).name).toBe("job_list")
  expect(resolveCall("bash_kill", { id: "job2" }).name).toBe("job_stop")
  expect(canonicalToolNames(["bash", "bash_output"])).toEqual(["bash", "job_output"])
  expect(renamePermissionKeys({ bash_output: "deny", bash_kill: "ask", job_list: "allow" })).toEqual({ job_output: "deny", job_stop: "ask", job_list: "allow" })
})

test("a todo call is a plan_write of one phase called Work, its statuses translated", () => {
  const r = resolveCall("todo", { todos: [{ content: "Read the code", status: "completed" }, { content: "Fix it", status: "in_progress" }, "Test it", { content: "Old idea", status: "cancelled" }] })
  expect(r.name).toBe("plan_write")
  expect(r.raw).toEqual({
    title: "Work",
    phases: [{ title: "Work", status: "active", tasks: [{ text: "Read the code", status: "done" }, { text: "Fix it", status: "doing" }, { text: "Test it", status: "todo" }, { text: "Old idea", status: "dropped" }] }],
  })
  // Nothing in progress: the phase is pending. An empty list is an empty plan, which the tool refuses.
  expect((resolveCall("todo", { todos: ["a"] }).raw as { phases: { status: string }[] }).phases[0]!.status).toBe("pending")
  expect(resolveCall("todo", { todos: [] }).raw).toEqual({ title: "Work", phases: [] })
  expect(canonicalToolNames(["todo", "read"])).toEqual(["plan_write", "read"])
})

test("the mode unrestricted is auto, wherever a mode is written", () => {
  expect(asMode("unrestricted")).toBe("auto")
  expect(asMode(" auto ")).toBe("auto")
  expect(asMode("wild")).toBeUndefined()
  expect(parseValue(findSetting("mode")!, "unrestricted")).toBe("auto")
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(join(paths.config, "config.yaml"), "mode: unrestricted\npermission:\n  webfetch: deny\n  web_search: ask\n  websearch: allow\n")
  const l = loadConfig()
  expect(l.config.mode).toBe("auto")
  // The old key is read as the new; the new one written as well wins.
  expect(l.permissions[0]).toEqual({ web_fetch: "deny", web_search: "ask" })
  expect(renamePermissionKeys({ question: "deny", bash: "ask" })).toEqual({ ask_user: "deny", bash: "ask" })
})

test("a prompt override under the old file name still replaces the mode's text", () => {
  mkdirSync(join(paths.config, "prompts", "modes"), { recursive: true })
  writeFileSync(join(paths.config, "prompts", "modes", "unrestricted.md"), "Mine: nothing asks.")
  expect(promptText("modes/auto.md")).toBe("Mine: nothing asks.")
  writeFileSync(join(paths.config, "prompts", "modes", "auto.md"), "Mine, renamed.")
  expect(promptText("modes/auto.md")).toBe("Mine, renamed.")
})

test("a model calling notes with an action still gets its note written, and read back", async () => {
  fake = fakeProvider([
    { chunks: [toolCall(0, "n1", "notes", JSON.stringify({ action: "create", title: "Pump", body: "Primes in 30 s.", scope: "global" }))] },
    { chunks: [toolCall(0, "n2", "notes", JSON.stringify({ action: "search", query: "pump" }))] },
    { chunks: [delta({ content: "ok" }, "stop")] },
  ])
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  f:\n    dialect: openai-chat\n    base_url: ${fake.url}\n    models: { m: {} }\n`, { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), "model: f/m\ntitles: prompt\n")
  const app = createApp({ cwd: mkdtempSync(join(tmpdir(), "ph-names-")), store: false, snapshots: false, asker: { ask: async () => ({ kind: "once" }) } })
  for (const n of app.library.notes(["global"])) app.library.deleteNote(n.id)
  await app.engine.prompt("keep this")
  const results = app.engine.messages.filter((m) => m.role === "tool").map((m) => (m.role === "tool" ? m.content : ""))
  expect(results[0]).toContain("Saved note")
  expect(results[1]).toContain("Pump")
})
