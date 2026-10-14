import { basename } from "node:path"
import { Show } from "solid-js"
import { isLocal } from "../../config/paths.ts"
import { useTui } from "../context.ts"

const MODE_LABEL = { manual: "manual", edit: "edit", auto: "AUTO", plan: "plan" } as const

export function fmtTokens(n: number): string {
  return n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

/** One line: mode · model · effort on the left; context use and where on the right — or, for a
 *  moment, a flash (a copy) in their place. */
export function StatusBar(p: { mode: () => string; model: () => string; effort: () => string; branch?: string; voice?: () => string; flash?: () => string | undefined; remote?: () => string; credits?: () => string }) {
  const { theme, view, app } = useTui()
  const c = () => theme().colors
  const modeColor = () => ({ manual: c().statusText, edit: c().statusGood, auto: c().statusCritical, plan: c().info })[p.mode() as keyof typeof MODE_LABEL] ?? c().statusText
  const ctx = () => {
    const u = view.state.usage
    if (!u) return { text: "ctx —", color: c().statusDim }
    const used = view.state.used ?? u.input + u.output
    const total = view.state.context
    if (!total) return { text: `ctx ${fmtTokens(used)}${u.estimated ? "~" : ""}`, color: c().statusText }
    const pct = Math.round((used / total) * 100)
    const color = pct >= 90 ? c().statusCritical : pct >= 75 ? c().statusBad : pct >= 50 ? c().statusWarn : c().statusGood
    return { text: `ctx ${fmtTokens(used)}${u.estimated ? "~" : ""}/${fmtTokens(total)} ${pct}%`, color }
  }
  return (
    <box height={1} flexDirection="row" justifyContent="space-between" backgroundColor={c().panel} paddingLeft={1} paddingRight={1}>
      <text wrapMode="none" truncate>
        <span style={{ fg: modeColor() }}>{MODE_LABEL[p.mode() as keyof typeof MODE_LABEL] ?? p.mode()}</span>
        <span style={{ fg: c().statusDim }}> · </span>
        <span style={{ fg: c().statusStrong }}>{p.model()}</span>
        <span style={{ fg: c().statusDim }}>{p.effort() ? ` · ${p.effort()}` : ""}</span>
        <span style={{ fg: p.voice?.().startsWith("●") ? c().statusCritical : c().statusText }}>{p.voice?.() ? ` · ${p.voice()}` : ""}</span>
        <span style={{ fg: c().info }}>{p.remote?.() ? ` · ${p.remote()}` : ""}</span>
      </text>
      <Show
        when={p.flash?.()}
        fallback={
          <text wrapMode="none">
            <span style={{ fg: c().statusDim }}>{view.state.rate ? `${Math.round(view.state.rate)} tok/s · ` : ""}</span>
            <span style={{ fg: c().statusText }}>{p.credits?.() ? `${p.credits()} · ` : ""}</span>
            <span style={{ fg: ctx().color }}>{ctx().text}</span>
            <span style={{ fg: c().statusDim }}> · </span>
            <span style={{ fg: c().info }}>{isLocal() ? "local " : ""}</span>
            <span style={{ fg: c().statusDim }}>{basename(app.project.root)}{p.branch ? `@${p.branch}` : ""}</span>
          </text>
        }
      >
        <text wrapMode="none" fg={c().statusGood}>
          {p.flash!()}
        </text>
      </Show>
    </box>
  )
}
