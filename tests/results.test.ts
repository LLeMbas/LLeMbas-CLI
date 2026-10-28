// Context hygiene through the engine (harness spec 3.0.0, context.md): ids, stubs, the cap, recall,
// and the rule that a stub only ever points at a result still in the conversation. The texts are
// the conformance area `context`'s; here they are checked where the engine inserts them.
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../src/app.ts"
import type { AskReply } from "../src/bus/index.ts"
import { paths } from "../src/config/paths.ts"
import { Store } from "../src/session/store.ts"
import { delta, fakeProvider, toolCall, type Fake } from "./fake-provider.ts"

let fake: Fake | undefined
afterEach(() => fake?.stop())

const yes = { ask: async (): Promise<AskReply> => ({ kind: "once" }) }

function setup(script: Parameters<typeof fakeProvider>[0]) {
  fake = fakeProvider(script)
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  fake:\n    type: webui\n    url: ${fake.url}\n    models:\n      fake/m: { context: 32768 }\n`, { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), "model: fake/m\n")
  const dir = mkdtempSync(join(tmpdir(), "lembas-results-"))
  writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n")
  return dir
}

/** The tool results the model was sent in request `i`, in order. */
const sent = (i: number): string[] => fake!.requests[i].messages.filter((m: any) => m.role === "tool").map((m: any) => m.content as string)

test("an unchanged re-read is a stub; after an edit the file is read in full; a repeated listing is a stub", async () => {
  const dir = setup([
    { chunks: [toolCall(0, "c1", "read", '{"path":"a.txt"}')] },
    { chunks: [toolCall(0, "c2", "read", '{"path":"a.txt","offset":2,"limit":1}')] },
    { chunks: [toolCall(0, "c3", "glob", '{"pattern":"*.txt"}')] },
    { chunks: [toolCall(0, "c4", "glob", '{"pattern":"*.txt"}')] },
    { chunks: [toolCall(0, "c5", "edit", JSON.stringify({ path: "a.txt", old: "two", new: "2" }))] },
    { chunks: [toolCall(0, "c6", "read", '{"path":"a.txt"}')] },
    { chunks: [delta({ content: "done" })] },
  ])
  const app = createApp({ cwd: dir, mode: "edit", asker: yes, store: false })
  await app.engine.prompt("go")
  const r = sent(6)
  expect(r[0]).toMatch(/^\[#0001 a\.txt lines 1-3 of 3 sha ([0-9a-f]{8})\]\n1: one\n2: two\n3: three$/)
  const sha = /sha ([0-9a-f]{8})/.exec(r[0]!)![1]
  expect(r[1]).toBe(`[#0002 a.txt lines 2-2 of 3 sha ${sha}] Unchanged since #0001, which already shows lines 1-3.`)
  expect(r[2]).toBe(`[#0003]\n${join(dir, "a.txt")}`)
  expect(r[3]).toBe("[#0004] Same result as #0003.")
  expect(r[4]).toMatch(/^\[#0005 a\.txt sha [0-9a-f]{8}\]\n@@ -1,3 \+1,3 @@\n one\n-two\n\+2\n three$/)
  expect(r[5]).toMatch(/^\[#0006 a\.txt lines 1-3 of 3 sha [0-9a-f]{8}\]\n1: one\n2: 2\n3: three$/)
  // The prompt says what the ids and stubs are.
  expect(fake!.requests[0].messages[0].content).toContain("# Tool results\n- Every tool result starts with its id in brackets")
})

test("a long output keeps its head and tail; recall shows it whole, from the store, after a resume too", async () => {
  const dir = setup([
    { chunks: [toolCall(0, "c1", "bash", JSON.stringify({ command: "seq 1 1000", description: "count" }))] },
    { chunks: [toolCall(0, "c2", "recall", '{"id":"#0001","offset":500,"limit":3}')] },
    { chunks: [delta({ content: "done" })] },
    // After a resume: a new id, never one given before; an unknown one said so.
    { chunks: [toolCall(0, "c3", "recall", '{"id":"0001","offset":999}'), toolCall(1, "c4", "recall", '{"id":"#ffff"}')] },
    { chunks: [delta({ content: "again" })] },
  ])
  const store = new Store()
  const app = createApp({ cwd: dir, mode: "auto", asker: yes, store, modelTitles: false })
  await app.engine.prompt("count")
  const r = sent(2)
  const lines = r[0]!.split("\n")
  expect(lines[0]).toBe("[#0001]")
  expect(lines.slice(1, 3)).toEqual(["1", "2"])
  expect(r[0]).toContain("\n200\n[")
  expect(r[0]).toMatch(/\n\[\d+ lines elided, full output #0001\]\n/)
  expect(r[0]).toContain("\n1000\n\n[exit 0]")
  expect(r[1]).toBe("[#0002 recall #0001 lines 500-502 of 1002]\n500\n501\n502")
  const id = app.engine.sessionId!
  const again = createApp({ cwd: dir, mode: "auto", asker: yes, store, resuming: id, modelTitles: false })
  again.resume(id)
  await again.engine.prompt("more")
  const s = sent(4)
  expect(s.slice(-2)).toEqual(["[#0003 recall #0001 lines 999-1002 of 1002]\n999\n1000\n\n[exit 0]", "[#0004] No stored result #ffff in this session."])
})

test("a stub never points at a result that left the conversation: after /undo the file is read in full", async () => {
  const dir = setup([
    { chunks: [toolCall(0, "c1", "read", '{"path":"a.txt"}')] },
    { chunks: [delta({ content: "read" })] },
    { chunks: [toolCall(0, "c2", "read", '{"path":"a.txt"}')] },
    { chunks: [delta({ content: "read again" })] },
  ])
  const app = createApp({ cwd: dir, mode: "edit", asker: yes, store: false })
  await app.turns.prompt("read it", [], "read it")
  await app.turns.undo()
  await app.turns.prompt("read it", [], "read it")
  expect(sent(3)).toHaveLength(1)
  expect(sent(3)[0]).toMatch(/^\[#0002 a\.txt lines 1-3 of 3 sha [0-9a-f]{8}\]\n1: one/)
})
