import { For, Show } from "solid-js"
import { useTui } from "../context.ts"

const MARK = { pending: "☐", in_progress: "▸", completed: "☑", cancelled: "✗" } as const

/** The todo tool's list, above the prompt while anything on it is still open. */
export function Todos() {
  const { theme, view } = useTui()
  const c = () => theme().colors
  const open = () => view.state.todos.some((t) => t.status === "pending" || t.status === "in_progress")
  const done = () => view.state.todos.filter((t) => t.status === "completed").length
  // The item in progress, what is left, then the latest done — at most six lines.
  const shown = () => {
    const t = view.state.todos
    const order = [...t.filter((x) => x.status === "in_progress"), ...t.filter((x) => x.status === "pending"), ...t.filter((x) => x.status === "completed").slice(-2)]
    return order.slice(0, 6)
  }
  return (
    <Show when={open()}>
      <box flexDirection="column" paddingLeft={1}>
        <text fg={c().label}>
          todo {done()}/{view.state.todos.length}
        </text>
        <For each={shown()}>
          {(t) => (
            <text wrapMode="none" truncate fg={t.status === "in_progress" ? c().accent : t.status === "completed" ? c().dim : c().text}>
              {"  "}
              {MARK[t.status]} {t.content}
            </text>
          )}
        </For>
      </box>
    </Show>
  )
}
