import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createSignal, For, Show } from "solid-js"
import type { Answer } from "../../tool/ask_user.ts"
import { useTui } from "../context.ts"
import type { PendingQuestion } from "../state.ts"

const SOMETHING_ELSE = "Something else…"
const ASK_BACK = "Ask back…"

/** The question tool's card: one question at a time; ↑↓ move, enter/1–9 pick, space toggles when
 *  several may apply, the last two rows take your own words or a question back; esc skips all. */
export function QuestionCard(p: { pending: PendingQuestion }) {
  const { theme } = useTui()
  const c = () => theme().colors
  const qs = () => p.pending.req.questions
  const [qi, setQi] = createSignal(0)
  const [sel, setSel] = createSignal(0)
  const [picked, setPicked] = createSignal<Set<number>>(new Set())
  const [typing, setTyping] = createSignal<"custom" | "back" | undefined>()
  const answers: Answer[] = []

  const q = () => qs()[qi()]!
  const rows = () => [...q().options.map((o) => o.label), SOMETHING_ELSE, ASK_BACK]
  const answer = (a: Answer) => {
    answers[qi()] = a
    if (qi() + 1 < qs().length) {
      setQi(qi() + 1)
      setSel(0)
      setPicked(new Set<number>())
      setTyping(undefined)
    } else p.pending.resolve({ answers })
  }
  const choose = (i: number) => {
    const n = q().options.length
    if (i === n) return setTyping("custom")
    if (i === n + 1) return setTyping("back")
    if (q().multiple) {
      const set = new Set(picked())
      if (set.size === 0) set.add(i)
      answer({ kind: "options", labels: [...set].sort((a, b) => a - b).map((k) => q().options[k]!.label) })
    } else answer({ kind: "options", labels: [q().options[i]!.label] })
  }

  useKeyboard((key) => {
    if (typing()) {
      if (key.name === "escape") {
        setTyping(undefined)
        key.preventDefault()
      }
      return
    }
    const n = rows().length
    if (key.name === "up") setSel((i) => (i + n - 1) % n)
    else if (key.name === "down" || key.name === "tab") setSel((i) => (i + 1) % n)
    else if (key.name === "space" && q().multiple && sel() < q().options.length) {
      const set = new Set(picked())
      set.has(sel()) ? set.delete(sel()) : set.add(sel())
      setPicked(set)
    } else if (key.name === "return") choose(sel())
    else if (key.name === "escape") p.pending.resolve({ dismissed: true })
    else if (/^[1-9]$/.test(key.name ?? "") && Number(key.name) <= q().options.length) choose(Number(key.name) - 1)
    else return
    key.preventDefault()
  })

  return (
    <box border borderStyle="rounded" borderColor={c().info} paddingLeft={1} paddingRight={1} flexDirection="column" title={` ${q().header}${qs().length > 1 ? ` · ${qi() + 1}/${qs().length}` : ""} `} titleColor={c().info}>
      <Show when={p.pending.req.why && qi() === 0}>
        <text fg={c().muted} wrapMode="word">
          {p.pending.req.why}
        </text>
      </Show>
      <text fg={c().text} attributes={TextAttributes.BOLD} wrapMode="word">
        {q().question}
      </text>
      <For each={rows()}>
        {(label, i) => {
          const opt = () => q().options[i()]
          const active = () => i() === sel()
          const mark = () => (q().multiple && opt() ? (picked().has(i()) ? "[x] " : "[ ] ") : "")
          return (
            <box flexDirection="column" backgroundColor={active() ? c().menuCurrent : undefined}>
              <text wrapMode="word" fg={active() ? c().title : opt() ? c().text : c().muted}>
                {active() ? "› " : "  "}
                {opt() ? `${i() + 1}. ` : "   "}
                {mark()}
                {label}
                <span style={{ fg: c().ok }}>{opt()?.recommended ? " (Recommended)" : ""}</span>
              </text>
              <Show when={opt()?.description}>
                <text fg={c().muted} wrapMode="word">
                  {"       "}
                  {opt()!.description}
                </text>
              </Show>
            </box>
          )
        }}
      </For>
      <Show when={typing()}>
        <box flexDirection="row">
          <text fg={c().label}>{typing() === "back" ? "your question › " : "your answer › "}</text>
          <input
            focused
            flexGrow={1}
            textColor={c().text}
            placeholder={typing() === "back" ? "the model answers it, then asks again" : "type, enter to send, esc to go back"}
            onSubmit={(v: unknown) => {
              const text = String(v ?? "").trim()
              if (text) answer(typing() === "back" ? { kind: "back", text } : { kind: "custom", text })
            }}
          />
        </box>
      </Show>
      <text fg={c().dim}>↑↓ move · enter or 1–9 choose{q().multiple ? " · space toggles" : ""} · esc skip</text>
    </box>
  )
}
