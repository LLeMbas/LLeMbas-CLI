import { afterEach, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal, Show } from "solid-js"
import type { DialogSpec } from "../../src/tui/components/dialog.tsx"
import { Dialog } from "../../src/tui/components/dialog.tsx"
import { TuiContext } from "../../src/tui/context.ts"
import { DEFAULT_THEME } from "../../src/tui/theme.ts"

let setup: Awaited<ReturnType<typeof testRender>> | undefined
afterEach(() => setup?.renderer.destroy())

test("dialog: arrow down + enter picks the second option — with a spec that closing clears, as in the app", async () => {
  const picked: string[] = []
  let closed = 0
  const ctx = { theme: () => DEFAULT_THEME, dims: () => ({ width: 60, height: 16 }) } as never
  const [spec, setSpec] = createSignal<DialogSpec | undefined>({
    title: "Model",
    options: [{ label: "a", value: "a", current: true }, { label: "b", value: "b" }],
    onSelect: (v) => picked.push(v),
  })
  setup = await testRender(
    () => (
      <TuiContext.Provider value={ctx}>
        <Show when={spec()}>
          <Dialog spec={spec()!} close={() => (closed++, setSpec(undefined))} />
        </Show>
      </TuiContext.Provider>
    ),
    { width: 60, height: 16 },
  )
  await setup.renderOnce()
  setup.mockInput.pressArrow("down")
  await setup.renderOnce()
  setup.mockInput.pressEnter()
  await setup.renderOnce()
  expect(picked).toEqual(["b"])
  expect(closed).toBe(1)
})

test("dialog: a range row is one track with two handles — ←→ move the one in focus, tab the other, enter hands both over", async () => {
  const set: [number, number][] = []
  const picked: string[] = []
  const ctx = { theme: () => DEFAULT_THEME, dims: () => ({ width: 72, height: 16 }) } as never
  const [spec, setSpec] = createSignal<DialogSpec | undefined>({
    title: "Effort",
    options: [
      { label: "high", value: "high", current: true },
      { label: "Subagents", value: "team", description: "1 is this agent alone", range: { from: 1, to: 32, lo: 1, hi: 4, names: ["Min", "Max"], onSubmit: (lo, hi) => set.push([lo, hi]) } },
    ],
    onSelect: (v) => picked.push(v),
  })
  setup = await testRender(
    () => (
      <TuiContext.Provider value={ctx}>
        <Show when={spec()}>
          <Dialog spec={spec()!} close={() => setSpec(undefined)} />
        </Show>
      </TuiContext.Provider>
    ),
    { width: 72, height: 16 },
  )
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("Subagents  Min 1 ●")
  setup.mockInput.pressArrow("down")
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("←→ move Max · tab Min")
  setup.mockInput.pressArrow("right")
  setup.mockInput.pressArrow("right")
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("Max 6")
  setup.mockInput.pressTab()
  setup.mockInput.pressArrow("right")
  setup.mockInput.pressArrow("right")
  setup.mockInput.pressArrow("left")
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("Min 2")
  // Min never passes Max, and Min never goes under 1.
  for (let i = 0; i < 10; i++) setup.mockInput.pressArrow("right")
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("Min 6")
  setup.mockInput.pressEnter()
  await setup.renderOnce()
  expect(set).toEqual([[6, 6]])
  expect(picked).toEqual([])
})
