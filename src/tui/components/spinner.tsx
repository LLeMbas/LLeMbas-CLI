import { createSignal, For, onCleanup } from "solid-js"
import { duration } from "../../duration.ts"
import { progressLine } from "../../session/progress.ts"
import { useTui } from "../context.ts"
import { fmtTokens } from "./status.tsx"
import { LOOP } from "../../harness.ts"
import { num } from "../locale.ts"

/** "reading the prompt 64% · 90k of 140k · ~2m left": the server's own count (llama.cpp's
 *  return_progress). The time left is guessed from the reading so far, once there is enough of it;
 *  a long prompt reads slower towards its end, so it is a floor more than a promise. */
/** How long the rest of the prompt will take, from the server's pace so far; "" until it is known. */
export function etaOf(p: { total: number; done: number; processed: number; ms: number }): string {
  if (p.processed >= 2048 && p.ms >= 2000 && p.done < p.total) return `~${duration(((p.total - p.done) / p.processed) * p.ms, true)} left`
  return ""
}

export function reading(p: { total: number; done: number; processed: number; ms: number }): string {
  const pct = Math.floor((p.done / p.total) * 100)
  const parts = [`reading the prompt ${pct}%`, `${fmtTokens(p.done)} of ${fmtTokens(p.total)}`]
  if (p.processed >= 2048 && p.ms >= 2000 && p.done < p.total) {
    const left = ((p.total - p.done) / p.processed) * p.ms
    parts.push(`~${duration(left, true)} left`)
  }
  return parts.join(" · ")
}

// The working line: a braille frame, what is going on (a verb while it thinks), and the whole
// task's time and output tokens — from the prompt until the last reply of the task, subagents
// included.
export function Spinner() {
  const { theme, view } = useTui()
  const [tick, setTick] = createSignal(0)
  const t = setInterval(() => setTick((n) => n + 1), 100)
  onCleanup(() => clearInterval(t))
  const sp = () => theme().spinner
  const pick = (list: string[], every: number) => list[Math.floor(tick() / every) % list.length] ?? ""
  const elapsed = () => (tick(), view.state.busySince ? duration(Date.now() - view.state.busySince, true) : "0s")
  // One clock on the line. The spec's line carries the phase's own (`Thinking · 12s`,
  // progress.md §3); the turn's time is said beside it only once it is another number — the turn
  // has gone through more than this phase — and then as "12s of 1m 05s", not as a second clock.
  const ofTurn = () => {
    const s = view.state
    if (!s.now || (LOOP.progress.no_elapsed as string[]).includes(s.now.phase) || !s.busySince) return ""
    const turn = Date.now() - s.busySince
    return Math.floor(turn / 1000) - Math.floor((Date.now() - s.now.since) / 1000) >= 2 ? ` of ${duration(turn, true)}` : ""
  }
  const tokens = () => {
    tick()
    const { n, estimated } = view.taskTokens()
    return `${estimated ? "~" : ""}${fmtTokens(n)} token${n === 1 ? "" : "s"}`
  }
  const what = () => {
    const s = view.state
    // Spec 3.4.0: the phase the engine says, drawn as every client draws it (progress.md §3).
    if (s.now) {
      tick()
      // The CLI's own look around the shared line: how long the rest of the prompt will take.
      // The server's counts as they come (the phase event is paced for the link; the screen is not).
      const reading = s.now.phase === "reading_prompt" && s.progress
      const now = reading ? { ...s.now, done: s.progress!.done, total: s.progress!.total } : s.now
      const eta = reading ? etaOf(s.progress!) : ""
      return `${progressLine(now, Date.now(), num)}${ofTurn()}${eta ? ` · ${eta}` : ""}`
    }
    if (s.preparing) return `preparing ${s.preparing}`
    if (s.phase === "waiting" && s.progress) return reading(s.progress)
    if (s.phase === "thinking") return pick(sp().verbs, 30)
    if (s.phase === "tools") return "running tools"
    if (s.phase === "writing") return "writing"
    return "waiting for the model"
  }
  return (
    <box paddingLeft={1} height={1}>
      <text wrapMode="none" truncate>
        <span style={{ fg: theme().colors.accent }}>{pick(sp().frames, 1)} </span>
        <span style={{ fg: theme().colors.muted }}>{what()}{view.state.now ? " · " : "… "}</span>
        <span style={{ fg: theme().colors.dim }}>
          {view.state.now ? "" : `${elapsed()} · `}
          {tokens()} · esc to stop
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
