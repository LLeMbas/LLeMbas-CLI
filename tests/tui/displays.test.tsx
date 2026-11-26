import { afterEach, expect, test } from "bun:test"
import { delta, toolCall } from "../fake-provider.ts"
import { tui } from "./harness.tsx"

let t: Awaited<ReturnType<typeof tui>> | undefined
afterEach(() => t?.stop())

test("side display shows live activity, files, changes, and toggles with /display", async () => {
  t = await tui(
    [
      { chunks: [toolCall(0, "r1", "read", JSON.stringify({ path: "hello.txt" }))] },
      { chunks: [delta({ content: "Read hello.txt." }, "stop")] },
    ],
    { width: 120, height: 35 },
    "displays: true\n",
  )
  expect(t.frame()).toContain("Live")
  expect(t.frame()).toContain("Files")
  expect(t.frame()).toContain("Changes")
  expect(t.frame()).toContain("Bash")

  await t.input.typeText("read hello.txt")
  t.input.pressEnter()
  expect(await t.until("Read hello.txt.")).toBe(true)
  expect(t.frame()).toContain("Files (1)")

  // Switch to Files tab via /display files
  await t.input.typeText("/display files")
  t.input.pressEnter()
  expect(await t.until("hello world")).toBe(true)

  // Hide side display via /display off
  await t.input.typeText("/display off")
  t.input.pressEnter()
  expect(await t.until("side display hidden")).toBe(true)
  expect(t.frame()).not.toContain("Alt+↑↓ tabs")
})
