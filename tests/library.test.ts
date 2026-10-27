// The library: notes, knowledge bases, search by words (FTS5) and by meaning (a stand-in
// embedding model), what ingestion takes and refuses, and the tools a session gets.
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../src/app.ts"
import { paths } from "../src/config/paths.ts"
import { split } from "../src/library/chunks.ts"
import { embedderFor } from "../src/library/embed.ts"
import { ingest, MAX_TEXT_CHARS } from "../src/library/ingest.ts"
import { Library, type Embedder } from "../src/library/store.ts"
import { setTrust } from "../src/project/root.ts"
import { delta, fakeProvider, toolCall, type Fake } from "./fake-provider.ts"

const fresh = () => new Library(join(mkdtempSync(join(tmpdir(), "ph-lib-")), "library.db"))

/** Meaning, crudely: one dimension per idea, whatever word says it. */
const IDEAS = [["car", "automobile", "vehicle"], ["tyre", "tyres", "tire", "wheel"], ["cake", "dessert", "baking"]]
const standIn: Embedder = {
  model: "test/ideas",
  async embed(texts) {
    return texts.map((t) => {
      const v = Float32Array.from(IDEAS, (words) => (words.some((w) => new RegExp(`\\b${w}\\b`, "i").test(t)) ? 1 : 0.01))
      const n = Math.hypot(...v)
      return v.map((x) => x / n)
    })
  },
}

test("chunks: about the size asked, overlapping, cut at a paragraph; a short text is one piece", () => {
  expect(split("short")).toEqual(["short"])
  const para = (n: number) => `${"word ".repeat(60).trim()} ${n}.`
  const text = Array.from({ length: 12 }, (_, i) => para(i)).join("\n\n")
  const pieces = split(text, 1200, 150)
  expect(pieces.length).toBeGreaterThan(2)
  for (const p of pieces) expect(p.length).toBeLessThanOrEqual(1200)
  // Cut where a paragraph ends, so each piece but the last ends with one.
  for (const p of pieces.slice(0, -1)) expect(p.endsWith(".")).toBe(true)
  // Overlap: a piece starts inside the one before.
  expect(pieces[0]!.includes(pieces[1]!.slice(0, 40))).toBe(true)
})

test("notes: by words, any word when all of them find nothing; per scope; edit and delete", () => {
  const lib = fresh()
  const a = lib.addNote("global", "Deploy steps", "Build, then rsync to the host, then restart the service.")
  lib.addNote("/p", "Parser design", "A recursive-descent parser with Pratt operators.")
  lib.addNote("/q", "Other project", "rsync elsewhere")
  expect(lib.notes(["global", "/p"], "rsync restart").map((n) => n.id)).toEqual([a.id])
  expect(lib.notes(["global", "/p"], "rsync nonsense").map((n) => n.title)).toEqual(["Deploy steps"])
  expect(lib.notes(["global", "/p"]).map((n) => n.title).sort()).toEqual(["Deploy steps", "Parser design"])
  lib.editNote(a.id, { body: "Now with blue-green." })
  expect(lib.notes(["global"], "blue-green")).toHaveLength(1)
  expect(lib.notes(["global"], "rsync")).toHaveLength(0)
  lib.deleteNote(a.id)
  expect(lib.note(a.id)).toBeUndefined()
})

test("a base: unchanged text is left alone; a removed document is no longer found", async () => {
  const lib = fresh()
  lib.createBase("manuals")
  expect(() => lib.createBase("manuals")).toThrow("already")
  expect(() => lib.createBase("bad name")).toThrow("not a base name")
  const one = lib.putDocument("manuals", { title: "Pump", source: "/m/pump.md", text: "The pump primes in thirty seconds." })
  expect(lib.putDocument("manuals", { title: "Pump", source: "/m/pump.md", text: "The pump primes in thirty seconds." })).toEqual({ id: one.id, changed: false })
  expect((await lib.search("primes")).map((h) => h.title)).toEqual(["Pump"])
  lib.deleteDocument(one.id)
  expect(await lib.search("primes")).toEqual([])
})

test("meaning: an embedding model finds what no word matches; words still count; bases narrow it", async () => {
  const lib = fresh()
  lib.createBase("garage")
  lib.createBase("kitchen")
  lib.putDocument("garage", { title: "Service", source: "s", text: "The automobile needs new tyres before winter." })
  lib.putDocument("kitchen", { title: "Recipes", source: "r", text: "A dessert for Sunday: lemon baking notes." })
  expect(await lib.search("car")).toEqual([])
  expect(await lib.embedAll(standIn)).toBe(2)
  expect(await lib.embedAll(standIn)).toBe(0)
  expect((await lib.search("car", { embedder: standIn }))[0]!.title).toBe("Service")
  expect((await lib.search("cake", { embedder: standIn }))[0]!.title).toBe("Recipes")
  expect((await lib.search("car", { embedder: standIn, bases: ["kitchen"] })).map((h) => h.title)).not.toContain("Service")
  // Another model: every piece is embedded again.
  expect(await lib.embedAll({ ...standIn, model: "test/other" })).toBe(2)
})

let fake: Fake | undefined
let server: ReturnType<typeof Bun.serve> | undefined
afterEach(() => (fake?.stop(), server?.stop(true)))

test("an OpenAI-shaped /embeddings: in order, unit length", async () => {
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const { input } = (await req.json()) as { input: string[] }
      return Response.json({ data: input.map((_, i) => ({ index: i, embedding: [3, 4] })).reverse() })
    },
  })
  // The server's embedding model, by its served id.
  const loaded = { connections: { emb: { base_url: `http://127.0.0.1:${server.port}/v1`, models: {}, webui: { url: `http://127.0.0.1:${server.port}`, embeddings: ["llama/nomic"] } } }, refs: [] } as never
  const e = embedderFor(loaded, "llama/nomic")!
  const [v] = await e.embed(["x", "y"])
  expect(Array.from(v!)).toEqual([0.6000000238418579, 0.800000011920929])
  // Not logged in: said.
  expect(() => embedderFor({ connections: {}, refs: [] } as never, "llama/nomic")).toThrow("not logged in")
})

test("ingest: text and code; HTML as markdown; binaries skipped; long text cut and said; links out of the directory ignored", async () => {
  const lib = fresh()
  lib.createBase("b")
  const dir = mkdtempSync(join(tmpdir(), "ph-ingest-"))
  writeFileSync(join(dir, "a.md"), "# Notes\n\nPlain text.")
  writeFileSync(join(dir, "page.html"), "<html><body><main><h1>Title</h1><p>Body text.</p></main><script>x()</script></body></html>")
  writeFileSync(join(dir, "pic.png"), new Uint8Array([137, 80, 78, 71, 0, 0]))
  writeFileSync(join(dir, "big.txt"), "x".repeat(MAX_TEXT_CHARS + 500))
  const outside = mkdtempSync(join(tmpdir(), "ph-outside-"))
  writeFileSync(join(outside, "secret.txt"), "not yours")
  symlinkSync(join(outside, "secret.txt"), join(dir, "link.txt"))
  const added = await ingest(lib, "b", [dir, join(dir, "missing.txt")])
  const by = (end: string) => added.find((a) => a.source.endsWith(end))
  expect(by("a.md")).toMatchObject({ changed: true })
  expect(by("big.txt")).toMatchObject({ truncated: true, chars: MAX_TEXT_CHARS })
  expect(by("pic.png")).toBeUndefined()
  expect(added.some((a) => a.source.includes("secret"))).toBe(false)
  expect(by("missing.txt")!.error).toBe("no such file or directory")
  const html = lib.document(by("page.html")!.id!)!
  expect(html.text).toContain("# Title")
  expect(html.text).not.toContain("x()")
  await expect(ingest(lib, "nope", [dir])).rejects.toThrow("no knowledge base")
})

test("the tools: knowledge_search is offered only with something to search; a project's list narrows it; notes keep their scope", async () => {
  fake = fakeProvider([
    { chunks: [delta({ content: "nothing to search" }, "stop")] },
    { chunks: [toolCall(0, "k1", "knowledge_search", JSON.stringify({ query: "primes" }))] },
    { chunks: [toolCall(0, "k2", "knowledge_get", JSON.stringify({ id: 1 }))] },
    { chunks: [toolCall(0, "n1", "note_manage", JSON.stringify({ action: "create", title: "Pump", body: "Primes in 30 s." }))] },
    { chunks: [delta({ content: "ok" }, "stop")] },
  ])
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  f:\n    type: webui\n    url: ${fake.url}\n    models: { f/m: {} }\n`, { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), "model: f/m\ntitles: prompt\n")
  const cwd = mkdtempSync(join(tmpdir(), "ph-libtools-"))
  mkdirSync(join(cwd, ".agent"))
  writeFileSync(join(cwd, ".agent/config.yaml"), "knowledge: [manuals]\n")
  setTrust(cwd, "trusted")
  const app = createApp({ cwd, store: false, snapshots: false, asker: { ask: async () => ({ kind: "once" }) } })
  const lib = app.library
  for (const b of lib.bases()) lib.deleteBase(b.name)
  for (const n of lib.notes(["global", cwd])) lib.deleteNote(n.id)
  const offered = () => (fake!.requests.at(-1)!.tools as { function: { name: string } }[]).map((t) => t.function.name)
  // Nothing to search yet: not offered.
  lib.createBase("manuals")
  lib.createBase("private")
  lib.putDocument("private", { title: "Diary", source: "d", text: "The pump primes in my dreams." })
  await app.engine.prompt("anything")
  expect(offered()).not.toContain("knowledge_search")
  // A document in the project's base: offered, and only that base is searched.
  const pump = lib.putDocument("manuals", { title: "Pump", source: "p", text: "The pump primes in thirty seconds." })
  fake.requests.length = 0
  app.engine.messages = []
  await app.engine.prompt("how long does the pump take to prime?")
  expect(offered()).toContain("knowledge_search")
  const results = app.engine.messages.filter((m) => m.role === "tool").map((m) => (m.role === "tool" ? m.content : ""))
  expect(results[0]).toContain(`[${pump.id}] Pump (manuals`)
  expect(results[0]).not.toContain("Diary")
  // Document 1 is the diary, in a base this project does not search: not to be read either.
  expect(results[1]).toContain("There is no document 1 in this project's knowledge bases")
  expect(lib.notes([cwd]).map((n) => n.title)).toEqual(["Pump"])
  expect(lib.notes(["global"])).toHaveLength(0)
})
