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
