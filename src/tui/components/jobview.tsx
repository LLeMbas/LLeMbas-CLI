import { RGBA, type ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createSignal, onCleanup } from "solid-js"
import { duration } from "../../duration.ts"
import { useTui } from "../context.ts"
import { jobWords } from "./messages.tsx"

/** Of a command's output, how much the view draws: the end of it (the whole buffer is 2 MB). */
const SHOWN = 32_000

/** A command job, live: `job3 · running 1m 12s · k stop · pgup/pgdn scroll · esc back` over a box
 *  that follows the tail of its output. Redrawn on the job's events and once a second for the
 *  clock. Lines longer than the box wrap by character, so nothing is wider than the terminal. */
export function JobView(p: { id: string; close: () => void }) {
  const { theme, dims, app, view } = useTui()
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
  // Looked at: not news any more.
  view.seenJobs(p.id)
  const [stopping, setStopping] = createSignal(false)
  let box: ScrollBoxRenderable | undefined

  useKeyboard((key) => {
    if (key.name === "escape") p.close()
    else if (key.name === "k" && !key.ctrl && !key.meta) {
      const j = job()
      if (j && j.state === "running") {
        app.registry.stop(j)
        setStopping(true)
      }
    } else if (key.name === "pageup") box?.scrollBy(-Math.max(1, Math.floor((box.height || 2) / 2)))
    else if (key.name === "pagedown") box?.scrollBy(Math.max(1, Math.floor((box.height || 2) / 2)))
    else return
    key.preventDefault()
    key.stopPropagation()
  })

  const head = () => {
    const j = job()
    if (!j) return `${p.id} · gone · esc back`
    const state = j.state === "running" ? `running ${duration(Date.now() - j.started, true)}${stopping() ? " · stopping…" : ""}` : jobWords(j)
    return [j.id, state, ...(j.state === "running" ? ["k stop"] : []), "pgup/pgdn scroll", "esc back"].join(" · ")
  }
  // What it is: the model's description, and the command itself where that says more.
  const what = () => {
    const j = job()
    if (!j) return ""
    if (j.kind === "subagent") return `${j.agent ?? "subagent"}: ${j.description}`
    const line = (j.command ?? "").split("\n")[0]!
    return line && line !== j.description ? `${j.description} · $ ${line}` : j.description
  }
  const tail = () => {
    const out = job()?.output ?? ""
    return (out.length > SHOWN ? `…${out.slice(-SHOWN)}` : out) || "(no output yet)"
  }
  const width = () => Math.max(20, dims().width - 4)
  const height = () => Math.max(6, dims().height - 4)
  return (
    <box position="absolute" zIndex={100} left={0} top={0} width={dims().width} height={dims().height} alignItems="center" paddingTop={1} backgroundColor={RGBA.fromInts(0, 0, 0, 140)}>
      <box width={width()} height={height()} border borderStyle="rounded" borderColor={c().border} backgroundColor={c().menu} flexDirection="column" paddingLeft={1} paddingRight={1} title={` ${p.id} `} titleColor={c().title}>
        <box flexDirection="column" flexShrink={0} height={2}>
          <text fg={c().info} wrapMode="none" truncate height={1}>
            {head()}
          </text>
          <text fg={c().muted} wrapMode="none" truncate height={1}>
            {what()}
          </text>
        </box>
        <scrollbox ref={(r: ScrollBoxRenderable) => (box = r)} flexGrow={1} stickyScroll stickyStart="bottom" scrollX={false} viewportOptions={{ paddingRight: 1 }} verticalScrollbarOptions={{ trackOptions: { backgroundColor: c().panel, foregroundColor: c().dim } }}>
          <text fg={c().text} wrapMode="char">
            {tail()}
          </text>
        </scrollbox>
      </box>
    </box>
  )
}
