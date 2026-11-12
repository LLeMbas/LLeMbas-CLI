// How the transcript draws a tool call and the end of a reply (harness spec 3.7.0, display.md).
import { afterEach, expect, test } from "bun:test"
import { delta, toolCall, usage } from "../fake-provider.ts"
import { tui } from "./harness.tsx"

let t: Awaited<ReturnType<typeof tui>> | undefined
afterEach(() => t?.stop())

test("a call keeps one title; done shows its facts and how long it took, failed its exit code, denied its reason and no time", async () => {
  t = await tui(
    [
      {
        chunks: [
          toolCall(0, "c1", "grep", '{"pattern":"hello","path":"."}'),
          toolCall(1, "c2", "edit", '{"path":"hello.txt","old":"hello world","new":"hello there\\nworld"}'),
          toolCall(2, "c3", "bash", '{"command":"exit 3","description":"Fail on purpose"}'),
          toolCall(3, "c4", "bash", '{"command":"git push origin main","description":"Push"}'),
        ],
      },
      { chunks: [delta({ content: "All done." }), usage(100, 5)] },
    ],
    { width: 110, height: 34 },
    "mode: auto\npermission:\n  bash:\n    'git push *': deny\n",
  )
  await t.input.typeText("@hello.txt do things")
  t.input.pressEnter()
  expect(await t.until("All done.")).toBe(true)
  const f = t.frame()
  // A search is titled by its pattern, and says its hits.
  expect(f).toMatch(/grep   hello · 1 hit · \d+\.\ds/)
  // An edit: the path, +added −removed, the time.
  expect(f).toMatch(/edit   hello\.txt · \+2 −1 · \d+\.\ds/)
  // A command that failed: its own line as the title (not its description), the exit code.
  expect(f).toMatch(/bash   exit 3 · exit 3 · \d+\.\ds ✗/)
  // Denied: the same title, the reason, and no duration — it never ran.
  const denied = f.split("\n").find((l) => l.includes("git push origin main"))!
  expect(denied).toContain("git push origin main · ")
  expect(denied).not.toMatch(/\d+\.\ds/)
  expect(denied).not.toContain("✗")
})

test("a reply that fails ends with the spec's line, once; one stopped by esc says Stopped: by you", async () => {
  t = await tui([
    { status: 400, body: '{"error":{"message":"the model is not loaded"}}' },
    { status: 400, body: '{"error":{"message":"the model is not loaded"}}' },
    { status: 400, body: '{"error":{"message":"the model is not loaded"}}' },
    { chunks: [delta({ content: "Slow" }), delta({ content: "er" }), delta({ content: " still" }), delta({ content: " going" })], gapMs: 400 },
  ])
  await t.input.typeText("go")
  t.input.pressEnter()
  expect(await t.until("✗ Failed: ")).toBe(true)
  const f = t.frame()
  expect(f).toContain("the model is not loaded")
  // Said once: no second, raw copy of the error beside the line.
  expect(f.split("the model is not loaded").length - 1).toBe(1)
  expect(f.split("Failed").length - 1).toBe(1)
  await t.input.typeText("again")
  t.input.pressEnter()
  expect(await t.until("Slow")).toBe(true)
  t.input.pressEscape()
  expect(await t.until("■ Stopped: by you")).toBe(true)
  // The earlier reply still says how it ended: the line stays on it.
  expect(t.frame()).toContain("✗ Failed: ")
  expect(t.frame()).not.toContain("cancelled")
})

test("a session shown again from the store says how its last reply ended", async () => {
  t = await tui([{ chunks: [delta({ content: "Half an ans" }), delta({ content: "wer" }), delta({ content: " and" }), delta({ content: " more" })], gapMs: 400 }], undefined, "", { store: true })
  await t.input.typeText("tell me")
  t.input.pressEnter()
  expect(await t.until("Half an ans")).toBe(true)
  t.input.pressEscape()
  expect(await t.until("■ Stopped: by you")).toBe(true)
  const id = t.app.engine.sessionId!
  expect(t.app.engine.storedEnd()).toEqual({ reason: "cancelled" })
  t.view.load(t.app.resume(id), t.app.engine.storedEnd())
  await t.settle()
  expect(t.frame()).toContain("■ Stopped: by you")
})

// ---- found in review ----

test("the stored end belongs to its turn: /undo takes it away; a reply that finished is never drawn stopped", async () => {
  t = await tui(
    [{ chunks: [delta({ content: "Fine." }), usage(100, 5)] }, { chunks: [delta({ content: "Half" }), delta({ content: " more" }), delta({ content: " more" }), delta({ content: " more" })], gapMs: 400 }],
    undefined,
    "titles: prompt\n", // no second request for a title
    { store: true },
  )
  await t.input.typeText("one")
  t.input.pressEnter()
  expect(await t.until("Fine.")).toBe(true)
  await t.input.typeText("two")
  t.input.pressEnter()
  expect(await t.until("Half")).toBe(true)
  t.input.pressEscape()
  expect(await t.until("■ Stopped: by you")).toBe(true)
  await t.settle()
  expect(t.app.engine.storedEnd()).toEqual({ reason: "cancelled" })
  await t.input.typeText("/undo")
  t.input.pressEnter()
  await t.settle(300)
  // The stopped turn is gone from the conversation: so is how it ended.
  expect(t.app.engine.storedEnd()).toBeUndefined()
  const id = t.app.engine.sessionId!
  t.view.load(t.app.resume(id), t.app.engine.storedEnd())
  await t.settle()
  expect(t.frame()).toContain("Fine.")
  expect(t.frame()).not.toContain("Stopped")
})

test("a call whose result never came is drawn failed when the session is shown again; the person's own !command is not the turn's", async () => {
  t = await tui([{ chunks: [delta({ content: "Slow" }), delta({ content: "ly" }), delta({ content: " said." }), usage(100, 5)], gapMs: 300 }])
  // A stored conversation that ends in a call with no result (the process went away mid-call).
  t.view.load([
    { role: "user", parts: [{ type: "text", text: "run it" }] },
    { role: "assistant", parts: [{ type: "tool_call", id: "c1", name: "bash", args: '{"command":"make all"}' }, { type: "tool_call", id: "c2", name: "read", args: '{"path":"a.txt"}' }] },
    { role: "tool", callId: "c2", content: "1: hello", isError: false },
  ] as never)
  await t.settle()
  const items = t.view.state.items.filter((i) => i.kind === "tool") as { id: string; status: string; title?: string }[]
  expect(items.map((i) => [i.id, i.status, i.title])).toEqual([
    ["c1", "error", "make all"],
    ["c2", "done", "a.txt"],
  ])
  expect(t.frame()).toMatch(/bash   make all.*✗/)
  // A `!` command still running when a turn ends stays running: it was never part of the turn.
  const own = t.view.shellStart("sleep 30")
  await t.input.typeText("go")
  t.input.pressEnter()
  expect(await t.until("ly said.")).toBe(true)
  await t.settle()
  const mine = t.view.state.items.find((i) => i.kind === "tool" && i.id === own) as { status: string }
  expect(mine.status).toBe("running")
})

test("a refused call is titled from its arguments as a call that runs gets them, not the model's raw JSON", async () => {
  t = await tui(
    [{ chunks: [toolCall(0, "c1", "bash", '{"command":"git push origin main","purpose":"Publish the branch"}')] }, { chunks: [delta({ content: "Not pushed." }), usage(100, 5)] }],
    undefined,
    "mode: auto\npermission:\n  bash:\n    'git push *': deny\n",
  )
  const denied: { args?: unknown; title?: string }[] = []
  t.app.bus.on((e) => void (e.type === "tool_denied" && denied.push(e)))
  await t.input.typeText("push")
  t.input.pressEnter()
  expect(await t.until("Not pushed.")).toBe(true)
  expect(denied[0]!.title).toBe("git push origin main")
  // `purpose` is the harness's own argument, taken off before the tool sees the call.
  expect(denied[0]!.args).toEqual({ command: "git push origin main" })
})
