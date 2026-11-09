import { RGBA, TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useTui } from "../context.ts"

export interface Option {
  label: string
  value: string
  description?: string
  current?: boolean
  /** A two-handle range on this row (the Subagents setting, harness team.md §2: one range from 1
   *  to the cap, Min and Max). While the row is highlighted ←→ move the handle in focus and tab
   *  moves the focus; Min never passes Max. Enter calls `onSubmit` with both, not `onSelect`. */
  range?: Range
}

export interface Range {
  /** The bounds of the track. */
  from: number
  to: number
  /** The handles' values. */
  lo: number
  hi: number
  /** The handles' names (Min, Max). */
  names: [string, string]
  onSubmit: (lo: number, hi: number) => void
}

/** The track as text: `─` outside the range, `━` inside it, `●` for a handle. */
export function rangeTrack(r: Pick<Range, "from" | "to">, lo: number, hi: number, width = 16): { before: string; lo: string; between: string; hi: string; after: string } {
  const span = Math.max(1, r.to - r.from)
  const at = (v: number) => Math.round(((v - r.from) / span) * (width - 1))
  const a = at(lo)
  const b = Math.max(at(hi), a + (hi > lo ? 1 : 0))
  return { before: "─".repeat(a), lo: "●", between: "━".repeat(Math.max(0, b - a - 1)), hi: b > a ? "●" : "", after: "─".repeat(Math.max(0, width - 1 - b)) }
}

export interface DialogSpec {
  title: string
  options: Option[]
  onSelect: (value: string) => void
  /** Filter as you type (on by default for more than 8 options). */
  filter?: boolean
  /** What was typed can itself be the answer: a first row `<label> "<typed>"` (implies filter). */
  custom?: { label: string; onSubmit: (text: string) => void }
  /** More keys on the highlighted row — the Resume picker's ctrl+d deletes the session
   *  under it. The dialog closes first, as for enter; `when(key)` says whether a key is this one. */
  keys?: { when: (key: { name: string; ctrl?: boolean; meta?: boolean; shift?: boolean }) => boolean; run: (value: string) => void }[]
  /** The footer in place of `↑↓ move · enter choose · esc close`, to name those keys: a
   *  binding nobody is told about is one nobody finds, which is how delete went unseen in /sessions. */
  hint?: string
  /** Columns the box may take (72 by default; the terminal less four is the ceiling either way):
   *  a list whose rows are columns of their own (/jobs) asks for more. */
  width?: number
  /** The dialog is gone, however it went (chosen, esc, replaced): a list that follows events
   *  while it is shown stops following here. */
  onClose?: () => void
}

const CUSTOM = "\u0000custom"

/** A modal list: type to filter, ↑↓ to move, enter to choose, esc to close. */
export function Dialog(p: { spec: DialogSpec; close: () => void }) {
  const { theme, dims } = useTui()
  const c = () => theme().colors
  const [query, setQuery] = createSignal("")
  const filterable = () => p.spec.custom !== undefined || (p.spec.filter ?? p.spec.options.length > 8)
  const shown = createMemo(() => {
    const q = query().toLowerCase()
    const hits = q ? p.spec.options.filter((o) => (o.label + " " + (o.description ?? "")).toLowerCase().includes(q)) : p.spec.options
    return p.spec.custom && query().trim() ? [{ label: `${p.spec.custom.label} "${query().trim()}"`, value: CUSTOM }, ...hits] : hits
  })
  // A range row's handles, moved while the dialog is open and handed over on enter; esc drops them.
  const [ranges, setRanges] = createSignal<Record<string, [number, number]>>({})
  const [focus, setFocus] = createSignal<0 | 1>(1)
  const valuesOf = (o: Option): [number, number] => ranges()[o.value] ?? [o.range!.lo, o.range!.hi]
  const move = (o: Option, by: number) => {
    const r = o.range!
    const [lo, hi] = valuesOf(o)
    const next: [number, number] = focus() === 0 ? [Math.min(hi, Math.max(r.from, lo + by)), hi] : [lo, Math.min(r.to, Math.max(lo, hi + by))]
    setRanges((m) => ({ ...m, [o.value]: next }))
  }
  const start = Math.max(0, p.spec.options.findIndex((o) => o.current))
  const [sel, setSel] = createSignal(start)
  // The spec is live: a list that redraws itself with fewer rows keeps the cursor on a row.
  createEffect(() => {
    const n = shown().length
    if (n && sel() >= n) setSel(n - 1)
  })
  // Taken once: the spec that opened the dialog says what to do when it goes.
  const onClose = p.spec.onClose
  onCleanup(() => onClose?.())
  const visible = () => Math.max(3, Math.min(14, dims().height - 10))
  const offset = () => Math.max(0, Math.min(sel() - Math.floor(visible() / 2), shown().length - visible()))

  useKeyboard((key) => {
    const n = shown().length
    const bound = p.spec.keys?.find((k) => k.when(key))
    if (bound) {
      const o = shown()[sel()]
      if (o && o.value !== CUSTOM) {
        // Taken before closing, as for enter: closing clears the spec.
        const run = bound.run
        p.close()
        run(o.value)
      }
    } else if (key.name === "escape") p.close()
    else if (shown()[sel()]?.range && (key.name === "left" || key.name === "right")) move(shown()[sel()]!, key.name === "left" ? -1 : 1)
    else if (shown()[sel()]?.range && key.name === "tab") setFocus((f) => (f === 0 ? 1 : 0))
    else if (key.name === "up" || (key.ctrl && key.name === "p")) setSel((i) => (i + n - 1) % Math.max(n, 1))
    else if (key.name === "down" || (key.ctrl && key.name === "n")) setSel((i) => (i + 1) % Math.max(n, 1))
    else if (key.name === "return") {
      const o = shown()[sel()]
      if (o) {
        // Props are live: closing clears the spec, so take the callback first.
        const onSelect = p.spec.onSelect
        const custom = p.spec.custom
        const typed = query().trim()
        const range = o.range && { submit: o.range.onSubmit, values: valuesOf(o) }
        p.close()
        if (o.value === CUSTOM) custom?.onSubmit(typed)
        else if (range) range.submit(...range.values)
        else onSelect(o.value)
      }
    } else if (filterable() && key.name === "backspace") {
      setQuery((q) => q.slice(0, -1))
      setSel(0)
    } else if (filterable() && key.sequence && key.sequence.length === 1 && key.sequence >= " " && !key.ctrl && !key.meta) {
      setQuery((q) => q + key.sequence)
      setSel(0)
    } else return
    key.preventDefault()
    key.stopPropagation()
  })

  const width = () => Math.min(p.spec.width ?? 72, dims().width - 4)
  return (
    <box position="absolute" zIndex={100} left={0} top={0} width={dims().width} height={dims().height} alignItems="center" paddingTop={Math.max(1, Math.floor(dims().height / 6))} backgroundColor={RGBA.fromInts(0, 0, 0, 140)}>
      <box width={width()} border borderStyle="rounded" borderColor={c().border} backgroundColor={c().menu} flexDirection="column" paddingLeft={1} paddingRight={1} title={` ${p.spec.title} `} titleColor={c().title}>
        <Show when={filterable()}>
          <text fg={query() ? c().text : c().dim}>{query() ? `› ${query()}` : "› type to filter"}</text>
        </Show>
        <For each={shown().slice(offset(), offset() + visible())}>
          {(o, i) => {
            const active = () => i() + offset() === sel()
            if (o.range) {
              const values = () => valuesOf(o)
              const track = () => rangeTrack(o.range!, values()[0], values()[1])
              const handle = (n: 0 | 1) => (active() && focus() === n ? c().accent : active() ? c().title : c().text)
              return (
                <box flexDirection="row" backgroundColor={active() ? c().menuCurrent : undefined}>
                  <text wrapMode="none" truncate fg={active() ? c().title : c().text} attributes={active() ? TextAttributes.BOLD : 0}>
                    {"  "}
                    {o.label}
                    {"  "}
                    <span style={{ fg: handle(0) }}>{`${o.range.names[0]} ${values()[0]}`}</span>
                    {" "}
                    <span style={{ fg: c().dim }}>{track().before}</span>
                    <span style={{ fg: handle(0) }}>{track().lo}</span>
                    <span style={{ fg: c().accent }}>{track().between}</span>
                    <span style={{ fg: handle(1) }}>{track().hi}</span>
                    <span style={{ fg: c().dim }}>{track().after}</span>
                    {" "}
                    <span style={{ fg: handle(1) }}>{`${o.range.names[1]} ${values()[1]}`}</span>
                    <span style={{ fg: c().muted }}>{o.description ? `  ${o.description}` : ""}</span>
                  </text>
                </box>
              )
            }
            return (
              <box flexDirection="row" backgroundColor={active() ? c().menuCurrent : undefined}>
                <text wrapMode="none" truncate fg={active() ? c().title : c().text} attributes={active() ? TextAttributes.BOLD : 0}>
                  {o.current ? "● " : "  "}
                  {o.label}
                  <span style={{ fg: c().muted }}>{o.description ? `  ${o.description}` : ""}</span>
                </text>
              </box>
            )
          }}
        </For>
        <Show when={shown().length === 0}>
          <text fg={c().muted}>nothing matches</text>
        </Show>
        <text fg={c().dim}>
          {shown()[sel()]?.range
            ? `←→ move ${shown()[sel()]!.range!.names[focus()]} · tab ${shown()[sel()]!.range!.names[focus() === 0 ? 1 : 0]} · enter set · esc close`
            : (p.spec.hint ?? "↑↓ move · enter choose · esc close")}
        </text>
      </box>
    </box>
  )
}
