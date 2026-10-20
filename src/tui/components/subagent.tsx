import type { ScrollBoxRenderable } from "@opentui/core"
import { createSignal, onCleanup } from "solid-js"
import { duration } from "../../duration.ts"
import { TuiContext, useTui } from "../context.ts"
import type { View } from "../state.ts"
import { jobWords } from "./messages.tsx"
import { Messages } from "./messages.tsx"

/** A subagent entered from /jobs: its transcript in place of the session's, under a header line
 *  `subagent explore · job7 · running 1m 12s · esc back · type to message`. The items are the
 *  child's own View (fed by its bus; Root keeps one per job), read-only here; what is typed goes to
 *  the job through Root. The clock ticks while it runs. */
export function SubagentView(p: { id: string; view: View; scrollRef?: (r: ScrollBoxRenderable) => void }) {
  const ctx = useTui()
  const { theme, app } = ctx
  const c = () => theme().colors
  const [rev, setRev] = createSignal(0)
  const bump = () => setRev((n) => n + 1)
  const job = () => (rev(), app.registry.get(app.jobsSessionId(), p.id))
  const off = app.bus.on((e) => e.type === "job" && e.job.id === p.id && bump())
  const clock = setInterval(bump, 1000)
  onCleanup(() => {
    off()
    clearInterval(clock)
  })
  const head = () => {
    const j = job()
    if (!j) return `subagent · ${p.id} · gone · esc back`
    const state = j.state === "running" ? `running ${duration(Date.now() - j.started, true)}` : jobWords(j)
    const message = j.subagent ? "type to message" : "cannot be messaged (an earlier process ran it)"
    return [`subagent ${j.agent ?? ""}`.trimEnd(), j.id, state, "esc back", message].join(" · ")
  }
  const what = () => job()?.description ?? ""
  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="column" paddingLeft={1} flexShrink={0} height={2} backgroundColor={c().panel}>
        <text fg={c().info} wrapMode="none" truncate height={1}>
          {head()}
        </text>
        <text fg={c().muted} wrapMode="none" truncate height={1}>
          {what()}
        </text>
      </box>
      <TuiContext.Provider value={{ ...ctx, view: p.view }}>
        <scrollbox
          ref={(r: ScrollBoxRenderable) => p.scrollRef?.(r)}
          flexGrow={1}
          stickyScroll
          stickyStart="bottom"
          viewportOptions={{ paddingRight: 1 }}
          verticalScrollbarOptions={{ trackOptions: { backgroundColor: c().panel, foregroundColor: c().dim } }}
        >
          <Messages />
        </scrollbox>
      </TuiContext.Provider>
    </box>
  )
}
