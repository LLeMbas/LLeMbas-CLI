import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createSignal, For, Show } from "solid-js"
import type { PlanReply } from "../../tool/plan_exit.ts"
import { useTui } from "../context.ts"

export interface PendingPlan {
  path: string
  text: string
  resolve: (r: PlanReply) => void
}

const CHOICES = [
  { key: "a", label: "Approve — edit mode", reply: { kind: "approve", mode: "edit" } },
  { key: "m", label: "Approve — manual mode", reply: { kind: "approve", mode: "manual" } },
  { key: "r", label: "Revise…", reply: "revise" },
  { key: "?", label: "Ask back…", reply: "back" },
] as const

/** plan_submit's card: the plan itself (scroll with pgup/pgdn), then a | m | r | ?; esc keeps planning. */
export function PlanCard(p: { pending: PendingPlan }) {
  const { theme, md, dims } = useTui()
  const c = () => theme().colors
  const [sel, setSel] = createSignal(0)
  const [typing, setTyping] = createSignal<"revise" | "back">()
  let box: ScrollBoxRenderable | undefined

  const choose = (i: number) => {
    const ch = CHOICES[i]!
    if (ch.reply === "revise" || ch.reply === "back") return setTyping(ch.reply)
    p.pending.resolve(ch.reply as PlanReply)
  }

  useKeyboard((key) => {
    if (typing()) {
      if (key.name === "escape") {
        setTyping(undefined)
        key.preventDefault()
      }
      return
    }
    if (key.name === "left" || (key.name === "tab" && key.shift)) setSel((i) => (i + CHOICES.length - 1) % CHOICES.length)
    else if (key.name === "right" || key.name === "tab") setSel((i) => (i + 1) % CHOICES.length)
    else if (key.name === "return") choose(sel())
    else if (key.name === "escape") p.pending.resolve({ kind: "dismissed" })
    else if (key.name === "pageup") box?.scrollBy(-5)
    else if (key.name === "pagedown") box?.scrollBy(5)
    else {
      const i = CHOICES.findIndex((ch) => ch.key === key.name || ch.key === key.sequence)
      if (i < 0) return
      choose(i)
    }
    key.preventDefault()
  })

  return (
    <box border borderStyle="rounded" borderColor={c().info} flexDirection="column" paddingLeft={1} paddingRight={1} title={` plan · ${p.pending.path} `} titleColor={c().info}>
      <scrollbox ref={(r: ScrollBoxRenderable) => (box = r)} maxHeight={Math.max(6, Math.floor(dims().height / 2))} scrollX={false}>
        <markdown content={p.pending.text} syntaxStyle={md()} fg={c().text} conceal />
      </scrollbox>
      <Show
        when={!typing()}
        fallback={
          <box flexDirection="row">
            <text fg={c().label}>{typing() === "revise" ? "what should change? " : "your question: "}</text>
            <input
              focused
              flexGrow={1}
              textColor={c().text}
              placeholder="enter to send, esc to go back"
              onSubmit={(v: unknown) => {
                const t = String(v ?? "").trim()
                if (t) p.pending.resolve(typing() === "revise" ? { kind: "revise", feedback: t } : { kind: "back", text: t })
              }}
            />
          </box>
        }
      >
        <box flexDirection="row" flexWrap="wrap" gap={1}>
          <For each={CHOICES}>
            {(ch, i) => (
              <text fg={i() === sel() ? c().panel : c().text} bg={i() === sel() ? c().info : undefined} attributes={i() === sel() ? TextAttributes.BOLD : 0}>
                {` ${ch.key} ${ch.label} `}
              </text>
            )}
          </For>
        </box>
        <text fg={c().dim}>pgup/pgdn scroll · esc keep planning</text>
      </Show>
    </box>
  )
}
