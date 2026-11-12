import { RGBA, TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useTui } from "../context.ts"
import { MARKS, type Mark } from "../notices.ts"

export interface Option {
  label: string
  value: string
  description?: string
  current?: boolean
  /** The heading this row stands under: drawn once, above the first row of each run of it. */
  section?: string
  /** The row's state, as a coloured mark before its label (tui/notices.ts MARKS) — a server
   *  connected, a rule that denies. Takes the place of the `current` dot. */
  mark?: Mark
  /** More about the highlighted row than its line holds — a tool's whole description — shown
   *  under the list, wrapped, while the row is highlighted. */
  detail?: string
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
  keys?: { when: (key: { name: string; ctrl?: boolean; meta?: boolean; shift?: boolean }) => boolean; run: (value: string) => void; /** The menu stays open (the caller redraws it). */ keep?: boolean }[]
  /** The footer in place of `↑↓ move · enter choose · esc close`, to name those keys: a
   *  binding nobody is told about is one nobody finds, which is how delete went unseen in /sessions. */
  hint?: string
  /** Lines above the list: what the menu is about (a server's address and state). Wrapped. */
  body?: string[]
  /** What an empty list says, in place of "nothing matches" (which is for a filter). */
  empty?: string
  /** Esc goes back here (a menu opened from another) rather than closing; the footer says so. */
  onBack?: () => void
  /** The row to start on, by value (else the `current` one, else the first). */
  select?: string
  /** Columns the box may take (72 by default; the terminal less four is the ceiling either way):
   *  a list whose rows are columns of their own (/jobs) asks for more. */
  width?: number
  /** The dialog is gone, however it went (chosen, esc, replaced): a list that follows events
   *  while it is shown stops following here. */
  onClose?: () => void
}

const CUSTOM = "\u0000custom"
/** The most rows a menu's body and the highlighted row's detail may take. */
const BODY_ROWS = 6
const DETAIL_ROWS = 3

/** A sentence as rows of at most `width` columns, broken at spaces (a word longer than a row is
 *  cut). */
export function wrapWords(text: string, width: number): string[] {
  const out: string[] = []
  let line = ""
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line)
      line = ""
    }
    line = line ? `${line} ${word}` : word
    while (line.length > width) {
      out.push(line.slice(0, width))
      line = line.slice(width)
    }
  }
  if (line || !out.length) out.push(line)
  return out
}

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
  const start = Math.max(0, p.spec.options.findIndex((o) => (p.spec.select !== undefined ? o.value === p.spec.select : o.current)))
  const [sel, setSel] = createSignal(start)
  // The spec is live: a list that redraws itself with fewer rows keeps the cursor on a row.
  createEffect(() => {
    const n = shown().length
    if (n && sel() >= n) setSel(n - 1)
  })
  // Taken once: the spec that opened the dialog says what to do when it goes.
  const onClose = p.spec.onClose
  onCleanup(() => onClose?.())
  const width = () => Math.min(p.spec.width ?? 72, dims().width - 4)
  const body = createMemo(() => (p.spec.body ?? []).flatMap((l) => (l ? wrapWords(l, Math.max(10, width() - 4)) : [""])))
  const detail = createMemo(() => {
    const d = shown()[sel()]?.detail
    return d ? d.split("\n").flatMap((l) => wrapWords(l, Math.max(10, width() - 6))).slice(0, DETAIL_ROWS) : []
  })
  // The list's rows: every option, and a heading above the first row of each section.
  type Row = { head: string } | { option: Option; index: number }
  const rows = createMemo(() => {
    const out: Row[] = []
    let section: string | undefined
    shown().forEach((option, index) => {
      if (option.section !== undefined && option.section !== section) out.push({ head: option.section })
      section = option.section
      out.push({ option, index })
    })
    return out
  })
  // What the screen leaves for the list: less the body above it and the detail below.
  const visible = () => Math.max(3, Math.min(22, dims().height - 10 - Math.min(body().length, BODY_ROWS) - (detail().length ? DETAIL_ROWS + 1 : 0)))
  const offset = () => {
    const at = rows().findIndex((r) => "option" in r && r.index === sel())
    const first = Math.max(0, Math.min(at - Math.floor(visible() / 2), rows().length - visible()))
    // A heading just above the window's first row is shown with it.
    return first > 0 && at - first < visible() - 1 && "head" in (rows()[first - 1] ?? {}) ? first - 1 : first
  }

  /** The key hints: the menu's own, or the usual ones — with "esc back" in a menu that has
   *  somewhere to go back to, and where the cursor is in a list longer than the window. */
  const footer = () => {
    const esc = p.spec.onBack ? "esc back" : "esc close"
    const base = p.spec.hint ?? `↑↓ move · enter choose · ${esc}`
    const n = shown().length
    return n > visible() ? `${base} · ${sel() + 1}/${n}` : base
  }

  useKeyboard((key) => {
    const n = shown().length
    const bound = p.spec.keys?.find((k) => k.when(key))
    if (bound) {
      const o = shown()[sel()]
      if (o && o.value !== CUSTOM) {
        // Taken before closing, as for enter: closing clears the spec.
        const run = bound.run
        if (!bound.keep) p.close()
        run(o.value)
      }
    } else if (key.name === "escape") {
      const back = p.spec.onBack
      p.close()
      back?.()
    } else if (key.name === "pageup" || key.name === "pagedown") setSel((i) => Math.max(0, Math.min(n - 1, i + (key.name === "pageup" ? -1 : 1) * Math.max(1, visible() - 1))))
    else if (key.name === "home" || key.name === "end") setSel(key.name === "home" ? 0 : Math.max(0, n - 1))
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

  return (
    <box position="absolute" zIndex={100} left={0} top={0} width={dims().width} height={dims().height} alignItems="center" paddingTop={Math.max(1, Math.floor(dims().height / 6))} backgroundColor={RGBA.fromInts(0, 0, 0, 140)}>
      <box width={width()} border borderStyle="rounded" borderColor={c().border} backgroundColor={c().menu} flexDirection="column" paddingLeft={1} paddingRight={1} title={` ${p.spec.title} `} titleColor={c().title}>
        <Show when={filterable()}>
          <text fg={query() ? c().text : c().dim}>{query() ? `› ${query()}` : "› type to filter"}</text>
        </Show>
        <For each={body().slice(0, BODY_ROWS)}>{(l) => <text fg={c().muted} wrapMode="none" truncate>{l || " "}</text>}</For>
        <For each={rows().slice(offset(), offset() + visible())}>
          {(row) => {
            if ("head" in row)
              return (
                <text wrapMode="none" truncate fg={c().label}>
                  {row.head}
                </text>
              )
            const o = row.option
            const active = () => row.index === sel()
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
                  <Show when={o.mark} fallback={o.current ? "● " : "  "}>
                    <span style={{ fg: c()[MARKS[o.mark!].color] }}>{MARKS[o.mark!].glyph} </span>
                  </Show>
                  {o.label}
                  <span style={{ fg: c().muted }}>{o.description ? `  ${o.description}` : ""}</span>
                </text>
              </box>
            )
          }}
        </For>
        <Show when={shown().length === 0}>
          <text fg={c().muted} wrapMode="word">
            {query() ? "nothing matches" : (p.spec.empty ?? "nothing here")}
          </text>
        </Show>
        <Show when={detail().length}>
          <box flexDirection="column" height={DETAIL_ROWS + 1} border={["top"]} borderColor={c().border}>
            <For each={detail()}>{(l) => <text fg={c().muted} wrapMode="none" truncate>{l || " "}</text>}</For>
          </box>
        </Show>
        <text fg={c().dim} wrapMode="none" truncate>
          {shown()[sel()]?.range
            ? `←→ move ${shown()[sel()]!.range!.names[focus()]} · tab ${shown()[sel()]!.range!.names[focus() === 0 ? 1 : 0]} · enter set · esc close`
            : footer()}
        </text>
      </box>
    </box>
  )
}
