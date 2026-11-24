// An editor as the client (harness/acp.md, spec 3.11.0): autocomplete, the rewrite of a selection,
// the editor block of a prompt, unsaved text through ACP's fs methods, edits as diff items, the
// models for a picker and the person's two model settings, and files that are not text shown.
// A fake editor is the client; a fake LLeMbas server answers /v1/lembas/*; the model is scripted.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AcpAgent, type Limits } from "../src/acp/agent.ts"
import { Peer, type Transport } from "../src/acp/rpc.ts"
import { paths } from "../src/config/paths.ts"
import { setTrust } from "../src/project/root.ts"
import { LOOP } from "../src/harness.ts"
import { delta, fakeProvider, toolCall, type Fake } from "./fake-provider.ts"

let fake: Fake | undefined
let stopServer: (() => void) | undefined
const seen: { method: string; path: string; body: any }[] = []

const cleanLogin = () => {
  rmSync(join(paths.config, "lembas.json"), { force: true })
  rmSync(join(paths.config, "lembas"), { recursive: true, force: true })
  seen.length = 0
}
beforeEach(cleanLogin)
afterEach(() => {
  fake?.stop()
  fake = undefined
  stopServer?.()
  stopServer = undefined
  cleanLogin()
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

function config(url: string, extra = "") {
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  f:\n    type: webui\n    url: ${url}\n    models: { f/m: {}, f/deep: {} }\n`, { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), `model: f/m\n${extra}`)
}

function project(files: Record<string, string> = {}): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ph-editor-")))
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

const err = (message: string, status: number) => Response.json({ error: { message, type: "invalid_request_error", code: null } }, { status })

/** A fake LLeMbas server for the editor routes, and this machine logged in to it. `complete`
 *  answers each completion (given the body and the request, which aborts when the device closes it). */
function server(o: { complete?: (body: any, req: Request) => Response | Promise<Response>; editor?: boolean; allowed?: string[] | null; slowEditorMs?: number } = {}) {
  const state = { autocomplete: "f/m" as string | null, source: "instance" as string | null, main: null as string | null }
  const settings = () => ({ autocomplete: { model: state.autocomplete, source: state.source, allowed: o.allowed ?? null }, main: { model: state.main } })
  const s = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url)
      if (req.headers.get("authorization") !== "Bearer lmb_key") return new Response("no", { status: 401 })
      const body: any = req.method === "GET" ? null : await req.json().catch(() => null)
      seen.push({ method: req.method, path: u.pathname, body })
      if (u.pathname === "/v1/models") return Response.json({ data: [{ id: "f/m", name: "Flash", default: true }, { id: "f/deep", name: "Deep", kind: "chat" }, { id: "f/embed", kind: "embedding" }] })
      if (u.pathname === "/v1/lembas/complete" && o.complete) return o.complete(body, req)
      if (u.pathname === "/v1/lembas/editor" && o.editor !== false) {
        if (o.slowEditorMs) await Bun.sleep(o.slowEditorMs)
        if (req.method === "PUT") {
          if (body.autocomplete_model === "f/nope") return err("f/nope is not one of your models.", 404)
          if ("autocomplete_model" in body) (state.autocomplete = body.autocomplete_model ?? "f/m"), (state.source = body.autocomplete_model ? "person" : "instance")
          if ("main_model" in body) state.main = body.main_model
        }
        return Response.json(settings())
      }
      return new Response("Not Found", { status: 404 })
    },
  })
  stopServer = () => s.stop(true)
  mkdirSync(join(paths.config, "lembas"), { recursive: true })
  writeFileSync(join(paths.config, "lembas", "example.key"), "lmb_key\n", { mode: 0o600 })
  writeFileSync(join(paths.config, "lembas.json"), JSON.stringify({ instances: { example: { base_url: `http://127.0.0.1:${s.port}`, connection: "example", scope: "models memory link", logged_in_at: new Date().toISOString() } } }))
  return state
}

/** A fake editor on `serve --stdio` (no limits), or a client on the link (`limits`). */
async function editor(o: { limits?: Limits; lembas?: Record<string, unknown> | false; fs?: Record<string, boolean>; handlers?: Record<string, (p: any) => unknown>; ask?: (p: any) => unknown } = {}) {
  const [ta, tb] = pair()
  new AcpAgent(new Peer(ta), o.limits)
  const c = new Peer(tb)
  const updates: any[] = []
  const deltas: any[] = []
  const asked: any[] = []
  c.on("session/update", (p) => void updates.push(p))
  c.on("_lembas/event", () => {})
  c.on("_lembas/edit/delta", (p) => void deltas.push(p))
  c.handle("session/request_permission", (p) => (asked.push(p), o.ask?.(p) ?? { outcome: { outcome: "selected", optionId: "once" } }))
  for (const [m, fn] of Object.entries(o.handlers ?? {})) c.handle(m, fn)
  const lembas = o.lembas === false ? {} : { _meta: { lembas: o.lembas ?? { editor: true } } }
  const init: any = await c.request("initialize", { protocolVersion: 1, clientCapabilities: { ...(o.fs ? { fs: o.fs } : {}), ...lembas } })
  return { c, updates, deltas, asked, init, close: () => tb.close() }
}

const refusal = async (p: Promise<unknown>) => p.then(() => ({ message: "(answered)", data: undefined as any }), (e) => ({ message: (e as Error).message, data: (e as any).data }))

// ── capabilities ────────────────────────────────────────────────────────────────────────────

test("initialize: editor and media are listed; fs on the link only", async () => {
  fake = fakeProvider([])
  config(fake.url)
  const stdio = await editor()
  expect(stdio.init._meta.lembas.harness_spec).toBe("3.11.0")
  expect(stdio.init._meta.lembas.capabilities).toContain("editor")
  expect(stdio.init._meta.lembas.capabilities).toContain("media")
  expect(stdio.init._meta.lembas.capabilities).not.toContain("fs")
  const root = project()
  const link = await editor({ limits: { roots: [root], maxMode: "auto", approvalTimeoutMs: 3000, requireTrust: true } })
  expect(link.init._meta.lembas.capabilities).toContain("fs")
})

// ── _lembas/complete ────────────────────────────────────────────────────────────────────────

test("_lembas/complete: one request to the server, the window trimmed, no session and no chat request", async () => {
  fake = fakeProvider([])
  config(fake.url)
  server({ complete: (body) => Response.json({ text: "bake()", model: body.model ?? "f/m", finish: "stop", usage: {} }) })
  const { c } = await editor()
  const r: any = await c.request("_lembas/complete", { id: "k1", prefix: "const crumbs = ", suffix: "\n", path: "src/waybread.ts", language: "typescript", cwd: "/nowhere/at/all" })
  expect(r).toEqual({ text: "bake()", model: "f/m", finish: "stop" })
  expect(seen).toEqual([{ method: "POST", path: "/v1/lembas/complete", body: { prefix: "const crumbs = ", suffix: "\n", path: "src/waybread.ts", language: "typescript", stream: false } }])
  // The quick switch names a model; max_tokens is capped; a long window is trimmed, not refused.
  await c.request("_lembas/complete", { prefix: "x".repeat(70_000) + "END", suffix: "START" + "y".repeat(70_000), model: "f/deep", max_tokens: 9999 })
  const sent = seen[1]!.body
  expect(sent.model).toBe("f/deep")
  expect(sent.max_tokens).toBe(512)
  expect(Buffer.byteLength(sent.prefix)).toBe(65536)
  expect(sent.prefix.endsWith("END")).toBe(true)
  expect(Buffer.byteLength(sent.suffix)).toBe(65536)
  expect(sent.suffix.startsWith("START")).toBe(true)
  // Nothing went to the chat endpoint, and no session was made.
  expect(fake.requests.length).toBe(0)
})

test("_lembas/complete: a newer request cancels the older, which is answered as cancelled; cancel by id", async () => {
  fake = fakeProvider([])
  config(fake.url)
  const aborted: string[] = []
  server({
    complete: async (body, req) => {
      if (body.prefix === "fast") return Response.json({ text: "now", model: "f/m", finish: "stop" })
      // A slow model: answers only if the device does not close the request first.
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 5000)
        req.signal.addEventListener("abort", () => (clearTimeout(t), aborted.push(body.prefix), resolve()))
      })
      return Response.json({ text: "late", model: "f/m", finish: "stop" })
    },
  })
  const { c } = await editor()
  const first = c.request("_lembas/complete", { id: "a", prefix: "slow one" })
  await until(() => seen.length === 1, "the first request to reach the server")
  const second = c.request("_lembas/complete", { id: "b", prefix: "fast" })
  expect(await first).toEqual({ text: "", cancelled: true })
  expect(await second).toEqual({ text: "now", model: "f/m", finish: "stop" })
  // The server saw the first one closed: the model's request is stopped there.
  await until(() => aborted.includes("slow one"), "the server to see the request closed")
  // _lembas/complete/cancel by the client's own id; another id touches nothing.
  const third = c.request("_lembas/complete", { id: "c", prefix: "slow two" })
  await until(() => seen.length === 3, "the third request to reach the server")
  c.notify("_lembas/complete/cancel", { id: "zzz" })
  await Bun.sleep(30)
  c.notify("_lembas/complete/cancel", { id: "c" })
  expect(await third).toEqual({ text: "", cancelled: true })
})

test("_lembas/complete: every refusal in words, with its reason", async () => {
  fake = fakeProvider([])
  config(fake.url)
  // Not logged in at all.
  const out = await editor()
  expect(await refusal(out.c.request("_lembas/complete", { prefix: "x" }))).toMatchObject({ data: { reason: "not_logged_in" } })
  expect((await refusal(out.c.request("_lembas/complete", { suffix: "x" }))).data).toEqual({ reason: "invalid" })
  const answers: Record<string, () => Response> = {
    none: () => err("No autocomplete model is chosen. Choose one under Settings → Editor.", 409),
    forbidden: () => err("f/deep is not allowed for autocomplete.", 403),
    unknown: () => err("f/nope is not one of your models.", 404),
    busy: () => err("Too many completions at once.", 429),
    bad: () => err("Nothing to complete.", 400),
    broken: () => Response.json({ error: { message: "The model's server failed.", type: "upstream_error" } }, { status: 502 }),
  }
  server({ complete: (body) => answers[body.prefix]!() })
  const { c } = await editor()
  // The server's sentence reaches the editor unchanged.
  expect(await refusal(c.request("_lembas/complete", { prefix: "none" }))).toEqual({ message: "No autocomplete model is chosen. Choose one under Settings → Editor.", data: { reason: "no_model" } })
  expect(await refusal(c.request("_lembas/complete", { prefix: "forbidden" }))).toEqual({ message: "f/deep is not allowed for autocomplete.", data: { reason: "not_allowed" } })
  expect(await refusal(c.request("_lembas/complete", { prefix: "unknown" }))).toEqual({ message: "f/nope is not one of your models.", data: { reason: "unknown_model" } })
  expect(await refusal(c.request("_lembas/complete", { prefix: "busy" }))).toMatchObject({ data: { reason: "busy" } })
  expect(await refusal(c.request("_lembas/complete", { prefix: "bad" }))).toMatchObject({ data: { reason: "invalid" } })
  expect((await refusal(c.request("_lembas/complete", { prefix: "broken" }))).message).toBe("The model's server failed.")
})

test("_lembas/complete: a server before spec 3.11.0 is said to be older", async () => {
  fake = fakeProvider([])
  config(fake.url)
  server({})
  const { c } = await editor()
  const r = await refusal(c.request("_lembas/complete", { prefix: "x" }))
  expect(r.data).toEqual({ reason: "unsupported" })
  expect(r.message).toContain("newer LLeMbas server")
})

// ── _lembas/edit ────────────────────────────────────────────────────────────────────────────

test("_lembas/edit: one request with no tools; deltas; a fence taken off; nothing written", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "```ts\n  return " }), delta({ content: "await crumbs\n" }), delta({ content: "```\n" })] }])
  config(fake.url)
  const root = project({ "src/waybread.ts": "function bake() {\n  return crumbs\n}\n" })
  const { c, deltas } = await editor()
  const r: any = await c.request("_lembas/edit", { id: "e1", cwd: root, path: "src/waybread.ts", language: "typescript", before: "function bake() {\n", text: "  return crumbs\n", after: "}\n", instruction: "make it async" })
  expect(r).toEqual({ text: "  return await crumbs\n", model: "f/m" })
  expect(deltas.every((d) => d.id === "e1")).toBe(true)
  expect(deltas.map((d) => d.delta).join("")).toBe(r.text)
  const sent = fake.requests[0]
  // No tools at all: a rewrite reads nothing and changes nothing.
  expect(sent.tools ?? []).toEqual([])
  expect(sent.messages[0].role).toBe("system")
  expect(sent.messages[0].content).toContain("You rewrite a selection")
  expect(sent.messages[1].content).toBe("File: src/waybread.ts (typescript)\n<before>\nfunction bake() {\n</before>\n<selection>\n  return crumbs\n</selection>\n<after>\n}\n</after>\n<instruction>\nmake it async\n</instruction>")
  expect(readFileSync(join(root, "src/waybread.ts"), "utf8")).toBe("function bake() {\n  return crumbs\n}\n")
})

test("_lembas/edit: the model — asked, the session's, the person's main model, else as a new session", async () => {
  const answer = { chunks: [delta({ content: "x" })] }
  fake = fakeProvider([answer, answer, answer, answer, answer])
  config(fake.url)
  const state = server({})
  const root = project()
  const { c } = await editor()
  const edit = (extra: Record<string, unknown>) => c.request<any>("_lembas/edit", { text: "y", instruction: "i", ...extra })
  // Nothing chosen anywhere: as a new session would start (the global setting here).
  expect((await edit({ cwd: root })).model).toBe("f/m")
  // The person's main model, kept on the server.
  state.main = "f/deep"
  expect((await edit({ cwd: root })).model).toBe("f/deep")
  // A session's model comes before it — and the rewrite is no turn of the session.
  const s: any = await c.request("session/new", { cwd: root, _meta: { model: "f/m" } })
  expect((await edit({ sessionId: s.sessionId })).model).toBe("f/m")
  const status: any = await c.request("_lembas/session/history", { sessionId: s.sessionId })
  expect(status.turns).toEqual([])
  // The model asked for comes first of all.
  expect((await edit({ sessionId: s.sessionId, model: "f/deep" })).model).toBe("f/deep")
  // A main model the login no longer serves is skipped.
  state.main = "f/gone"
  expect((await edit({})).model).toBe("f/m")
  expect(fake.requests.map((r) => r.model)).toEqual(["f/m", "f/deep", "f/m", "f/deep", "f/m"])
})

test("_lembas/edit: cancelled by id; refused without text or instruction, over the limits, for an unknown session, and with no reply", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "slow" }), delta({ content: " answer" })], gapMs: 3000 }, { chunks: [delta({ content: "\n" })] }])
  config(fake.url)
  const { c } = await editor()
  const running = c.request("_lembas/edit", { id: "e9", text: "y", instruction: "i" })
  await until(() => fake!.requests.length === 1, "the rewrite to reach the model")
  c.notify("_lembas/edit/cancel", { id: "e9" })
  expect(await running).toEqual({ text: "", cancelled: true })
  expect((await refusal(c.request("_lembas/edit", { instruction: "i" }))).data).toEqual({ reason: "invalid" })
  expect((await refusal(c.request("_lembas/edit", { text: "y", instruction: "  " }))).data).toEqual({ reason: "invalid" })
  expect((await refusal(c.request("_lembas/edit", { text: "y".repeat(300_000), instruction: "i" }))).data).toEqual({ reason: "too_large" })
  expect((await refusal(c.request("_lembas/edit", { text: "y", instruction: "i".repeat(8001) }))).data).toEqual({ reason: "too_large" })
  expect((await refusal(c.request("_lembas/edit", { text: "y", instruction: "i", sessionId: "ses_none" }))).message).toBe("no such session")
  expect((await refusal(c.request("_lembas/edit", { text: "y", instruction: "i", cwd: "/no/such/place" }))).data).toEqual({ reason: "invalid" })
  // A model that says nothing: an error in words, not an empty replacement.
  expect((await refusal(c.request("_lembas/edit", { text: "y", instruction: "i" }))).message).toContain("no text")
})

test("_lembas/edit on the link: a cwd outside the device's roots is refused", async () => {
  fake = fakeProvider([])
  config(fake.url)
  const root = project()
  const other = project()
  const { c } = await editor({ limits: { roots: [root], maxMode: "auto", approvalTimeoutMs: 3000, requireTrust: true } })
  const r = await refusal(c.request("_lembas/edit", { text: "y", instruction: "i", cwd: other }))
  expect(r.data).toEqual({ reason: "outside" })
  expect(fake.requests.length).toBe(0)
})

// ── _lembas/models, _lembas/editor/settings ─────────────────────────────────────────────────

test("_lembas/models and _lembas/editor/settings: the picker's models, the two settings read and set", async () => {
  fake = fakeProvider([])
  config(fake.url)
  server({ allowed: ["f/m"] })
  const { c } = await editor()
  const m: any = await c.request("_lembas/models", {})
  // Chat models only; what each may be picked for comes from `allowed`.
  expect(m.models).toEqual([
    { id: "f/m", name: "Flash", for: ["main", "autocomplete"], default: true },
    { id: "f/deep", name: "Deep", for: ["main"] },
  ])
  expect(m.autocomplete).toEqual({ model: "f/m", source: "instance", allowed: ["f/m"] })
  expect(m.main).toEqual({ model: null })
  expect(await c.request<any>("_lembas/editor/settings", {})).toEqual({ autocomplete: { model: "f/m", source: "instance", allowed: ["f/m"] }, main: { model: null } })
  const set: any = await c.request("_lembas/editor/settings", { set: { main_model: "f/deep" } })
  expect(set.main).toEqual({ model: "f/deep" })
  // Only the field named is sent.
  expect(seen.find((s) => s.method === "PUT")!.body).toEqual({ main_model: "f/deep" })
  // null: back to the instance's.
  const back: any = await c.request("_lembas/editor/settings", { set: { autocomplete_model: null } })
  expect(back.autocomplete.source).toBe("instance")
  // The server's refusal, in its words; a set that names nothing.
  expect(await refusal(c.request("_lembas/editor/settings", { set: { autocomplete_model: "f/nope" } }))).toEqual({ message: "f/nope is not one of your models.", data: { reason: "unknown_model" } })
  expect((await refusal(c.request("_lembas/editor/settings", { set: {} }))).data).toEqual({ reason: "invalid" })
  expect((await refusal(c.request("_lembas/editor/settings", { set: { main_model: 7 } }))).data).toEqual({ reason: "invalid" })
})

test("_lembas/models and settings against a server before 3.11.0, and logged out", async () => {
  fake = fakeProvider([])
  config(fake.url)
  const out = await editor()
  expect((await refusal(out.c.request("_lembas/models", {}))).data).toEqual({ reason: "not_logged_in" })
  expect((await refusal(out.c.request("_lembas/editor/settings", {}))).data).toEqual({ reason: "not_logged_in" })
  server({ editor: false })
  const { c } = await editor()
  const m: any = await c.request("_lembas/models", {})
  expect(m.models.map((x: any) => x.for)).toEqual([["main"], ["main"]])
  expect(m.autocomplete).toBeNull()
  expect((await refusal(c.request("_lembas/editor/settings", {}))).data).toEqual({ reason: "unsupported" })
  expect((await refusal(c.request("_lembas/editor/settings", { set: { main_model: "f/m" } }))).data).toEqual({ reason: "unsupported" })
})

// ── editor context in a prompt ──────────────────────────────────────────────────────────────

test("editor context: one block after the person's text; not part of what was typed; nothing read for it", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "ok" })] }])
  config(fake.url)
  const root = project({ "src/waybread.ts": "const crumbs = bake()\n" })
  const { c } = await editor()
  const s: any = await c.request("session/new", { cwd: root })
  await c.request("session/prompt", {
    sessionId: s.sessionId,
    prompt: [{ type: "text", text: "why is this red?" }],
    _meta: { lembas: { editor: { path: join(root, "src/waybread.ts"), cursor: { line: 1 }, selection: { start: 1, end: 1, text: "const crumbs = bake()\n" }, diagnostics: [{ line: 1, severity: "error", message: "Cannot find name 'bake'.", source: "ts" }], open: ["/etc/hosts"] } } },
  })
  const user = fake.requests[0].messages.filter((m: any) => m.role === "user").at(-1).content
  expect(user).toContain("why is this red?")
  expect(user).toContain("<editor>\nOpen file: src/waybread.ts (cursor at line 1)\nSelection: src/waybread.ts line 1\n<selection>\nconst crumbs = bake()\n</selection>\nDiagnostics:\n- line 1 error: Cannot find name 'bake'. (ts)\nOther open files: /etc/hosts\n</editor>")
  // A path in the block is a name: the file outside the project was not read.
  expect(user).not.toContain("localhost")
  // The history shows what the person typed, without the block.
  const h: any = await c.request("_lembas/session/history", { sessionId: s.sessionId })
  expect(h.turns[0].text).toBe("why is this red?")
})

// ── unsaved text ────────────────────────────────────────────────────────────────────────────

test("unsaved text: read asks the client's buffer; an edit starts from it and is written through the client", async () => {
  fake = fakeProvider([
    { chunks: [toolCall(0, "r1", "read", JSON.stringify({ path: "a.txt" }))] },
    { chunks: [toolCall(0, "w1", "edit", JSON.stringify({ path: "a.txt", old: "unsaved", new: "changed" }))] },
    { chunks: [delta({ content: "done" })] },
  ])
  config(fake.url)
  const root = project({ "a.txt": "on disk\n" })
  const file = join(root, "a.txt")
  const buffers: Record<string, string> = { [file]: "unsaved line\n" }
  const calls: any[] = []
  const { c, updates } = await editor({
    fs: { readTextFile: true, writeTextFile: true },
    handlers: {
      "fs/read_text_file": (p) => (calls.push(["read", p.path]), { content: buffers[p.path] }),
      "fs/write_text_file": (p) => (calls.push(["write", p.path]), (buffers[p.path] = p.content), null),
    },
  })
  const s: any = await c.request("session/new", { cwd: root, _meta: { mode: "auto" } })
  await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "fix it" }] })
  // The model was given the buffer, not the disk.
  expect(fake.requests[1].messages.find((m: any) => m.role === "tool").content).toContain("1: unsaved line")
  // The edit went to the client; the device did not write the disk behind its back.
  expect(buffers[file]).toBe("changed line\n")
  expect(readFileSync(file, "utf8")).toBe("on disk\n")
  expect(calls.filter((x) => x[0] === "write")).toEqual([["write", file]])
  // The finished edit carries the diff: the buffer's text before, and after.
  const done = updates.map((u) => u.update).find((u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === "w1")
  expect(done.content[1]).toEqual({ type: "diff", path: file, oldText: "unsaved line\n", newText: "changed line\n" })
})

test("unsaved text: a client that fails falls back to the disk; text changed in the editor since the read refuses an overwrite", async () => {
  fake = fakeProvider([
    { chunks: [toolCall(0, "r1", "read", JSON.stringify({ path: "a.txt" }))] },
    { chunks: [toolCall(0, "w1", "write", JSON.stringify({ path: "a.txt", content: "new\n" }))] },
    { chunks: [toolCall(0, "r2", "read", JSON.stringify({ path: "b.txt" }))] },
    { chunks: [toolCall(0, "w2", "write", JSON.stringify({ path: "b.txt", content: "B2\n" }))] },
    { chunks: [delta({ content: "done" })] },
  ])
  config(fake.url)
  const root = project({ "a.txt": "A\n", "b.txt": "B\n" })
  let a = "A in the editor\n"
  const { c } = await editor({
    fs: { readTextFile: true, writeTextFile: true },
    handlers: {
      // b.txt: the client knows nothing of it, and cannot write it either.
      "fs/read_text_file": (p) => {
        if (p.path.endsWith("b.txt")) throw new Error("not open")
        const now = a
        // The person keeps typing after the agent read the file.
        a = "A typed over since\n"
        return { content: now }
      },
      "fs/write_text_file": () => {
        throw new Error("read-only buffer")
      },
    },
  })
  const s: any = await c.request("session/new", { cwd: root, _meta: { mode: "auto" } })
  await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "go" }] })
  const tools = fake.requests.at(-1).messages.filter((m: any) => m.role === "tool").map((m: any) => m.content)
  expect(tools[0]).toContain("1: A in the editor")
  expect(tools[1]).toContain("changed since you last read it")
  expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("A\n")
  // b.txt: read from the disk, written to the disk.
  expect(tools[2]).toContain("1: B")
  expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("B2\n")
})

test("unsaved text: a protected path is refused before the client is ever asked", async () => {
  fake = fakeProvider([{ chunks: [toolCall(0, "w1", "write", JSON.stringify({ path: join(paths.config, "connections.yaml"), content: "x" }))] }, { chunks: [delta({ content: "done" })] }])
  config(fake.url)
  const root = project()
  const calls: string[] = []
  const { c } = await editor({ fs: { readTextFile: true, writeTextFile: true }, handlers: { "fs/read_text_file": (p) => (calls.push(p.path), { content: "" }), "fs/write_text_file": (p) => (calls.push(p.path), null) } })
  const s: any = await c.request("session/new", { cwd: root, _meta: { mode: "auto" } })
  await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "go" }] })
  expect(fake.requests[1].messages.find((m: any) => m.role === "tool").content).toContain("never written by a tool")
  expect(calls).toEqual([])
})

// ── edits as diffs ──────────────────────────────────────────────────────────────────────────

const editScript = () => [
  { chunks: [toolCall(0, "r1", "read", JSON.stringify({ path: "a.txt" }))] },
  { chunks: [toolCall(0, "e1", "edit", JSON.stringify({ path: "a.txt", old: "one", new: "two" }))] },
  { chunks: [toolCall(0, "n1", "write", JSON.stringify({ path: "new.txt", content: "fresh\n" }))] },
  { chunks: [delta({ content: "done" })] },
]

test("edits as diffs: in manual mode an editor is asked with diff items, nothing written before; rejected stays unwritten", async () => {
  fake = fakeProvider(editScript())
  config(fake.url)
  const root = project({ "a.txt": "one\n" })
  const file = join(root, "a.txt")
  let onDisk = ""
  const { c, asked, updates } = await editor({
    ask: (p) => {
      if (p.toolCall.kind !== "edit") return { outcome: { outcome: "selected", optionId: "once" } }
      if (p.toolCall.rawInput.path === "a.txt") onDisk = readFileSync(file, "utf8")
      // The first edit is accepted, the new file rejected.
      return { outcome: { outcome: "selected", optionId: p.toolCall.rawInput.path === "a.txt" ? "once" : "deny" } }
    },
  })
  const s: any = await c.request("session/new", { cwd: root, _meta: { mode: "manual" } })
  await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "go" }] })
  const edits = asked.filter((a) => a.toolCall.kind === "edit")
  expect(edits[0].toolCall.content).toEqual([{ type: "diff", path: file, oldText: "one\n", newText: "two\n" }])
  // A file the call creates has no old text.
  expect(edits[1].toolCall.content).toEqual([{ type: "diff", path: join(root, "new.txt"), oldText: null, newText: "fresh\n" }])
  // Nothing was written before the answer.
  expect(onDisk).toBe("one\n")
  expect(readFileSync(file, "utf8")).toBe("two\n")
  expect(await Bun.file(join(root, "new.txt")).exists()).toBe(false)
  // The edit that ran carries the same item after its text.
  const done = updates.map((u) => u.update).find((u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === "e1")
  expect(done.content.map((x: any) => x.type)).toEqual(["content", "diff"])
  expect(done.content[1]).toEqual({ type: "diff", path: file, oldText: "one\n", newText: "two\n" })
})

test("edits as diffs: auto mode writes as before and the diff comes after; any other client gets what it got", async () => {
  fake = fakeProvider([...editScript(), ...editScript()])
  config(fake.url)
  const root = project({ "a.txt": "one\n" })
  const ed = await editor()
  const s: any = await ed.c.request("session/new", { cwd: root, _meta: { mode: "auto" } })
  await ed.c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "go" }] })
  expect(ed.asked).toEqual([])
  const created = ed.updates.map((u) => u.update).find((u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === "n1")
  expect(created.content[1]).toEqual({ type: "diff", path: join(root, "new.txt"), oldText: null, newText: "fresh\n" })
  // A plain ACP client: the unified diff as text on the card, the output alone on the update.
  const root2 = project({ "a.txt": "one\n" })
  const plain = await editor({ lembas: false })
  const s2: any = await plain.c.request("session/new", { cwd: root2, _meta: { mode: "manual" } })
  await plain.c.request("session/prompt", { sessionId: s2.sessionId, prompt: [{ type: "text", text: "go" }] })
  const card = plain.asked.find((a) => a.toolCall.kind === "edit")
  expect(card.toolCall.content).toHaveLength(1)
  expect(card.toolCall.content[0].type).toBe("content")
  expect(card.toolCall.content[0].content.text).toContain("-one\n+two")
  const done = plain.updates.map((u) => u.update).find((u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === "e1")
  expect(done.content.map((x: any) => x.type)).toEqual(["content"])
})

// ── files that are not text, shown ──────────────────────────────────────────────────────────

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.alloc(3000, 7)])

test("show: a picture is handed to a client that shows media by a handle it fetches while the request is open", async () => {
  fake = fakeProvider([{ chunks: [toolCall(0, "s1", "show", JSON.stringify({ path: "out/chart.png" }))] }, { chunks: [delta({ content: "there" })] }])
  config(fake.url)
  const root = project()
  mkdirSync(join(root, "out"))
  writeFileSync(join(root, "out/chart.png"), PNG)
  let shown: any
  let fetched = Buffer.alloc(0)
  let afterwards: Promise<unknown> | undefined
  const ed: any = {}
  const made = await editor({
    lembas: { editor: true, show: true, media: true },
    handlers: {
      "_lembas/show": async (p) => {
        shown = p
        // In parts, as a large file would be.
        for (let offset = 0; ; ) {
          const part: any = await ed.c.request("_lembas/show/read", { handle: p.handle, offset, length: 1000 })
          fetched = Buffer.concat([fetched, Buffer.from(part.data, "base64")])
          offset += Buffer.from(part.data, "base64").length
          if (part.eof) break
        }
        return { shown: true }
      },
    },
  })
  ed.c = made.c
  const s: any = await made.c.request("session/new", { cwd: root, _meta: { mode: "auto" } })
  await made.c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "show me" }] })
  expect(shown).toMatchObject({ sessionId: s.sessionId, toolCallId: "s1", path: "out/chart.png", kind: "image", mimeType: "image/png", size: PNG.length })
  expect(shown.hash).toMatch(/^sha256:[0-9a-f]{64}$/)
  // On stdio the client is on this machine and is told where the file is; the path here never travels as `file`.
  expect(shown.uri).toBe(`file://${join(root, "out/chart.png")}`)
  expect(shown.file).toBeUndefined()
  expect(fetched.equals(PNG)).toBe(true)
  expect(fake.requests[1].messages.find((m: any) => m.role === "tool").content).toContain("Shown to the user: out/chart.png")
  // Once the request is answered the handle is good for nothing.
  afterwards = made.c.request("_lembas/show/read", { handle: shown.handle })
  expect((await refusal(afterwards)).data).toEqual({ reason: "invalid" })
  expect((await refusal(made.c.request("_lembas/show/read", { handle: "h_made_up" }))).data).toEqual({ reason: "invalid" })
})

test("show: a client without media is not handed a picture; a table is named for one with it", async () => {
  fake = fakeProvider([
    { chunks: [toolCall(0, "s1", "show", JSON.stringify({ path: "chart.png" }))] },
    { chunks: [delta({ content: "a" })] },
    { chunks: [toolCall(0, "s2", "show", JSON.stringify({ path: "loaves.csv" }))] },
    { chunks: [delta({ content: "b" })] },
  ])
  config(fake.url)
  const root = project({ "loaves.csv": "kind,count\nrye,3\n" })
  writeFileSync(join(root, "chart.png"), PNG)
  const sent: any[] = []
  const plain = await editor({ lembas: { show: true }, handlers: { "_lembas/show": (p) => (sent.push(p), { shown: true }) } })
  const s: any = await plain.c.request("session/new", { cwd: root, _meta: { mode: "auto" } })
  await plain.c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "show" }] })
  expect(sent).toEqual([])
  expect(fake.requests[1].messages.find((m: any) => m.role === "tool").content).toContain("is not a text file")
  const media = await editor({ lembas: { show: true, media: true }, handlers: { "_lembas/show": (p) => (sent.push(p), { shown: true }) } })
  const s2: any = await media.c.request("session/new", { cwd: root, _meta: { mode: "auto" } })
  await media.c.request("session/prompt", { sessionId: s2.sessionId, prompt: [{ type: "text", text: "show" }] })
  expect(sent[0]).toMatchObject({ path: "loaves.csv", kind: "table", text: "kind,count\nrye,3\n" })
  expect(sent[0].handle).toBeUndefined()
})

// ── after the review ────────────────────────────────────────────────────────────────────────

test("unsaved text is never replaced from the disk: a client that stops answering at edit time refuses the edit", async () => {
  fake = fakeProvider([
    { chunks: [toolCall(0, "r1", "read", JSON.stringify({ path: "a.txt" }))] },
    { chunks: [toolCall(0, "e1", "edit", JSON.stringify({ path: "a.txt", old: "saved", new: "clobbered" }))] },
    { chunks: [toolCall(0, "w1", "write", JSON.stringify({ path: "a.txt", content: "clobbered\n" }))] },
    { chunks: [delta({ content: "done" })] },
  ])
  config(fake.url)
  const root = project({ "a.txt": "saved text\n" })
  const file = join(root, "a.txt")
  let reads = 0
  const writes: string[] = []
  const { c } = await editor({
    fs: { readTextFile: true, writeTextFile: true },
    handlers: {
      // The first read gives the buffer; after that the editor is busy and fails.
      "fs/read_text_file": () => {
        if (reads++ === 0) return { content: "saved text\nand a line not saved yet\n" }
        throw new Error("the editor is busy")
      },
      "fs/write_text_file": (p) => (writes.push(p.content), null),
    },
  })
  const s: any = await c.request("session/new", { cwd: root, _meta: { mode: "auto" } })
  await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "go" }] })
  const tools = fake.requests.at(-1).messages.filter((m: any) => m.role === "tool").map((m: any) => m.content)
  expect(tools[0]).toContain("2: and a line not saved yet")
  // Neither the edit nor the overwrite fell back to the disk's text.
  expect(tools[1]).toContain("Read it again before changing it")
  expect(tools[2]).toContain("Read it again before changing it")
  expect(writes).toEqual([])
  expect(readFileSync(file, "utf8")).toBe("saved text\n")
})

test("only the read tool and a write that ran count as reading: a patch that was shown and refused does not", async () => {
  fake = fakeProvider([
    { chunks: [toolCall(0, "r1", "read", JSON.stringify({ path: "a.txt" }))] },
    { chunks: [toolCall(0, "p1", "apply_patch", JSON.stringify({ patch: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-two\n+three\n" }))] },
    { chunks: [toolCall(0, "w1", "write", JSON.stringify({ path: "a.txt", content: "mine\n" }))] },
    { chunks: [delta({ content: "done" })] },
  ])
  config(fake.url)
  const root = project({ "a.txt": "one\n" })
  let buffer = "one\n"
  let reads = 0
  const { c } = await editor({
    fs: { readTextFile: true, writeTextFile: true },
    // The patch is the one card refused; the write would be allowed.
    ask: (p) => ({ outcome: { outcome: "selected", optionId: String(p.toolCall.rawInput?.patch ?? "") ? "deny" : "once" } }),
    handlers: {
      "fs/read_text_file": () => {
        // After the model's read the person types: the buffer is "two" from then on.
        const now = buffer
        if (reads++ === 0) buffer = "two\n"
        return { content: now }
      },
      "fs/write_text_file": (p) => ((buffer = p.content), null),
    },
  })
  const s: any = await c.request("session/new", { cwd: root, _meta: { mode: "manual" } })
  await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "go" }] })
  const tools = fake.requests.at(-1).messages.filter((m: any) => m.role === "tool").map((m: any) => m.content)
  expect(tools[0]).toContain("1: one")
  // The preview of the refused patch looked at "two" — the model never did. The overwrite is refused.
  expect(tools[2]).toContain("changed since you last read it")
  expect(buffer).toBe("two\n")
})

test("the link's client is never asked for a file's text, whatever it says of fs", async () => {
  fake = fakeProvider([
    { chunks: [toolCall(0, "r1", "read", JSON.stringify({ path: "a.txt" }))] },
    { chunks: [toolCall(0, "e1", "edit", JSON.stringify({ path: "a.txt", old: "disk", new: "changed" }))] },
    { chunks: [delta({ content: "done" })] },
  ])
  config(fake.url)
  const root = project({ "a.txt": "on disk\n" })
  const calls: string[] = []
  const { c } = await editor({
    limits: { roots: [root], maxMode: "auto", approvalTimeoutMs: 3000, requireTrust: true },
    fs: { readTextFile: true, writeTextFile: true },
    handlers: { "fs/read_text_file": (p) => (calls.push(p.path), { content: "the server's own text\n" }), "fs/write_text_file": (p) => (calls.push(p.path), null) },
  })
  const s: any = await c.request("session/new", { cwd: root, _meta: { mode: "auto" } })
  await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "go" }] })
  expect(calls).toEqual([])
  expect(fake.requests[1].messages.find((m: any) => m.role === "tool").content).toContain("1: on disk")
  expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("on changed\n")
})

test("a write the editor never confirms is not written to the disk as well; one it took is not refused later for the disk's change time", async () => {
  const old = LOOP.editor.buffers.timeout_seconds
  LOOP.editor.buffers.timeout_seconds = 0.3
  try {
    fake = fakeProvider([
      { chunks: [toolCall(0, "w1", "write", JSON.stringify({ path: "slow.txt", content: "one\n" }))] },
      { chunks: [toolCall(0, "w2", "write", JSON.stringify({ path: "new.txt", content: "first\n" }))] },
      { chunks: [toolCall(0, "w3", "write", JSON.stringify({ path: "new.txt", content: "second\n" }))] },
      { chunks: [delta({ content: "done" })] },
    ])
    config(fake.url)
    const root = project()
    const buffers: Record<string, string> = {}
    const { c } = await editor({
      fs: { readTextFile: true, writeTextFile: true },
      handlers: {
        "fs/read_text_file": (p) => {
          if (!(p.path in buffers)) throw new Error("not open")
          return { content: buffers[p.path] }
        },
        "fs/write_text_file": async (p) => {
          // slow.txt: the editor never answers in time.
          if (p.path.endsWith("slow.txt")) return new Promise(() => {})
          buffers[p.path] = p.content
          // The editor's save reaches the disk a moment after it answered.
          setTimeout(() => writeFileSync(p.path, p.content), 40)
          return null
        },
      },
    })
    const s: any = await c.request("session/new", { cwd: root, _meta: { mode: "auto" } })
    await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "go" }] })
    const tools = fake.requests.at(-1).messages.filter((m: any) => m.role === "tool").map((m: any) => m.content)
    expect(tools[0]).toContain("did not confirm writing")
    // Not written by the device as well: two writers would cross.
    expect(await Bun.file(join(root, "slow.txt")).exists()).toBe(false)
    expect(tools[1]).toContain("Created")
    // The second write is judged by the text in the editor, not by the save that landed in between.
    expect(tools[2]).not.toContain("changed since")
    expect(tools[2]).not.toContain("Read it")
    expect(buffers[join(root, "new.txt")]).toBe("second\n")
  } finally {
    LOOP.editor.buffers.timeout_seconds = old
  }
})

/** A model's server that never answers, and says when a request to it is closed. */
function hangingProvider() {
  const state = { open: 0, closed: 0 }
  const s = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method !== "POST") return Response.json({ data: [] })
      state.open++
      await new Promise<void>((resolve) => req.signal.addEventListener("abort", () => (state.closed++, resolve())))
      return new Response("gone", { status: 499 })
    },
  })
  return { url: `http://127.0.0.1:${s.port}/v1`, state, stop: () => s.stop(true) }
}

test("rewrites: at most four at once; every one stops when its client goes, with an id or without", async () => {
  const hang = hangingProvider()
  try {
    config(hang.url)
    const { c, close } = await editor()
    const running = [0, 1, 2, 3].map((i) => refusal(c.request("_lembas/edit", { text: "y", instruction: "i", ...(i % 2 ? { id: `e${i}` } : {}) })))
    await until(() => hang.state.open === 4, "four rewrites to reach the model")
    const fifth = await refusal(c.request("_lembas/edit", { text: "y", instruction: "i" }))
    expect(fifth.data).toEqual({ reason: "busy" })
    expect(hang.state.open).toBe(4)
    // An id longer than 100 characters is cut the same way where it is given and where it is cancelled.
    c.notify("_lembas/edit/cancel", { id: "e1" })
    await until(() => hang.state.closed === 1, "the cancelled rewrite's request to close")
    const long = "x".repeat(150)
    const sixth = c.request("_lembas/edit", { id: long, text: "y", instruction: "i" })
    await until(() => hang.state.open === 5, "the long-id rewrite to reach the model")
    c.notify("_lembas/edit/cancel", { id: long })
    expect(await sixth).toEqual({ text: "", cancelled: true })
    // The client goes: the three still running — two of them without an id — are stopped.
    close()
    await until(() => hang.state.closed === 5, "every rewrite's request to close")
    void running
  } finally {
    hang.stop()
  }
})

test("a rewrite cancelled while its model is still being chosen never reaches the model", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "never" })] }])
  config(fake.url)
  // The person's main model is asked of the server first, and the server is slow about it.
  server({ slowEditorMs: 300 })
  const { c } = await editor()
  const edit = c.request("_lembas/edit", { id: "early", text: "y", instruction: "i" })
  await until(() => seen.some((s) => s.path === "/v1/lembas/editor"), "the settings to be asked for")
  c.notify("_lembas/edit/cancel", { id: "early" })
  expect(await edit).toEqual({ text: "", cancelled: true })
  await Bun.sleep(350)
  expect(fake.requests.length).toBe(0)
})

test("a typed message that begins like the editor's block is shown as typed", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "ok" })] }])
  config(fake.url)
  const root = project()
  const { c } = await editor()
  const s: any = await c.request("session/new", { cwd: root })
  const typed = "<editor>\nis this tag valid XML?"
  await c.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: typed }], _meta: { lembas: { editor: { path: "a.xml" } } } })
  const h: any = await c.request("_lembas/session/history", { sessionId: s.sessionId })
  // What was typed is there; the block the client added is not.
  expect(h.turns[0].text).toBe(typed)
})
