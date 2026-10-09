import { createSignal, For, onCleanup } from "solid-js"
import { duration } from "../../duration.ts"
import { useTui } from "../context.ts"
import { fmtTokens } from "./status.tsx"

/** "reading the prompt 64% · 90k of 140k · ~2m left": the server's own count (llama.cpp's
 *  return_progress). The time left is guessed from the reading so far, once there is enough of it;
 *  a long prompt reads slower towards its end, so it is a floor more than a promise. */
export function reading(p: { total: number; done: number; processed: number; ms: number }): string {
  const pct = Math.floor((p.done / p.total) * 100)
  const parts = [`reading the prompt ${pct}%`, `${fmtTokens(p.done)} of ${fmtTokens(p.total)}`]
  if (p.processed >= 2048 && p.ms >= 2000 && p.done < p.total) {
    const left = ((p.total - p.done) / p.processed) * p.ms
    parts.push(`~${duration(left, true)} left`)
  }
  return parts.join(" · ")
}

// Hermes' kawaii spinner: a braille frame, a face that changes every few seconds, what is going on
// (a verb while it thinks), and the whole task's time and output tokens — from the prompt until
// the last reply of the task, subagents included.
export function Spinner() {
  const { theme, view } = useTui()
  const [tick, setTick] = createSignal(0)
  const t = setInterval(() => setTick((n) => n + 1), 100)
  onCleanup(() => clearInterval(t))
  const sp = () => theme().spinner
  const pick = (list: string[], every: number) => list[Math.floor(tick() / every) % list.length] ?? ""
  const elapsed = () => (tick(), view.state.busySince ? duration(Date.now() - view.state.busySince, true) : "0s")
  const tokens = () => {
    tick()
    const { n, estimated } = view.taskTokens()
    return `${estimated ? "~" : ""}${fmtTokens(n)} token${n === 1 ? "" : "s"}`
  }
  const what = () => {
    const s = view.state
    if (s.preparing) return `preparing ${s.preparing}`
    if (s.phase === "waiting" && s.progress) return reading(s.progress)
    if (s.phase === "thinking") return pick(sp().verbs, 30)
    if (s.phase === "tools") return "running tools"
    if (s.phase === "writing") return "writing"
    return "waiting for the model"
  }
  const face = () => (view.state.phase === "thinking" ? pick(sp().thinking, 30) : pick(sp().waiting, 30))
  return (
    <box paddingLeft={1} height={1}>
      <text wrapMode="none" truncate>
        <span style={{ fg: theme().colors.accent }}>{pick(sp().frames, 1)} </span>
        <span style={{ fg: theme().colors.label }}>{face()} </span>
        <span style={{ fg: theme().colors.muted }}>{what()}… </span>
        <span style={{ fg: theme().colors.dim }}>
          {elapsed()} · {tokens()} · esc to stop
        </span>
      </text>
    </box>
  )
}

/** Messages sent while the agent works and not given to it yet — one line each, above the input,
 *  until the next step takes them (or the task ends, in queue mode). */
export function Queued() {
  const { theme, view } = useTui()
  const when = () => (view.state.queued.mode === "queue" ? "after this task" : "at the next step")
  return (
    <For each={view.state.queued.texts}>
      {(text) => (
        <box paddingLeft={1} height={1}>
          <text wrapMode="none" truncate>
            <span style={{ fg: theme().colors.accent }}>↳ queued </span>
            <span style={{ fg: theme().colors.text }}>{text.split("\n")[0]}</span>
            <span style={{ fg: theme().colors.dim }}> · {when()}</span>
          </text>
        </box>
      )}
    </For>
  )
}
