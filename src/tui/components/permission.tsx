import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createSignal, For, Show } from "solid-js"
import type { AskReply } from "../../bus/index.ts"
import { useTui } from "../context.ts"
import type { Pending } from "../state.ts"
import { diffStat } from "../../tool/write.ts"
import { filetypeOf } from "./messages.tsx"

interface Choice {
  key: string
  label: string
  reply: () => AskReply | "reason" | "edit"
}

/** A command as the rows it takes at `width` columns (it is drawn wrapped by character). */
export function rowsOf(text: string, width: number): string[] {
  const w = Math.max(1, width)
  return text.split("\n").flatMap((l) => (l.length <= w ? [l] : Array.from({ length: Math.ceil(l.length / w) }, (_, i) => l.slice(i * w, (i + 1) * w))))
}

/** Rows of a long command shown before ctrl+o. */
const COLLAPSED = 6

const clipText = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t)

/** Asked above the prompt: y once · e edit the command, then once · s for the session · p for the
 *  project · n no · r no, and why.
 *  First what the model says the call is for; then the command, or the change to files as a diff
 *  (pgup/pgdn scroll it), so the answer is about the thing itself. The card never grows past the
 *  screen: a long command is cut to a few rows (ctrl+o: all of it, scrolling), and the body gets
 *  what the terminal's height leaves after the choices, the prompt and the status bar. */
export function PermissionPrompt(p: { pending: Pending }) {
  const { theme, app, dims } = useTui()
  const c = () => theme().colors
  const always = () => p.pending.decision.always.join(", ")
  const choices = (): Choice[] => [
    { key: "y", label: "Allow once", reply: () => ({ kind: "once" }) },
    // A command can be corrected before it runs (after LLeMbas): what is written is judged again.
    ...(p.pending.request.command !== undefined ? [{ key: "e", label: "Edit, then allow", reply: () => "edit" as const }] : []),
    ...(always() ? [{ key: "s", label: "Always this session", reply: () => ({ kind: "session" }) as AskReply }] : []),
    ...(always() && app.trusted ? [{ key: "p", label: "Always in this project", reply: () => ({ kind: "project" }) as AskReply }] : []),
    { key: "n", label: "Deny", reply: () => ({ kind: "deny" }) },
    { key: "r", label: "Deny, and say why", reply: () => "reason" as const },
  ]
  const [sel, setSel] = createSignal(0)
  const [reasoning, setReasoning] = createSignal(false)
  const [editing, setEditing] = createSignal(false)
  const [whole, setWhole] = createSignal(false)
  let input: { value: string } | undefined
  let box: ScrollBoxRenderable | undefined
  const diff = () => p.pending.preview?.diff
  const stat = () => {
    const d = diff()
    if (!d) return ""
    const { added, removed } = diffStat(d)
    return `+${added} −${removed}`
  }

  const choose = (ch: Choice) => {
    const r = ch.reply()
    if (r === "reason") return setReasoning(true)
    if (r === "edit") return setEditing(true)
    p.pending.resolve(r)
  }

  useKeyboard((key) => {
    if (reasoning() || editing()) {
      if (key.name === "escape") {
        setReasoning(false)
        setEditing(false)
        key.preventDefault()
      }
      return
    }
    const list = choices()
    if (key.name === "left" || key.name === "h" || (key.name === "tab" && key.shift)) setSel((i) => (i + list.length - 1) % list.length)
    else if (key.name === "right" || key.name === "l" || key.name === "tab") setSel((i) => (i + 1) % list.length)
    else if (key.name === "return") choose(list[sel()]!)
    else if (key.name === "escape") p.pending.resolve({ kind: "deny" })
    else if (key.ctrl && key.name === "o") {
      setWhole((v) => !v)
      box?.scrollTo(0)
    } else if (key.name === "pageup") box?.scrollBy(-Math.max(1, Math.floor(box.height / 2)))
    else if (key.name === "pagedown") box?.scrollBy(Math.max(1, Math.floor(box.height / 2)))
    else {
      const hit = list.find((ch) => ch.key === key.name)
      if (!hit) return
      choose(hit)
    }
    key.preventDefault()
  })

  const what = () => p.pending.request.command ?? p.pending.request.patterns.join(", ")
  // A subagent's ask says which one: `explore (job7): bash`.
  const title = () => (p.pending.source ? `${p.pending.source.agent} (${p.pending.source.jobId}): ${p.pending.tool}` : p.pending.tool)
  // Inside the border, the padding and the scrollbar.
  const width = () => Math.max(10, dims().width - 5)
  const purpose = () => (p.pending.purpose ? rowsOf(p.pending.purpose, width()).slice(0, 3) : [])
  const failRows = () => (p.pending.preview?.error ? rowsOf(`this will fail: ${p.pending.preview.error}`, width()).length : 0)
  // Rows the body may take: the screen, less the prompt and status bar (4), the border (2), the
  // reason and the choices (2 each at most), two rows of the conversation, purpose and failure.
  const budget = () => Math.max(3, dims().height - 12 - purpose().length - failRows())
  const rows = () => rowsOf(what(), width())
  const cut = () => !whole() && rows().length > Math.min(COLLAPSED, budget())
  const shown = () => (cut() ? rows().slice(0, Math.min(COLLAPSED, budget()) - 1).join("\n") : what())
  // A scrollbox takes the height it is given, so it is given what its content needs, up to the
  // budget: the command's rows, the "more lines" row, and the diff's (wrapped beside its gutter; file headers and
  // @@ lines are not drawn).
  const bodyHeight = () => {
    const d = diff()
    const diffRows = d ? rowsOf(d.split("\n").filter((l) => !/^(Index:|={5,}|--- |\+\+\+ |@@)/.test(l)).join("\n").replace(/\n$/, ""), width() - 8).length : 0
    const commandRows = cut() ? Math.min(COLLAPSED, budget()) : rows().length
    return Math.max(1, Math.min(budget(), commandRows + diffRows))
  }
  const hint = () =>
    [cut() ? `… ${rows().length - Math.min(COLLAPSED, budget()) + 1} more lines — ctrl+o shows all` : whole() && rows().length > COLLAPSED ? "ctrl+o shortens it" : "", diff() || whole() ? "pgup/pgdn scroll" : ""]
      .filter(Boolean)
      .join(" · ")
  return (
    <box border borderStyle="rounded" borderColor={c().warn} paddingLeft={1} paddingRight={1} flexDirection="column" flexShrink={0} title={` ${title()} `} titleColor={c().warn}>
      <Show when={purpose().length}>
        <text fg={c().accent} wrapMode="none">
          {purpose().join("\n")}
        </text>
      </Show>
      <scrollbox ref={(r: ScrollBoxRenderable) => (box = r)} height={bodyHeight()} scrollX={false}>
        <text fg={c().text} wrapMode="char">
          {shown()}
          <Show when={stat()}>
            <span style={{ fg: c().muted }}> {stat()}</span>
          </Show>
        </text>
        <Show when={cut()}>
          <text fg={c().muted}>{hint().split(" · ")[0]}</text>
        </Show>
        <Show when={diff()}>
          <diff
            diff={diff()!}
            view="unified"
            filetype={filetypeOf(diff()!)}
            showLineNumbers
            wrapMode="char"
            fg={c().text}
            addedBg={c().diffAddedBg}
            removedBg={c().diffRemovedBg}
            contextBg={c().diffContextBg}
            addedSignColor={c().diffAddedSign}
            removedSignColor={c().diffRemovedSign}
            lineNumberFg={c().lineNumber}
            lineNumberBg={c().diffContextBg}
          />
        </Show>
      </scrollbox>
      <Show when={p.pending.preview?.error}>
        <text fg={c().error} wrapMode="word">
          {`this will fail: ${p.pending.preview!.error}`}
        </text>
      </Show>
      <text fg={c().muted} wrapMode="word">
        {clipText(p.pending.decision.reason, 160)}
        {always() ? ` · always would allow: ${clipText(always(), 80)}` : ""}
        {!cut() && hint() ? ` · ${hint()}` : ""}
      </text>
      <Show when={editing()}>
        <box flexDirection="row">
          <text fg={c().label}>run › </text>
          <input
            focused
            flexGrow={1}
            value={p.pending.request.command ?? ""}
            textColor={c().text}
            placeholder="the command as it should run (enter to allow it, esc to go back)"
            onSubmit={(v: unknown) => {
              const line = String(typeof v === "string" ? v : "").trim()
              if (line) p.pending.resolve({ kind: "once", command: line })
            }}
          />
        </box>
      </Show>
      <Show when={reasoning()}>
        <box flexDirection="row">
          <text fg={c().label}>why? </text>
          <input
            focused
            flexGrow={1}
            ref={(r) => (input = r as never)}
            textColor={c().text}
            placeholder="tell the model what to do instead (enter to send, esc to go back)"
            onSubmit={(v: unknown) => p.pending.resolve({ kind: "deny", feedback: String(typeof v === "string" ? v : (input?.value ?? "")).trim() || undefined })}
          />
        </box>
      </Show>
      <Show when={!reasoning() && !editing()}>
        <box flexDirection="row" flexWrap="wrap" gap={1}>
          <For each={choices()}>
            {(ch, i) => (
              <text
                fg={i() === sel() ? c().panel : c().text}
                bg={i() === sel() ? c().accent : undefined}
                attributes={i() === sel() ? TextAttributes.BOLD : 0}
              >
                {` ${ch.key} ${ch.label} `}
              </text>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}
