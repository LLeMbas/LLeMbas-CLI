import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../src/app.ts"
import type { AskReply, Event } from "../src/bus/index.ts"
import { paths } from "../src/config/paths.ts"
import { setTrust } from "../src/project/root.ts"
import { Store } from "../src/session/store.ts"
import { delta, fakeProvider, toolCall, usage, type Fake } from "./fake-provider.ts"

let fake: Fake | undefined
afterEach(() => fake?.stop())

function setup(script: Parameters<typeof fakeProvider>[0]) {
  fake = fakeProvider(script)
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(
    join(paths.config, "connections.yaml"),
    `connections:\n  fake:\n    dialect: openai-chat\n    base_url: ${fake.url}\n    models:\n      m: { context: 32768 }\n`,
    { mode: 0o600 },
  )
  writeFileSync(join(paths.config, "config.yaml"), "model: fake/m\n")
  const dir = mkdtempSync(join(tmpdir(), "lembas-proj-"))
  Bun.spawnSync(["git", "init", "-q", dir])
  writeFileSync(join(dir, "hello.txt"), "hello world\n")
  return dir
}

const noAsk = { ask: async (): Promise<AskReply> => { throw new Error("should not ask") } }

describe("end to end", () => {
  test("read → edit → answer, in edit mode, recorded and searchable", async () => {
    const dir = setup([
      { chunks: [delta({ content: "Reading first." }), toolCall(0, "c1", "read", '{"path":"hello.txt"}'), usage(100, 10)] },
      { chunks: [toolCall(0, "c2", "edit", JSON.stringify({ path: "hello.txt", old: "world", new: "lembas" })), usage(200, 20)] },
      { chunks: [delta({ content: "Changed the greeting." }, "stop"), usage(300, 5)] },
    ])
    const store = new Store()
    const app = createApp({ cwd: dir, mode: "edit", asker: noAsk, store })
    const events: Event[] = []
    app.bus.on((e) => events.push(e))
    expect(await app.engine.prompt("change world to lembas")).toBe("stop")
    expect(readFileSync(join(dir, "hello.txt"), "utf8")).toBe("hello lembas\n")
    // The tool result went back to the model as a tool message with the right id.
    expect(fake!.requests[1].messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "c1" })
    expect(fake!.requests[1].messages.at(-1).content).toContain("1: hello world")
    // System prompt carries env and the mode.
    expect(fake!.requests[0].messages[0].content).toContain(`Project root: ${dir}`)
    expect(fake!.requests[0].messages[0].content).toContain("Permission mode: edit")
    // knowledge_search/get are offered once any knowledge base has documents, and the suite shares
    // one LEMBAS_HOME: another file's base must not decide this list (found in the full run).
    expect(fake!.requests[0].tools.map((t: any) => t.function.name).filter((n: string) => !n.startsWith("knowledge_"))).toEqual(["read", "write", "edit", "multiedit", "apply_patch", "glob", "grep", "list", "bash", "job_output", "job_list", "job_stop", "job_send", "web_search", "web_fetch", "task", "plan_write", "plan_update", "ask_user", "memory", "session_search", "notes_search", "note_view", "note_manage", "skills_list", "skill_view", "skill_manage", "settings"])
    const ends = events.filter((e) => e.type === "tool_end")
    expect(ends.map((e) => e.type === "tool_end" && e.result.title)).toEqual(["hello.txt · 1–1 of 1", "hello.txt +1 −1"])
    const sid = store.sessions(1)[0]!.id
    expect(store.messages(sid)).toHaveLength(6)
    expect(store.search("greeting")[0]?.session_id).toBe(sid)
  })

  test("edit without read is refused and the model is told why", async () => {
    const dir = setup([
      { chunks: [toolCall(0, "c1", "edit", JSON.stringify({ path: "hello.txt", old: "world", new: "x" }))] },
      { chunks: [delta({ content: "ok" })] },
    ])
    const app = createApp({ cwd: dir, mode: "edit", asker: noAsk, store: false })
    await app.engine.prompt("go")
    expect(fake!.requests[1].messages.at(-1).content).toContain("has not been read")
    expect(readFileSync(join(dir, "hello.txt"), "utf8")).toBe("hello world\n")
  })

  test("hardline is refused in unrestricted mode; ask → deny with reason reaches the model", async () => {
    const dir = setup([
      { chunks: [toolCall(0, "c1", "bash", '{"command":"rm -rf /"}'), toolCall(1, "c2", "bash", '{"command":"npm publish"}')] },
      { chunks: [delta({ content: "understood" })] },
      { chunks: [toolCall(0, "c3", "bash", '{"command":"npm publish"}')] },
      { chunks: [delta({ content: "fine" })] },
    ])
    const unrestricted = createApp({ cwd: dir, mode: "auto", asker: noAsk, store: false })
    await unrestricted.engine.prompt("go")
    const toolMsgs = fake!.requests[1].messages.filter((m: any) => m.role === "tool")
    expect(toolMsgs[0].content).toContain("hardline")
    expect(toolMsgs[1].content).toContain("[exit")

    const asked: string[] = []
    const manual = createApp({
      cwd: dir,
      mode: "manual",
      store: false,
      asker: { ask: async ({ request }) => (asked.push(request.command!), { kind: "deny", feedback: "not today" }) },
    })
    await manual.engine.prompt("go")
    expect(asked).toEqual(["npm publish"])
    expect(fake!.requests[3].messages.at(-1).content).toContain("not today")
  })

  test("always (project) persists the rule into .agent/config.yaml of a trusted project", async () => {
    const dir = setup([{ chunks: [toolCall(0, "c1", "bash", '{"command":"echo hi there"}')] }, { chunks: [delta({ content: "ok" })] }])
    mkdirSync(join(dir, ".agent"))
    writeFileSync(join(dir, ".agent", "config.yaml"), "# my project\nmode: manual\n")
    setTrust(dir, "trusted")
    const app = createApp({ cwd: dir, asker: { ask: async () => ({ kind: "project" }) }, store: false })
    await app.engine.prompt("go")
    const saved = readFileSync(join(dir, ".agent", "config.yaml"), "utf8")
    expect(saved).toContain("# my project")
    expect(Bun.YAML.parse(saved)).toEqual({ mode: "manual", permission: { bash: { "echo *": "allow" } } })
  })

  test("step ceiling withdraws tools and asks for an answer", async () => {
    const dir = setup([
      { chunks: [toolCall(0, "c1", "list", "{}")] },
      { chunks: [delta({ content: "summary" })] },
    ])
    writeFileSync(join(paths.config, "config.yaml"), "model: fake/m\nlimits: { steps: 1 }\n")
    const app = createApp({ cwd: dir, mode: "edit", asker: noAsk, store: false })
    expect(await app.engine.prompt("go")).toBe("steps")
    expect(fake!.requests[1].tools).toBeUndefined()
    expect(fake!.requests[1].messages.at(-1).content).toContain("step limit")
  })

  test("the CLI: lembas run", async () => {
    const dir = setup([{ chunks: [delta({ content: "Hi from the fake." })] }])
    const p = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), "run", "--no-store", "hello"], {
      cwd: dir,
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
    expect(err).toBe("")
    expect(out).toBe("Hi from the fake.\n")
    expect(code).toBe(0)
  })
})

describe("nobody to approve", () => {
  test("a final denial withdraws every tool under that permission, and the prompt says so up front", async () => {
    const dir = setup([
      { chunks: [toolCall(0, "c1", "read", '{"path":"hello.txt"}'), toolCall(1, "c2", "edit", JSON.stringify({ path: "hello.txt", old: "world", new: "x" }))] },
      { chunks: [delta({ content: "I would change world to x." })] },
    ])
    const app = createApp({
      cwd: dir,
      mode: "manual",
      store: false,
      unattended: true,
      asker: { ask: async ({ tool }) => ({ kind: "deny", final: true, feedback: `nobody is present to approve ${tool}.` }) },
    })
    await app.engine.prompt("go")
    expect(fake!.requests[0].messages[0].content).toContain("nobody can approve anything")
    expect(fake!.requests[0].messages[0].content).toContain("any file change")
    const names = fake!.requests[1].tools.map((t: any) => t.function.name)
    expect(names).not.toContain("edit")
    expect(names).not.toContain("write")
    expect(names).toContain("read")
    expect(fake!.requests[1].messages.at(-1).content).toContain("no longer offered")
  })

  test("a 5xx before any output is retried once, then given up", async () => {
    const dir = setup([
      { status: 500, body: '{"error":{"message":"The model produced output that does not match the expected peg-native format"}}' },
      { chunks: [delta({ content: "second time lucky" })] },
    ])
    const app = createApp({ cwd: dir, mode: "edit", asker: noAsk, store: false })
    const notices: string[] = []
    app.bus.on((e) => e.type === "notice" && notices.push(e.message))
    expect(await app.engine.prompt("go")).toBe("stop")
    expect(notices.some((n) => n.startsWith("server error, retrying (1 of 2)"))).toBe(true)
  })
})

describe("loop guard with nobody to ask", () => {
  test("a third identical read is refused as a loop, and read stays offered", async () => {
    const read = () => ({ chunks: [toolCall(0, `r${Math.random()}`, "read", '{"path":"hello.txt"}')] })
    const dir = setup([read(), read(), read(), { chunks: [delta({ content: "done" })] }])
    const app = createApp({ cwd: dir, mode: "manual", store: false, unattended: true, asker: { ask: async () => ({ kind: "deny", final: true, feedback: "nobody." }) } })
    await app.engine.prompt("go")
    expect(fake!.requests[3].messages.at(-1).content).toContain("three times in a row")
    expect(fake!.requests[3].tools.map((t: any) => t.function.name)).toContain("read")
  })
})

describe("mid-reply server failure", () => {
  test("the real llama.cpp + gpt-oss parser failure, replayed", async () => {
    const raw = readFileSync(join(import.meta.dir, "fixtures/sse/gpt-oss-peg-native-failure-mid-reply.sse"), "utf8")
    const dir = setup([{ chunks: [], raw }, { chunks: [delta({ content: "ok" })] }])
    const app = createApp({ cwd: dir, mode: "edit", asker: noAsk, store: false })
    const notices: string[] = []
    app.bus.on((e) => e.type === "notice" && notices.push(e.message))
    expect(await app.engine.prompt("go")).toBe("stop")
    expect(notices.some((n) => n.includes("peg-native") && n.includes("retried"))).toBe(true)
  })

  test("retried once with the partial reply retracted", async () => {
    const dir = setup([
      { chunks: [delta({ content: "leaked analysis" }), { error: { code: 500, message: "The model produced output that does not match the expected peg-native format" } }] },
      { chunks: [delta({ content: "clean answer" })] },
    ])
    const app = createApp({ cwd: dir, mode: "edit", asker: noAsk, store: false })
    const seen: string[] = []
    app.bus.on((e) => (e.type === "retract" ? seen.push("RETRACT") : e.type === "text" ? seen.push(e.text) : undefined))
    expect(await app.engine.prompt("go")).toBe("stop")
    expect(seen).toEqual(["leaked analysis", "RETRACT", "clean answer"])
    expect(app.engine.messages.at(-1)).toEqual({ role: "assistant", parts: [{ type: "text", text: "clean answer" }] })
  })
})

describe("store: compaction and resume", () => {
  test("context() starts at the last compaction with its summary; messages() keeps everything", () => {
    const store = new Store(":memory:")
    const s = store.createSession("/p", "x/y")
    store.append(s.id, { role: "user", parts: [{ type: "text", text: "old question" }] })
    store.append(s.id, { role: "assistant", parts: [{ type: "text", text: "old answer" }] })
    store.compaction(s.id, "we talked about old things")
    store.append(s.id, { role: "user", parts: [{ type: "text", text: "new question" }] })
    const ctx = store.context(s.id)
    expect(ctx).toHaveLength(3)
    expect(JSON.stringify(ctx[0])).toContain("we talked about old things")
    expect(ctx[2]).toEqual({ role: "user", parts: [{ type: "text", text: "new question" }] })
    expect(store.messages(s.id)).toHaveLength(3)
  })

  test("an older database without the kind column is migrated in place", () => {
    const { Database } = require("bun:sqlite")
    const file = join(mkdtempSync(join(tmpdir(), "ph-db-")), "old.db")
    const db = new Database(file)
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, created INTEGER NOT NULL, updated INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '', root TEXT NOT NULL, model TEXT NOT NULL);
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, json TEXT NOT NULL, created INTEGER NOT NULL);
      INSERT INTO sessions VALUES ('s1', 1, 1, '', '/p', 'x/y');
      INSERT INTO messages (session_id, role, json, created) VALUES ('s1', 'user', '{"role":"user","parts":[{"type":"text","text":"hi"}]}', 1);`)
    db.close()
    const store = new Store(file)
    expect(store.context("s1")).toEqual([{ role: "user", parts: [{ type: "text", text: "hi" }] }])
  })
})

describe("parallel calls", () => {
  test("two edits of one file in one step both land", async () => {
    const dir = setup([
      { chunks: [toolCall(0, "r", "read", '{"path":"f.txt"}')] },
      { chunks: [toolCall(0, "e1", "edit", '{"path":"f.txt","old":"alpha","new":"ALPHA"}'), toolCall(1, "e2", "edit", '{"path":"f.txt","old":"omega","new":"OMEGA"}')] },
      { chunks: [delta({ content: "ok" })] },
    ])
    writeFileSync(join(dir, "f.txt"), "alpha\nmiddle\nomega\n")
    const app = createApp({ cwd: dir, mode: "edit", asker: noAsk, store: false })
    await app.engine.prompt("edit")
    expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("ALPHA\nmiddle\nOMEGA\n")
  })
})

describe("project context", () => {
  test("the system prompt carries git state; a subdirectory's AGENTS.md arrives once with the first read under it", async () => {
    const dir = setup([
      { chunks: [toolCall(0, "c1", "read", '{"path":"pkg/a.ts"}'), toolCall(1, "c2", "read", '{"path":"pkg/b.ts"}')] },
      { chunks: [delta({ content: "ok" })] },
    ])
    Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "first commit"])
    mkdirSync(join(dir, "pkg"))
    writeFileSync(join(dir, "pkg", "AGENTS.md"), "Use tabs in pkg.")
    writeFileSync(join(dir, "pkg", "a.ts"), "export const a = 1\n")
    writeFileSync(join(dir, "pkg", "b.ts"), "export const b = 2\n")
    const app = createApp({ cwd: dir, mode: "edit", asker: noAsk, store: false })
    await app.engine.prompt("look")
    const system = fake!.requests[0].messages[0].content as string
    expect(system).toContain("<git>")
    expect(system).toMatch(/Branch: (main|master)/)
    expect(system).toContain("first commit")
    expect(system).toContain("?? hello.txt")
    const results = fake!.requests[1].messages.filter((m: any) => m.role === "tool").map((m: any) => m.content as string)
    // The two reads run in parallel: whichever gets there first carries it — exactly one does.
    expect(results.filter((r: string) => r.includes("Use tabs in pkg."))).toHaveLength(1)
  })

  test("the system prompt stays byte for byte the same through a session: files created and commits made do not change it", async () => {
    // Its git block changing near the top made llama.cpp's prompt cache useless: the whole
    // conversation read again, minutes of "waiting for the model".
    const dir = setup([
      { chunks: [toolCall(0, "c1", "write", JSON.stringify({ path: "new.txt", content: "x\n" }))] },
      { chunks: [toolCall(0, "c2", "bash", JSON.stringify({ command: "git add -A && git -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -qm second", description: "Commit" }))] },
      { chunks: [delta({ content: "done" })] },
    ])
    const app = createApp({ cwd: dir, mode: "auto", asker: noAsk, store: false })
    await app.engine.prompt("make a file and commit it")
    const systems = fake!.requests.map((r: any) => r.messages[0].content as string)
    expect(systems).toHaveLength(3)
    expect(new Set(systems).size).toBe(1)
    expect(systems[0]).toContain("a snapshot, not kept up to date")
  })
})
