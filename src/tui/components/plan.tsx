import { For, Show } from "solid-js"
import { open, summary, type TaskStatus } from "../../plan/plan.ts"
import { useTui } from "../context.ts"

const MARK: Record<TaskStatus, string> = { todo: "☐", doing: "▸", done: "☑", dropped: "✗" }

/** The session's plan, above the prompt while anything on it is still to do: the active phase
 *  and the count, the task being done, what is next, the last two done — at most six lines. */
export function PlanPanel() {
  const { theme, view } = useTui()
  const c = () => theme().colors
  const digest = () => (view.state.livePlan ? summary(view.state.livePlan) : undefined)
  return (
    <Show when={view.state.livePlan && open(view.state.livePlan)}>
      <box flexDirection="column" paddingLeft={1}>
        <text fg={c().label} wrapMode="none" truncate>
          {digest()?.head}
        </text>
        <For each={digest()?.lines ?? []}>
          {(t) => (
            <text wrapMode="none" truncate fg={t.status === "doing" ? c().accent : t.status === "done" ? c().dim : c().text}>
              {"  "}
              {MARK[t.status]} {t.text}
            </text>
          )}
        </For>
      </box>
    </Show>
  )
}
