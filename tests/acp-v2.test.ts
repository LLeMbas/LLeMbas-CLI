// `_lembas` protocol 2 (harness/acp.md): @ file search, the command set and /commands over
// ACP, images and files in a prompt, ask_user and plan_submit answered from the web, the model
// event, and turn ids. A fake LLeMbas is the client; the model is a scripted endpoint.
import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AcpAgent, planReplyFrom, questionParams, questionReplyFrom, type Limits } from "../src/acp/agent.ts"
import { formatAnswers } from "../src/tool/ask_user.ts"
import { Hub } from "../src/acp/hub.ts"
import { BLOCK_LIMIT, readBlocks } from "../src/acp/prompt.ts"
import { Peer, type Transport } from "../src/acp/rpc.ts"
import { Share, type LocalAsk } from "../src/acp/share.ts"
import { pruneTurnFiles, turnFile, TurnLog } from "../src/acp/turns.ts"
import { createApp, type App } from "../src/app.ts"
import { paths } from "../src/config/paths.ts"
import { setTrust } from "../src/project/root.ts"
import type { QuestionReply } from "../src/tool/ask_user.ts"
import { delta, fakeProvider, toolCall, type Fake } from "./fake-provider.ts"

let fake: Fake | undefined
const stops: (() => void)[] = []
afterEach(() => {
  fake?.stop()
  for (const s of stops.splice(0).reverse()) s()
})

function pair(): [Transport, Transport] {
  const make = () => ({ msg: (_: string) => {}, end: () => {} })
  const a = make()
  const b = make()
  const side = (me: typeof a, other: typeof a): Transport => ({
    send: (t) => queueMicrotask(() => other.msg(t)),
    onMessage: (fn) => (me.msg = fn),
    onClose: (fn) => (me.end = fn),
    close: () => (me.end(), other.end()),
  })
  return [side(a, b), side(b, a)]
}

function config(url: string, extra = "", model = "{}") {
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  f:\n    dialect: openai-chat\n    base_url: ${url}\n    models: { m: ${model} }\n`, { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), `model: f/m\n${extra}`)
}

function project(files: Record<string, string> = {}): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ph-acp2-")))
  Bun.spawnSync(["git", "init", "-q", dir])
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(dir, f, ".."), { recursive: true })
    writeFileSync(join(dir, f), text)
  }
  setTrust(dir, "trusted")
  return dir
}

const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 300 && !ok(); i++) await Bun.sleep(10)
  if (!ok()) throw new Error(`timed out waiting for ${what}`)
}

const limitsFor = (root: string, extra: Partial<Limits> = {}): Limits => ({ roots: [root], maxMode: "auto", approvalTimeoutMs: 3000, requireTrust: true, ...extra })

/** A fake LLeMbas on one side of the agent. `lembas: false`: an editor that is not LLeMbas. */
/** `protocol`: what the client says it speaks (2 by default; 1 is an older client). */
async function client(limits?: Limits, o: { lembas?: boolean; protocol?: number; instance?: string; hub?: Hub; handlers?: Record<string, (p: any) => unknown> } = {}) {
  const [ta, tb] = pair()
  new AcpAgent(new Peer(ta), limits, o.instance, o.hub)
  const c = new Peer(tb)
  const updates: any[] = []
  const events: any[] = []
  const notes: { method: string; params: any }[] = []
  c.on("session/update", (p) => void updates.push(p))
  c.on("_lembas/event", (p) => void events.push(p))
  c.on("_lembas/permission/settled", (p) => void notes.push({ method: "settled", params: p }))
  c.handle("session/request_permission", () => ({ outcome: { outcome: "selected", optionId: "once" } }))
  for (const [m, fn] of Object.entries(o.handlers ?? {})) c.handle(m, fn)
  const init: any = await c.request("initialize", { protocolVersion: 1, clientCapabilities: o.lembas === false ? {} : { _meta: { lembas: o.protocol === 1 ? true : { protocol: o.protocol ?? 2 } } } })
  return { c, updates, events, notes, init }
}

// §0

test("initialize: protocol 2, the new capabilities, images taken, the login's connection named", async () => {
  fake = fakeProvider([])
  config(fake.url)
  const root = project()
  const { init } = await client(limitsFor(root, { terminal: true }), { instance: "example" })
  expect(init._meta.lembas.protocol).toBe(2)
  for (const cap of ["files", "commands", "attachments", "ask", "plan", "model", "turns", "terminal", "shell"]) expect(init._meta.lembas.capabilities).toContain(cap)
  expect(init.agentCapabilities.promptCapabilities).toEqual({ image: true, audio: false, embeddedContext: true })
  expect(init._meta.lembas.connection).toBe("example")
})

// §1

test("_lembas/files/search: the TUI's index, by session or by directory, gitignored files left out", async () => {
  fake = fakeProvider([])
  config(fake.url)
  const root = project({ "src/router.ts": "x", "src/view.ts": "y", "README.md": "z", "build/out.js": "w", ".gitignore": "build/\n" })
  const { c } = await client(limitsFor(root))
  const byDir: any = await c.request("_lembas/files/search", { cwd: root, query: "rout" })
  expect(byDir.root).toBe(root)
  expect(byDir.files[0]).toEqual({ path: "src/router.ts", kind: "file" })
  const dirs: any = await c.request("_lembas/files/search", { cwd: root, query: "src" })
  expect(dirs.files).toContainEqual({ path: "src", kind: "dir" })
  const ignored: any = await c.request("_lembas/files/search", { cwd: root, query: "out.js" })
  expect(ignored.files.map((f: any) => f.path)).not.toContain("build/out.js")
  const s: any = await c.request("session/new", { cwd: root })
  const bySession: any = await c.request("_lembas/files/search", { sessionId: s.sessionId, query: "view", limit: 1 })
  expect(bySession.files).toEqual([{ path: "src/view.ts", kind: "file" }])
  // Outside the device's roots: refused, as session/new is.
  await expect(c.request("_lembas/files/search", { cwd: tmpdir(), query: "x" })).rejects.toThrow("outside")
  await expect(c.request("_lembas/files/search", { query: "x" })).rejects.toThrow("cwd")
})

// §2

test("the command set: sent after session/new, by request for a directory; TUI-only commands never", async () => {
  fake = fakeProvider([])
  config(fake.url)
  const root = project({ ".agent/config.yaml": "", ".agent/commands/deploy.md": "---\ndescription: ship it\n---\nDeploy $ARGUMENTS now.", ".agent/commands/theme.md": "a custom one named like a built-in" })
  // A global skill, removed afterwards: the suite shares one home, and other files have skills of their own.
  const skillDir = join(paths.config, "skills", "acp-sort-imports")
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: acp-sort-imports\ndescription: sort the imports\n---\nSort them.")
  stops.push(() => rmSync(skillDir, { recursive: true, force: true }))
  const { c, updates } = await client(limitsFor(root))
  const s: any = await c.request("session/new", { cwd: root })
  await until(() => updates.some((u) => u.update.sessionUpdate === "available_commands_update"), "the command set")
  const sent = updates.find((u) => u.update.sessionUpdate === "available_commands_update")
  expect(sent.sessionId).toBe(s.sessionId)
  const names = sent.update.availableCommands.map((x: any) => x.name)
  for (const n of ["compact", "plan", "undo", "review", "changelog", "init", "continue", "deploy", "acp-sort-imports"]) expect(names).toContain(n)
  for (const n of ["theme", "settings", "sessions", "quit", "login"]) expect(names).not.toContain(n)
  expect(sent.update.availableCommands.find((x: any) => x.name === "deploy")).toEqual({ name: "deploy", description: "ship it", input: { hint: "arguments" }, _meta: { lembas: { kind: "custom" } } })
  expect(sent.update.availableCommands.find((x: any) => x.name === "acp-sort-imports")._meta.lembas.kind).toBe("skill")
  const asked: any = await c.request("_lembas/commands", { cwd: root })
  expect(asked.commands.map((x: any) => x.name)).toEqual(names)
})

test("/commands over ACP: a custom command expanded as the TUI would, an unknown one sent as text, /compact done", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "deploying" })] }, { chunks: [delta({ content: "plain" })] }, { chunks: [delta({ content: "the summary" })] }])
  config(fake.url)
  const root = project({ ".agent/config.yaml": "", ".agent/commands/deploy.md": "Deploy $ARGUMENTS now." })
  const { c, events } = await client(limitsFor(root))
  const s: any = await c.request("session/new", { cwd: root })
  const r: any = await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "/deploy staging" }] })
  expect(r._meta.lembas.command).toBe("deploy")
  expect(JSON.stringify(fake.requests[0].messages)).toContain("Deploy staging now.")
  // What the transcript shows is what was typed, not the body.
  expect(events.find((e) => e.event.type === "prompt").event.text).toBe("/deploy staging")
  await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "/etc/hosts is odd" }] })
  expect(JSON.stringify(fake.requests[1].messages)).toContain("/etc/hosts is odd")
  const compacted: any = await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "/compact" }] })
  expect(compacted._meta.lembas).toMatchObject({ command: "compact", summary: "the summary" })
  // A review with nothing to review is said, not sent.
  const review: any = await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "/review" }] })
  expect(review._meta.lembas.message).toContain("nothing to review")
  expect(fake.requests).toHaveLength(3)
})

test("@path in an ACP prompt is attached by the TUI's expander", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "seen" })] }])
  config(fake.url)
  const root = project({ "notes.txt": "the secret word is heron\n" })
  const { c, events } = await client(limitsFor(root))
  const s: any = await c.request("session/new", { cwd: root })
  await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "read @notes.txt please" }] })
  expect(JSON.stringify(fake.requests[0].messages)).toContain("1: the secret word is heron")
  expect(events.find((e) => e.event.type === "prompt").event.attachments).toEqual([{ name: "notes.txt", mimeType: "text/plain", size: 25 }])
})

// §3

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64")

test("an image goes to a vision model as an image, and is a chip in the event and the history", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "a pixel" })] }])
  config(fake.url, "", "{ vision: true }")
  const root = project()
  const { c, events } = await client(limitsFor(root))
  const s: any = await c.request("session/new", { cwd: root })
  await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "what is this?" }, { type: "image", mimeType: "image/png", data: PNG.toString("base64"), uri: "file:///x/shot.png" }] })
  const sent = JSON.stringify(fake.requests[0].messages)
  expect(sent).toContain("image_url")
  expect(sent).toContain("data:image/png;base64,")
  const chips = events.find((e) => e.event.type === "prompt").event.attachments
  expect(chips).toEqual([{ name: "shot.png", mimeType: "image/png", size: PNG.length }])
  const h: any = await c.request("_lembas/session/history", { sessionId: s.sessionId })
  expect(h.turns[0]).toEqual({ role: "user", text: "what is this?", turnId: chipsEvent(events).turnId, attachments: [{ name: "shot.png", mimeType: "image/png", size: PNG.length }] })
  expect(existsSync(join(paths.state, "attachments", s.sessionId))).toBe(true)
  // Deleting the session takes its attachments with it.
  await c.request("_lembas/session/delete", { sessionId: s.sessionId })
  expect(existsSync(join(paths.state, "attachments", s.sessionId))).toBe(false)
})

test("without vision the image is saved and named, a text file attached, a binary one referenced", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "ok" })] }])
  config(fake.url)
  const root = project()
  const { c } = await client(limitsFor(root))
  const s: any = await c.request("session/new", { cwd: root })
  await c.request("session/prompt", {
    sessionId: s.sessionId,
    prompt: [
      { type: "image", mimeType: "image/png", data: PNG.toString("base64") },
      { type: "resource", resource: { uri: "file:///home/u/todo.md", mimeType: "text/markdown", text: "- buy bread" } },
      { type: "resource", resource: { uri: "file:///home/u/blob.bin", mimeType: "application/octet-stream", blob: Buffer.from([0, 1, 2, 0]).toString("base64") } },
    ],
  })
  const sent = JSON.stringify(fake.requests[0].messages)
  expect(sent).toContain("not attached: this model has no vision")
  expect(sent).toContain("image-1.png")
  expect(sent).toContain("1: - buy bread")
  expect(sent).toContain("binary file, 4 bytes")
  expect(sent).not.toContain("image_url")
})

test("limits: 10 MB a block, 25 MB a prompt, said in a sentence", () => {
  const big = Buffer.alloc(BLOCK_LIMIT + 10).toString("base64")
  expect(() => readBlocks([{ type: "image", mimeType: "image/png", data: big }])).toThrow("larger than 10 MB")
  const nine = Buffer.alloc(9 * 1024 * 1024).toString("base64")
  expect(() => readBlocks([1, 2, 3].map(() => ({ type: "resource", resource: { uri: "a.bin", blob: nine } })))).toThrow("more than 25 MB")
  expect(() => readBlocks([{ type: "image", mimeType: "image/bmp", data: "AA==" }])).toThrow("PNG, JPEG, WebP or GIF")
})

const chipsEvent = (events: any[]) => events.find((e) => e.event.type === "prompt").event

test("history: each user turn carries its turn id — the web UI's, or one made for a terminal's turn", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "web" })] }, { chunks: [delta({ content: "typed" })] }])
  const root = project()
  config(fake.url)
  const { c, heard } = await linkedHub(limitsFor(root), {})
  const s: any = await c.request("session/new", { cwd: root })
  await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "from the web" }], _meta: { lembas: { turnId: "W7" } } })
  // The same session carried on in a terminal: its typed turn has an id of its own.
  const { releaseForResume } = await import("../src/acp/share.ts")
  const { app, share } = await terminal(root, () => ({ reply: new Promise(() => {}), dismiss: () => {} }))
  expect(await releaseForResume(s.sessionId)).toBeUndefined()
  app.resume(s.sessionId)
  await until(() => share.sharedId === s.sessionId, "shared")
  await app.turns.prompt("typed here")
  const h: any = await c.request("_lembas/session/history", { sessionId: s.sessionId })
  const users = h.turns.filter((t: any) => t.role === "user")
  expect(users[0]).toMatchObject({ text: "from the web", turnId: "W7" })
  expect(users[1].turnId).toMatch(/^[0-9a-f-]{36}$/)
  expect(heard.length).toBeGreaterThan(0)
})

// §4

const ASK = JSON.stringify({ questions: [{ header: "DB", question: "Which database?", options: [{ label: "SQLite", recommended: true }, { label: "Postgres" }] }] })

test("ask_user in a session held here is asked of LLeMbas, and its answer reaches the model", async () => {
  fake = fakeProvider([{ chunks: [toolCall(0, "q1", "ask_user", ASK)] }, { chunks: [delta({ content: "Postgres it is" })] }])
  config(fake.url)
  const root = project()
  let asked: any
  const { c } = await client(limitsFor(root), {
    handlers: {
      "_lembas/question": (p) => {
        asked = p
        return { outcome: "answered", answers: [{ kind: "options", labels: ["Postgres"] }] }
      },
    },
  })
  const s: any = await c.request("session/new", { cwd: root })
  await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "set it up" }] })
  expect(asked).toMatchObject({ sessionId: s.sessionId, toolCallId: "q1", questions: [{ header: "DB", question: "Which database?" }] })
  const result = fake.requests[1].messages.find((m: any) => m.role === "tool")
  expect(result.content).toContain("→ Postgres")
})

test("plan_submit is asked of LLeMbas with the plan written, its text and its file; approving moves the session to the mode chosen", async () => {
  const PLAN = { title: "The plan", summary: "One change.", phases: [{ title: "Work", tasks: ["do it"] }] }
  fake = fakeProvider([{ chunks: [toolCall(0, "w1", "plan_write", JSON.stringify(PLAN))] }, { chunks: [toolCall(0, "p1", "plan_submit", "{}")] }, { chunks: [delta({ content: "implementing" })] }])
  config(fake.url, "mode: plan\n")
  const root = project({ ".agent/config.yaml": "" })
  let asked: any
  const { c, events, updates } = await client(limitsFor(root, { maxMode: "edit" }), {
    handlers: {
      "_lembas/plan": (p) => {
        asked = p
        return { outcome: "approve", mode: "edit" }
      },
    },
  })
  const s: any = await c.request("session/new", { cwd: root, _meta: { mode: "plan" } })
  await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "plan it" }] })
  const text = "# The plan\nOne change.\n## p1 Work (pending)\n[t1] [ ] do it"
  expect(asked).toMatchObject({ toolCallId: "p1", text, plan: { version: 2, title: "The plan", steps: ["do it"] } })
  // The copy for the record, under the project's plans directory, named by the day and the title.
  expect(asked.path).toMatch(/^\.agent\/plans\/\d{4}-\d{2}-\d{2}-the-plan\.md$/)
  expect(readFileSync(join(root, asked.path), "utf8")).toBe(text + "\n")
  expect(events.some((e) => e.event.type === "mode" && e.event.mode === "edit")).toBe(true)
  expect(fake.requests[2].messages.filter((m: any) => m.role === "tool").at(-1).content).toContain("approved the plan")
  // The plan travels as a structure too (capability plan_state): on the update, beside ACP's entries.
  const update = updates.find((u) => u.update.sessionUpdate === "plan")
  expect(update.update.entries).toEqual([{ content: "do it", status: "pending", priority: "medium" }])
  expect(update.update._meta.lembas.plan).toMatchObject({ version: 2, title: "The plan", phases: [{ id: "p1", tasks: [{ id: "t1", text: "do it", status: "todo" }] }] })
  expect((await c.request<any>("_lembas/session/status", { sessionId: s.sessionId })).plan).toMatchObject({ title: "The plan" })
})

// §5 — harness spec 1.1.0: what only the client knows, the plan as a structure, rewinding.

test("initialize lists the 1.1.0 capabilities", async () => {
  fake = fakeProvider([])
  config(fake.url)
  const { init } = await client(limitsFor(project()))
  for (const cap of ["context", "library", "prototypes", "plan_state", "rewind"]) expect(init._meta.lembas.capabilities).toContain(cap)
})

test("the context reaches the prompt: the instance's instructions, its personalization, the library's scope, prototypes", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "one" })] }, { chunks: [delta({ content: "two" })] }, { chunks: [delta({ content: "three" })] }])
  config(fake.url, "personality: concise\ninstructions: local words\n")
  const root = project()
  const { c } = await client(limitsFor(root), { instance: "example" })
  const context = {
    system_prompt: "Answer in Slovak.",
    personalization: { personality: "formal", personality_custom: "", instructions: "Call me Jaro." },
    library: { bases: [{ id: "kb1", name: "Manuals" }, { id: "kb2", name: "Contracts" }] },
    prototypes: { offered: true, sources: "The page may load nothing from the network." },
  }
  const s: any = await c.request("session/new", { cwd: root, _meta: { lembas: context } })
  await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "hi" }] })
  const system = () => fake!.requests.at(-1)!.messages[0].content as string
  expect(system()).toContain("## Instructions from example\n\nAnswer in Slovak.")
  // The account's personalization, in place of the device's own.
  expect(system()).toContain("## How the person you are talking to wants to be helped\n\nCall me Jaro.")
  expect(system()).not.toContain("local words")
  expect(system()).toContain("## Personality\n\n")
  expect(system()).toContain("formal")
  // Prototypes offered, with what a page may load and where it is seen from a terminal.
  expect(system()).toContain("prototype-chat")
  expect(system()).toContain("The page may load nothing from the network.")
  expect(system()).toContain("It is saved as a file you can open, and the LLeMbas web UI renders it live.")
  // The library's scope is named only where its tools are offered (none here: no local base, no
  // instance library) — nothing unfilled reaches the model either way.
  expect(system()).not.toContain("{{")
  // A later prompt replaces the context: personalization back to the device's, nothing from the instance.
  await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "again" }], _meta: { lembas: { turnId: "T2", system_prompt: "", personalization: null, prototypes: { offered: false, sources: "" } } } })
  expect(system()).not.toContain("Instructions from example")
  expect(system()).toContain("local words")
  expect(system()).not.toContain("prototype-chat")
  // A prompt that says only its turn id changes nothing.
  await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "more" }], _meta: { lembas: { turnId: "T3" } } })
  expect(system()).toContain("local words")
})

test("the plan is sent after a session is opened from the store, and cleared with plan: null", async () => {
  fake = fakeProvider([{ chunks: [toolCall(0, "w1", "plan_write", JSON.stringify({ title: "Kept", phases: [{ title: "P", tasks: ["a"] }] }))] }, { chunks: [delta({ content: "ok" })] }])
  config(fake.url)
  const root = project()
  const first = await client(limitsFor(root))
  const s: any = await first.c.request("session/new", { cwd: root })
  await first.c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "plan" }] })
  // A new link: the session opened from the store says its plan before anything changes it.
  const again = await client(limitsFor(root))
  expect((await again.c.request<any>("_lembas/session/status", { sessionId: s.sessionId })).plan).toMatchObject({ title: "Kept" })
  await again.c.request("_lembas/session/status", { sessionId: s.sessionId })
  await again.c.request("_lembas/configure", { sessionId: s.sessionId })
  await until(() => again.updates.some((u) => u.update.sessionUpdate === "plan"), "the plan update")
  expect(again.updates.find((u) => u.update.sessionUpdate === "plan").update._meta.lembas.plan).toMatchObject({ title: "Kept" })
  // /plan clear from the web UI? Not a command; the session's own clearing says plan: null.
  await again.c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "/undo" }] })
})

test("rewind: the turn and every later one leave the conversation; the next prompt does not see them; files stay", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "first answer" })] }, { chunks: [delta({ content: "second answer" })] }, { chunks: [delta({ content: "third answer" })] }, { chunks: [delta({ content: "after the rewind" })] }])
  config(fake.url)
  const root = project()
  const { c } = await client(limitsFor(root))
  const s: any = await c.request("session/new", { cwd: root })
  const prompt = (text: string, turnId: string) => c.request<any>("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text }], _meta: { lembas: { turnId } } })
  await prompt("one", "T1")
  await prompt("two", "T2")
  await prompt("three", "T3")
  writeFileSync(join(root, "made.txt"), "by the second turn\n")
  await expect(c.request("_lembas/session/rewind", { sessionId: s.sessionId, turnId: "nope" })).rejects.toThrow("no turn")
  expect(await c.request<any>("_lembas/session/rewind", { sessionId: s.sessionId, turnId: "T2" })).toEqual({ reverted: 2 })
  // Gone from the history and from what the model is sent; the file is as it was.
  const h: any = await c.request("_lembas/session/history", { sessionId: s.sessionId })
  expect(h.turns.filter((t: any) => t.role === "user").map((t: any) => t.text)).toEqual(["one"])
  await prompt("four", "T4")
  const sent = JSON.stringify(fake.requests[3].messages)
  expect(sent).toContain("first answer")
  expect(sent).not.toContain("second answer")
  expect(sent).not.toContain("third answer")
  expect(readFileSync(join(root, "made.txt"), "utf8")).toBe("by the second turn\n")
  // A session opened from the store (nothing in memory): rewound by its rows.
  const again = await client(limitsFor(root))
  expect(await again.c.request<any>("_lembas/session/rewind", { sessionId: s.sessionId, turnId: "T1" })).toEqual({ reverted: 2 })
  const after: any = await again.c.request("_lembas/session/history", { sessionId: s.sessionId })
  expect(after.turns).toEqual([])
})

test("a client that is not LLeMbas gets no question card: ask_user says nobody can be asked", async () => {
  fake = fakeProvider([{ chunks: [toolCall(0, "q1", "ask_user", ASK)] }, { chunks: [delta({ content: "assumed" })] }])
  config(fake.url)
  const root = project()
  let asked = 0
  const { c } = await client(undefined, { lembas: false, handlers: { "_lembas/question": () => (asked++, {}) } })
  const s: any = await c.request("session/new", { cwd: root })
  await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "go" }] })
  expect(asked).toBe(0)
  expect(fake.requests[1].messages.find((m: any) => m.role === "tool").content).toContain("Nobody can be asked")
})

test("a question nobody answers in time is dismissed, and the card taken down", async () => {
  fake = fakeProvider([{ chunks: [toolCall(0, "q1", "ask_user", ASK)] }, { chunks: [delta({ content: "assumed" })] }])
  config(fake.url)
  const root = project()
  const { c, notes } = await client(limitsFor(root, { approvalTimeoutMs: 100 }), { handlers: { "_lembas/question": () => new Promise(() => {}) } })
  const s: any = await c.request("session/new", { cwd: root })
  await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "go" }] })
  expect(fake.requests[1].messages.find((m: any) => m.role === "tool").content).toContain("dismissed")
  expect(notes).toContainEqual({ method: "settled", params: { sessionId: s.sessionId, toolCallId: "q1" } })
})

test("the answers read leniently and safely", () => {
  const req = { questions: [{ header: "a", question: "a?", options: [] }] }
  expect(questionReplyFrom({ outcome: "answered", answers: [{ kind: "custom", text: "mine" }] }, req)).toEqual({ answers: [{ kind: "custom", text: "mine" }] })
  expect(questionReplyFrom({ outcome: "answered", answers: [{ kind: "weird" }] }, req)).toEqual({ dismissed: true })
  expect(questionReplyFrom({ outcome: "dismissed" }, req)).toEqual({ dismissed: true })
  // A question left blank skips that one only; the answers beside it are kept.
  const three = { questions: ["a", "b", "c"].map((h) => ({ header: h, question: `${h}?`, options: [] })) }
  for (const blank of [{ kind: "skipped" }, null]) {
    const r: any = questionReplyFrom({ outcome: "answered", answers: [{ kind: "custom", text: "x" }, blank, { kind: "options", labels: ["y"] }] }, three)
    expect(r.dismissed).toBeUndefined()
    expect(r.answers[0]).toEqual({ kind: "custom", text: "x" })
    expect(r.answers[1]).toBeUndefined()
    expect(r.answers[2]).toEqual({ kind: "options", labels: ["y"] })
    expect(formatAnswers(three, r)).toContain("→ (no answer)")
  }
  expect(planReplyFrom({ outcome: "approve", mode: "edit" }, "manual")).toEqual({ kind: "approve", mode: "manual" })
  expect(planReplyFrom({ outcome: "approve", mode: "edit" }, "auto")).toEqual({ kind: "approve", mode: "edit" })
  expect(planReplyFrom({ outcome: "approve", mode: "manual" }, "plan")).toEqual({ kind: "dismissed" })
  expect(planReplyFrom({ outcome: "revise", feedback: " smaller " })).toEqual({ kind: "revise", feedback: "smaller" })
})

// §4 through the hub: a terminal's session, first answer wins.

async function linkedHub(limits: Limits, handlers: Record<string, (p: any) => unknown>, instance?: string) {
  const hub = new Hub({ service: true, limits: { ...limits, enabled: true } })
  expect(await hub.listen()).toBe(true)
  stops.push(() => hub.close())
  const r = await client(limits, { hub, handlers, instance })
  const heard: { method: string; params: any }[] = []
  r.c.on("_lembas/session/announce", (p) => void heard.push({ method: "announce", params: p }))
  return { ...r, hub, heard }
}

async function terminal(root: string, question: (req: any) => LocalAsk<QuestionReply>, seen: { mode?: string }[] = [], cwd = root) {
  let share: Share | undefined
  const app: App = createApp({
    cwd,
    modelTitles: false,
    asker: {
      ask: async () => ({ kind: "once" }),
      question: (req, callId) => (share ? share.question(req, callId, question(req)) : question(req).reply),
    },
  })
  share = new Share(app, {
    prompt: (r, started) => (started(), seen.push({ mode: r.mode }), app.turns.prompt(r.prompt, r.extra, r.shown, { turnId: r.turnId, attachments: r.attachments })),
    compact: () => app.engine.compact(),
    deleted: () => app.newSession(),
    notice: () => {},
    changed: () => {},
  })
  const s = share
  stops.push(() => s.close())
  await s.start()
  return { app, share: s }
}

test("a terminal's ask_user: asked in the web UI too; its answer takes the terminal's card down", async () => {
  fake = fakeProvider([{ chunks: [toolCall(0, "q9", "ask_user", ASK)] }, { chunks: [delta({ content: "done" })] }])
  const root = project()
  config(fake.url)
  let asked: any
  const { heard } = await linkedHub(limitsFor(root), {
    "_lembas/question": async (p) => {
      asked = p
      return { outcome: "answered", answers: [{ kind: "options", labels: ["SQLite"] }] }
    },
  })
  let dismissed: QuestionReply | undefined
  const { app } = await terminal(root, () => ({ reply: new Promise(() => {}), dismiss: (r) => void (dismissed = r) }))
  await until(() => heard.length > 0, "the announcement")
  await app.turns.prompt("ask me")
  expect(asked).toMatchObject({ toolCallId: "q9", _meta: { lembas: { patient: true } } })
  expect(dismissed).toEqual({ answers: [{ kind: "options", labels: ["SQLite"] }] })
  expect(fake.requests[1].messages.find((m: any) => m.role === "tool").content).toContain("SQLite")
})

test("answered at the terminal first: the web UI's card is settled", async () => {
  fake = fakeProvider([{ chunks: [toolCall(0, "q8", "ask_user", ASK)] }, { chunks: [delta({ content: "done" })] }])
  const root = project()
  config(fake.url)
  const { heard, notes } = await linkedHub(limitsFor(root), { "_lembas/question": () => new Promise(() => {}) })
  const { app } = await terminal(root, () => ({ reply: Bun.sleep(30).then(() => ({ answers: [{ kind: "custom" as const, text: "typed here" }] })), dismiss: () => {} }))
  await until(() => heard.length > 0, "the announcement")
  await app.turns.prompt("ask me")
  await until(() => notes.length > 0, "the settled notification")
  expect(notes[0]!.params.toolCallId).toBe("q8")
})

// §6

test("the model event: said whenever the model or effort changes, forwarded to LLeMbas", async () => {
  fake = fakeProvider([])
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  example:\n    dialect: openai-chat\n    base_url: ${fake.url}\n    models: { a: { efforts: [low, high] }, b: {} }\n`, { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), "model: example/a\n")
  const root = project()
  const { c, events } = await client(limitsFor(root), { instance: "example" })
  const s: any = await c.request("session/new", { cwd: root })
  await c.request("_lembas/configure", { sessionId: s.sessionId, model: "b" })
  await c.request("_lembas/configure", { sessionId: s.sessionId, model: "a", effort: "high" })
  await until(() => events.filter((e) => e.event.type === "model").length >= 2, "two model events")
  const models = events.filter((e) => e.event.type === "model").map((e) => e.event)
  // `instance`: the model is spoken to through the connection this link's instance is.
  expect(models[0]).toEqual({ type: "model", ref: "example/b", effort: "off", connection: "example", instance: true })
  expect(models.at(-1)).toEqual({ type: "model", ref: "example/a", effort: "high", connection: "example", instance: true })
})

// §7

test("turn ids: a prompt sent twice runs once, and both answers are the original's", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "slow " }), delta({ content: "reply" })], gapMs: 100 }, { chunks: [delta({ content: "second" })] }])
  config(fake.url)
  const root = project()
  const { c, events } = await client(limitsFor(root))
  const s: any = await c.request("session/new", { cwd: root })
  const prompt = (text: string, turnId: string) => c.request<any>("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text }], _meta: { lembas: { turnId } } })
  const one = prompt("hello", "T1")
  await Bun.sleep(20)
  const again = prompt("hello", "T1")
  const two = prompt("next", "T2")
  await Bun.sleep(20)
  const status: any = await c.request("_lembas/session/status", { sessionId: s.sessionId })
  expect(status).toMatchObject({ busy: true, turnId: "T1", queued: ["T2"] })
  const [a, b] = await Promise.all([one, again])
  expect(a).toEqual(b)
  expect(a._meta.lembas.turnId).toBe("T1")
  await two
  // Finished: answered at once, nothing sent to the model.
  expect(await prompt("hello", "T1")).toEqual(a)
  expect(fake.requests).toHaveLength(2)
  const after: any = await c.request("_lembas/session/status", { sessionId: s.sessionId })
  expect(after).toMatchObject({ busy: false, queued: [], lastTurnId: "T2" })
  expect(after.turnId).toBeUndefined()
  // Every turn's events carry its id.
  expect(events.filter((e) => e.event.type === "prompt").map((e) => e.event.turnId)).toEqual(["T1", "T2"])
  expect(events.filter((e) => e.event.type === "task").map((e) => `${e.event.state}:${e.event.turnId}`)).toEqual(["start:T1", "end:T1", "start:T2", "end:T2"])
})

test("TurnLog keeps 200 ids, never forgetting one that has not finished", async () => {
  const log = new TurnLog<number>()
  let release!: () => void
  const blocked = log.run("first", (started) => (started(), new Promise<number>((r) => (release = () => r(1)))))
  for (let i = 0; i < 250; i++) await log.run(`t${i}`, async (started) => (started(), i))
  expect(log.has("first")).toBe(true)
  expect(log.has("t0")).toBe(false)
  expect(log.has("t249")).toBe(true)
  release()
  expect(await blocked).toBe(1)
  expect(log.state("first")).toBe("done")
})

test("a turn typed in a terminal has an id of its own, on its events and in the status", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "typed" })] }])
  const root = project()
  config(fake.url)
  const { heard, events, c, updates } = await linkedHub(limitsFor(root), {})
  const { app } = await terminal(root, () => ({ reply: new Promise(() => {}), dismiss: () => {} }))
  await until(() => heard.length > 0, "the announcement")
  // Its command set reaches the web UI too, from the terminal through the hub.
  await until(() => updates.some((u) => u.sessionId === app.engine.sessionId && u.update.sessionUpdate === "available_commands_update"), "the terminal's command set")
  await app.turns.prompt("from the keyboard")
  const id = app.engine.sessionId!
  await until(() => events.some((e) => e.event.type === "task" && e.event.state === "end"), "the end of the turn")
  const start = events.find((e) => e.event.type === "task" && e.event.state === "start").event
  expect(start.turnId).toMatch(/^[0-9a-f-]{36}$/)
  const status: any = await c.request("_lembas/session/status", { sessionId: id })
  expect(status).toMatchObject({ held: "terminal", busy: false, lastTurnId: start.turnId, queued: [] })
})

test("the shared command set agrees with the TUI: every name it reserves, every description it shows", async () => {
  const { COMMANDS } = await import("../src/tui/commands.ts")
  const { SHARED_BUILTINS, TUI_COMMAND_NAMES } = await import("../src/session/commands.ts")
  const names = COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])])
  expect([...TUI_COMMAND_NAMES].sort()).toEqual(names.sort() as typeof TUI_COMMAND_NAMES[number][])
  for (const b of SHARED_BUILTINS) expect(COMMANDS.find((c) => c.name === b.name)?.description).toBe(b.description)
})

test("turn ids outlive a restart of the service: a finished turn is not run again by a new link", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "once" })] }, { chunks: [delta({ content: "never" })] }])
  config(fake.url)
  const root = project()
  const first = await client(limitsFor(root))
  const s: any = await first.c.request("session/new", { cwd: root })
  const a: any = await first.c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "hi" }], _meta: { lembas: { turnId: "R1" } } })
  // A new agent: nothing in memory, the session opened from the store.
  const again = await client(limitsFor(root))
  const status: any = await again.c.request("_lembas/session/status", { sessionId: s.sessionId })
  expect(status).toMatchObject({ exists: true, held: "none", lastTurnId: "R1" })
  const b: any = await again.c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "hi" }], _meta: { lembas: { turnId: "R1" } } })
  expect(b).toEqual(a)
  expect(fake.requests).toHaveLength(1)
  const after: any = await again.c.request("_lembas/session/status", { sessionId: s.sessionId })
  expect(after.lastTurnId).toBe("R1")
})

// Audit fixes.

test("a protocol-1 LLeMbas (2.1.0) gets no question card; a client that lacks the method falls back", async () => {
  const ASK1 = JSON.stringify({ questions: [{ header: "DB", question: "Which?", options: [{ label: "A" }, { label: "B" }] }] })
  fake = fakeProvider([{ chunks: [toolCall(0, "q1", "ask_user", ASK1)] }, { chunks: [delta({ content: "x" })] }, { chunks: [toolCall(0, "q2", "ask_user", ASK1)] }, { chunks: [delta({ content: "y" })] }])
  config(fake.url)
  const root = project()
  let asked = 0
  const old = await client(limitsFor(root), { protocol: 1, handlers: { "_lembas/question": () => (asked++, {}) } })
  const s: any = await old.c.request("session/new", { cwd: root })
  await old.c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "go" }] })
  expect(asked).toBe(0)
  expect(fake.requests[1].messages.find((m: any) => m.role === "tool").content).toContain("Nobody can be asked")
  // Says 2, has no such method: method-not-found is nobody to ask, not a dismissal.
  const liar = await client(limitsFor(root))
  const t: any = await liar.c.request("session/new", { cwd: root })
  await liar.c.request("session/prompt", { sessionId: t.sessionId, prompt: [{ type: "text", text: "go" }] })
  expect(fake.requests[3].messages.find((m: any) => m.role === "tool").content).toContain("Nobody can be asked")
})

test("an @path from the web is attached only inside the session's project and the device's roots", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "ok" })] }])
  config(fake.url)
  const root = project({ "inside.txt": "INSIDE-OK\n" })
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "ph-outside-")))
  writeFileSync(join(outside, "secret.txt"), "TOP-SECRET-OUTSIDE\n")
  // A link inside the project to the file outside is outside.
  Bun.spawnSync(["ln", "-s", join(outside, "secret.txt"), join(root, "link.txt")])
  const { c, events } = await client(limitsFor(root))
  const s: any = await c.request("session/new", { cwd: root })
  const rel = join("..", outside.split("/").pop()!, "secret.txt")
  await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: `look @${outside}/secret.txt @${rel} @link.txt @inside.txt` }] })
  const sent = JSON.stringify(fake.requests[0].messages)
  expect(sent).not.toContain("TOP-SECRET-OUTSIDE")
  expect(sent).toContain("1: INSIDE-OK")
  // Left as text, and not counted as read.
  expect(sent).toContain(`@${outside}/secret.txt`)
  expect(events.find((e) => e.event.type === "prompt").event.attachments.map((a: any) => a.name)).toEqual(["inside.txt"])
})

test("two uploads of one name in one prompt are two files", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "ok" })] }])
  config(fake.url)
  const root = project()
  const { c } = await client(limitsFor(root))
  const s: any = await c.request("session/new", { cwd: root })
  await c.request("session/prompt", {
    sessionId: s.sessionId,
    prompt: [
      { type: "text", text: "compare" },
      { type: "resource", resource: { uri: "file:///a/notes.txt", text: "FIRST-FILE" } },
      { type: "resource", resource: { uri: "file:///b/notes.txt", text: "SECOND-FILE" } },
    ],
  })
  const sent = JSON.stringify(fake.requests[0].messages)
  expect(sent).toContain("FIRST-FILE")
  expect(sent).toContain("SECOND-FILE")
  const h: any = await c.request("_lembas/session/history", { sessionId: s.sessionId })
  expect(h.turns[0].attachments.map((a: any) => a.name)).toEqual(["notes.txt", "notes.txt"])
})

test("one turn log for the terminal and the service: a turn is not run twice across a handover, either way", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "on the service" })] }, { chunks: [delta({ content: "in the terminal" })] }, { chunks: [delta({ content: "never" })] }])
  const root = project()
  config(fake.url)
  const { c, hub, heard } = await linkedHub(limitsFor(root), {})
  // Service first: the web UI's turn S1 runs in the service.
  const s: any = await c.request("session/new", { cwd: root })
  const a: any = await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "one" }], _meta: { lembas: { turnId: "S1" } } })
  // A terminal takes it over; S1 again is the service's answer, not a second run.
  const { releaseForResume } = await import("../src/acp/share.ts")
  const { app, share } = await terminal(root, () => ({ reply: new Promise(() => {}), dismiss: () => {} }))
  expect(await releaseForResume(s.sessionId)).toBeUndefined()
  app.resume(s.sessionId)
  await until(() => share.sharedId === s.sessionId, "shared")
  expect(await c.request<any>("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "one" }], _meta: { lembas: { turnId: "S1" } } })).toEqual(a)
  expect((await c.request<any>("_lembas/session/status", { sessionId: s.sessionId })).lastTurnId).toBe("S1")
  // T1 runs in the terminal; the terminal goes; T1 again is not run by the service.
  const b: any = await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "two" }], _meta: { lembas: { turnId: "T1" } } })
  share.close()
  await until(() => !hub.shared.has(s.sessionId), "the terminal leaving")
  expect((await c.request<any>("_lembas/session/status", { sessionId: s.sessionId })).lastTurnId).toBe("T1")
  expect(await c.request<any>("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "two" }], _meta: { lembas: { turnId: "T1" } } })).toEqual(b)
  expect(fake.requests).toHaveLength(2)
  expect(heard.length).toBeGreaterThan(0)
})

test("turn files: a damaged one is empty, writes are whole, old ones go", () => {
  const dir = join(paths.state, "turns-test")
  mkdirSync(dir, { recursive: true })
  const f = join(dir, "s.json")
  for (const bad of ["[null]", "{", "[[1,2],[\"\",{}]]", "\"x\""]) {
    writeFileSync(f, bad)
    expect(() => new TurnLog(turnFile(f))).not.toThrow()
    expect(new TurnLog(turnFile(f)).last).toBeUndefined()
  }
  writeFileSync(f, JSON.stringify([["ok", { stopReason: "end_turn" }], null]))
  expect(new TurnLog(turnFile(f)).has("ok")).toBe(true)
  // Merged with what the other process wrote, newest last, at most 200.
  const store = turnFile<number>(f)
  store.save(Array.from({ length: 250 }, (_, i) => [`t${i}`, i] as [string, number]))
  const kept = store.load()
  expect(kept).toHaveLength(200)
  expect(kept.at(-1)).toEqual(["t249", 249])
  expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([])
  // A file not written for longer than the limit goes.
  const old = join(dir, "old.json")
  writeFileSync(old, "[]")
  utimesSync(old, new Date(0), new Date(0))
  pruneTurnFiles(dir, 30)
  expect(existsSync(old)).toBe(false)
  expect(existsSync(f)).toBe(true)
  rmSync(dir, { recursive: true, force: true })
})

test("a command's mode from the web is clamped to remote.max_mode in a terminal shared under the limits", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "ok" })] }])
  const root = project()
  config(fake.url, "remote:\n  max_mode: manual\n")
  const cmdDir = join(paths.config, "commands")
  mkdirSync(cmdDir, { recursive: true })
  writeFileSync(join(cmdDir, "loose.md"), "---\nmode: auto\n---\nDo it all.")
  stops.push(() => rmSync(join(cmdDir, "loose.md"), { force: true }))
  const { c, heard } = await linkedHub(limitsFor(root), {})
  const seen: { mode?: string }[] = []
  const { app } = await terminal(root, () => ({ reply: new Promise(() => {}), dismiss: () => {} }), seen)
  await until(() => heard.length > 0, "the announcement")
  await c.request("session/prompt", { sessionId: app.engine.sessionId, prompt: [{ type: "text", text: "/loose" }] })
  expect(seen).toEqual([{ mode: "manual" }])
})

test("a command naming a model gives the session its model and its effort back afterwards", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "ok" })] }])
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  f:\n    dialect: openai-chat\n    base_url: ${fake.url}\n    models: { m: { efforts: [low, high], effort: low }, other: {} }\n`, { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), "model: f/m\n")
  const root = project({ ".agent/config.yaml": "", ".agent/commands/quick.md": "---\nmodel: f/other\n---\nQuick." })
  const { c } = await client(limitsFor(root))
  const s: any = await c.request("session/new", { cwd: root, _meta: { effort: "high" } })
  await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "/quick" }] })
  expect(fake.requests[0].model).toBe("other")
  expect(await c.request<any>("_lembas/configure", { sessionId: s.sessionId })).toEqual({ model: "f/m", effort: "high" })
})

test("a terminal started in a subdirectory: files/search answers from where @ mentions are read", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "ok" })] }])
  const root = project({ "pkg/src/deep.ts": "export const deep = 1\n", "top.ts": "x" })
  // The device's roots: a web prompt's @path is read only inside them.
  config(fake.url, `remote:\n  enabled: true\n  roots: [${root}]\n`)
  const { c, heard } = await linkedHub(limitsFor(root), {})
  const { app } = await terminal(root, () => ({ reply: new Promise(() => {}), dismiss: () => {} }), [], join(root, "pkg"))
  await until(() => heard.length > 0, "the announcement")
  // The project is the repository's root; the terminal works in pkg/.
  expect(heard[0]!.params.cwd).toBe(root)
  const r: any = await c.request("_lembas/files/search", { sessionId: app.engine.sessionId, query: "deep" })
  expect(r.root).toBe(join(root, "pkg"))
  expect(r.files[0]).toEqual({ path: "src/deep.ts", kind: "file" })
  // And that path, sent back as @path, is the file.
  await c.request("session/prompt", { sessionId: app.engine.sessionId, prompt: [{ type: "text", text: `see @${r.files[0].path}` }] })
  expect(JSON.stringify(fake.requests[0].messages)).toContain("1: export const deep = 1")
})

test("@ mentions: a space and a # in a name are escaped with a backslash; a bare # is a line range", async () => {
  const { attachmentsFor, escapeMention } = await import("../src/project/attach.ts")
  const root = project({ "my notes.md": "spaced\n", "a#b.md": "hashed\n", "c.md": "one\ntwo\nthree\n" })
  const ctx = { root, cwd: root, readFiles: new Set<string>(), fileStamps: new Map<string, number>() }
  expect(escapeMention("my notes.md")).toBe("my\\ notes.md")
  expect(escapeMention("a#b.md")).toBe("a\\#b.md")
  const got = attachmentsFor(`@${escapeMention("my notes.md")} @${escapeMention("a#b.md")} @c.md#2-3`, ctx)
  expect(got.map((a) => a.path)).toEqual(["my notes.md", "a#b.md", "c.md"])
  expect(got[0]!.text).toContain("1: spaced")
  expect(got[1]!.text).toContain("1: hashed")
  expect(got[2]!.text).toContain("2: two\n3: three")
})

test("option labels go to the card at most 240 characters long; the model gets the whole one chosen", () => {
  const long = "x".repeat(300)
  const req = { questions: [{ header: "h", question: "q?", options: [{ label: long }, { label: "short" }] }] }
  const p = questionParams("s", req, "c")
  expect(p.questions[0]!.options[0]!.label).toHaveLength(240)
  expect(req.questions[0]!.options[0]!.label).toHaveLength(300)
  expect(questionReplyFrom({ outcome: "answered", answers: [{ kind: "options", labels: [long.slice(0, 240)] }] }, req)).toEqual({ answers: [{ kind: "options", labels: [long] }] })
})

test("a terminal's session is announced with whether its model is this link's instance's", async () => {
  fake = fakeProvider([])
  const root = project()
  config(fake.url)
  // The link's instance is the connection the session's model is on (`f`), then one it is not.
  const one = await linkedHub(limitsFor(root), {}, "f")
  const t = await terminal(root, () => ({ reply: new Promise(() => {}), dismiss: () => {} }))
  await until(() => one.heard.length > 0, "the announcement")
  expect(one.heard[0]!.params).toMatchObject({ model: "f/m", instance: true })
  t.share.close()
  for (const s of stops.splice(0).reverse()) s()
  const two = await linkedHub(limitsFor(root), {}, "example")
  await terminal(root, () => ({ reply: new Promise(() => {}), dismiss: () => {} }))
  await until(() => two.heard.length > 0, "the announcement")
  expect(two.heard[0]!.params).toMatchObject({ model: "f/m", instance: false })
})
