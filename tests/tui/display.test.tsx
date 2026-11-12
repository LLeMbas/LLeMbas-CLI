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
