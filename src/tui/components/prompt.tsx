import { RGBA, SyntaxStyle, type PasteEvent, type TextareaRenderable } from "@opentui/core"
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { paths } from "../../config/paths.ts"
import { clipboardImage, isImage } from "../../project/image.ts"
import { escapeMention } from "../../project/attach.ts"
import fuzzysort from "fuzzysort"
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import type { FileIndex } from "../../project/files.ts"
import { useTui } from "../context.ts"
import { History } from "../history.ts"
import { imageLabel, pasteLabel, Placeholders, type BoxSnapshot } from "../paste.ts"

export interface PaletteEntry {
  name: string
  args?: string
  description: string
  /** "global"/"project": custom commands from markdown files; "skill": a skill; "mcp": an MCP prompt. */
  source?: "builtin" | "global" | "project" | "skill" | "mcp"
}

interface Popup {
  kind: "command" | "file"
  items: { label: string; detail: string; value: string }[]
  /** How many characters before the cursor the replaced token takes. */
  token: number
}

/** What the app may ask of the box beyond its text. */
export interface PromptHandle {
  /** The box's text with every paste placeholder replaced by what it stands for. */
  expanded(): string
  /** What is selected in the box, in full; undefined when the selection is not in the box. */
  expandedSelection(): string | undefined
}

/** The offset (in the textarea's columns) at which the text before it is `index` characters long. */
function offsetAt(area: TextareaRenderable, index: number): number {
  let lo = 0
  let hi = area.cursorOffset
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (area.getTextRange(0, mid).length < index) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** The input: enter sends; shift+enter / alt+enter / ctrl+j add a line; ↑↓ on the edge lines walk
 *  the messages waiting to go in (newest first), then history. A leading "/" lists commands and
 *  "@" lists files: ↑↓ choose, tab or enter take it, esc hides the list. */
export function Prompt(p: {
  focused: () => boolean
  busy: () => boolean
  commands: () => PaletteEntry[]
  files?: FileIndex
  /** false: refused (busy, unknown command) — the text stays in the box. `shown`: what the box
   *  said, when a paste placeholder made it differ from the text that is sent. */
  onSubmit: (text: string, shown?: string) => boolean | void
  ref?: (r: TextareaRenderable) => void
  handle?: (h: PromptHandle) => void
  /** The messages waiting to go in: how many, take one out, put it back. */
  queue?: { count(): number; take(index: number): string | undefined; putBack(index: number, text: string): void }
  /** A burst of ↑/↓ that was a mouse wheel: scroll the transcript `lines` up (-1) or down (1). */
  onWheel?: (dir: -1 | 1, lines: number) => void
  /** ctrl+b: the foreground command goes to the background now. Taken here because the textarea
   *  itself binds ctrl+b (move left) and would keep the key. */
  onBackground?: () => void
}) {
  const { theme, app } = useTui()
  const c = () => theme().colors
  const history = new History()
  // How a paste placeholder looks: the theme's label colour, on the menu's background.
  const style = createMemo((prev?: SyntaxStyle) => {
    prev?.destroy()
    return SyntaxStyle.fromStyles({ "extmark.paste": { fg: RGBA.fromHex(c().label), bg: RGBA.fromHex(c().menu) } })
  })
  onCleanup(() => style().destroy())
  let marks: Placeholders | undefined
  /** The box's text as it is sent: placeholders replaced by what they stand for. */
  const full = () => marks?.expanded() ?? area?.plainText ?? ""
  const pasteWhole = () => app.loaded.config.paste === "full"
  const [popup, setPopup] = createSignal<Popup>()
  const [sel, setSel] = createSignal(0)
  let dismissedAt: string | undefined
  let area: TextareaRenderable | undefined
  // A waiting message taken into the box with ↑: where it was in the queue, and its text as taken.
  let pulled: { index: number; text: string } | undefined
  // A terminal that does not pass the mouse on (tmux with its mouse off, some remote terminals)
  // turns a wheel notch into a burst of ↑ or ↓ — several within a millisecond or two. A key, even
  // held down, repeats 25 ms apart or more. A burst scrolls the transcript, and what its first
  // arrow did to the box is undone (otherwise the wheel walks the prompt history).
  const BURST_MS = 12
  let burst: { dir: "up" | "down"; at: number; undo?: { box: BoxSnapshot; history: ReturnType<History["mark"]>; pulled: typeof pulled; queue?: () => void } } | undefined

  /** ↑/↓ on an edge line: the waiting messages first (↑ newest to oldest), then history. */
  const walk = (dir: "up" | "down", t: string): string | undefined => {
    const q = p.queue
    if (q && pulled && t === pulled.text) {
      // Put back the one shown, and show its neighbour — or leave the queue for history / an empty box.
      q.putBack(pulled.index, pulled.text)
      const next = pulled.index + (dir === "up" ? -1 : 1)
      if (next >= 0 && next < q.count()) {
        const text = q.take(next)!
        pulled = { index: next, text }
        return text
      }
      pulled = undefined
      return dir === "up" ? (history.move(-1, "") ?? "") : ""
    }
    if (q && dir === "up" && !t.trim() && q.count() > 0) {
      const index = q.count() - 1
      const text = q.take(index)!
      pulled = { index, text }
      return text
    }
    return history.move(dir === "up" ? -1 : 1, t)
  }

  const compute = () => {
    if (!area) return setPopup(undefined)
    const text = area.plainText
    if (text === dismissedAt) return setPopup(undefined)
    dismissedAt = undefined
    const before = area.getTextRange(0, area.cursorOffset)
    if (/^\/[\w:-]*$/.test(text)) {
      const q = text.slice(1)
      const all = p.commands()
      const hits = q ? fuzzysort.go(q, all, { key: "name", limit: 8 }).map((h) => h.obj) : all.slice(0, 8)
      setPopup(
        hits.length
          ? { kind: "command", token: text.length, items: hits.map((cmd) => ({ label: `/${cmd.name}`, detail: `${cmd.args ? cmd.args + "  " : ""}${cmd.description}${cmd.source && cmd.source !== "builtin" ? `  (${cmd.source})` : ""}`, value: cmd.name })) }
          : undefined,
      )
    } else {
      const m = p.files ? /(?:^|\s)@([^\s]*)$/.exec(before) : null
      if (m) {
        const hits = p.files!.search(m[1]!)
        setPopup(hits.length ? { kind: "file", token: m[1]!.length, items: hits.map((f) => ({ label: f, detail: "", value: f })) } : undefined)
      } else setPopup(undefined)
    }
    setSel(0)
  }

  /** Take the highlighted entry. For a command, enter runs it and tab leaves room for arguments;
   *  returns true when the prompt should be sent. */
  const accept = (run: boolean): boolean => {
    const pop = popup()
    const item = pop?.items[sel()]
    if (!area || !pop || !item) return false
    if (pop.kind === "command") {
      const cmd = p.commands().find((x) => x.name === item.value)
      area.setText(`/${item.value}${!run && cmd?.args ? " " : ""}`)
      area.gotoBufferEnd()
      setPopup(undefined)
      return run
    }
    const cursor = area.cursorOffset
    // Escaped as the expander reads it back: a space or a # in a name.
    const insert = escapeMention(item.value) + (item.value.endsWith("/") ? "" : " ")
    // The token is replaced where it stands (not by setting the whole text, which would drop
    // every paste placeholder in the box).
    const from = offsetAt(area, area.getTextRange(0, cursor).length - pop.token)
    if (from < cursor) area.setSelection(from, cursor)
    area.insertText(insert)
    // A directory keeps the list open, one level down.
    queueMicrotask(compute)
    return false
  }

  /** An image file goes into the box as `[Image N]`; what is sent is its @reference. */
  const insertImage = (path: string) => {
    if (!area || !marks) return
    const ref = `@${escapeMention(path)}`
    if (pasteWhole()) return area.insertText(`${ref} `)
    marks.insert({ kind: "image", label: imageLabel(marks.nextImage()), content: ref })
  }

  /** An image on the clipboard becomes a saved copy and a placeholder for it. */
  const pasteClipboardImage = (): boolean => {
    const dir = join(paths.state, "clipboard")
    mkdirSync(dir, { recursive: true })
    const saved = clipboardImage(join(dir, `paste-${Date.now()}.png`))
    if (!saved || !area) return false
    insertImage(saved)
    return true
  }

  /** A pasted path to an image (dragged from a file manager: quoted, escaped or file://) → @path. */
  const imagePath = (text: string): string | undefined => {
    let t = text.trim()
    if (t.includes("\n")) return undefined
    t = t.replace(/^file:\/\//, "").replace(/^['"](.*)['"]$/, "$1").replace(/\\ /g, " ")
    try {
      t = decodeURIComponent(t)
    } catch {}
    return isImage(t) && existsSync(t) ? t : undefined
  }

  const onPaste = (e: PasteEvent) => {
    if (!area) return
    const text = new TextDecoder().decode(e.bytes).replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    // Some terminals hand over an image-only clipboard as an empty bracketed paste.
    if (!text.trim()) {
      e.preventDefault()
      pasteClipboardImage()
      return
    }
    const img = imagePath(text)
    e.preventDefault()
    if (img) return insertImage(img)
    // A long paste is a placeholder (`paste: full` shows it whole); the same paste again, right
    // after its placeholder, opens it.
    const content = text.replace(/\s+$/, "")
    const label = pasteWhole() ? undefined : pasteLabel(content)
    if (!label || !marks) return area.insertText(text)
    if (marks.expandAtCursor(content)) return
    marks.insert({ kind: "text", label, content })
  }

  /** What undoes one ↑/↓ step through the queue: the message now in the box goes back, and the one
   *  that was in the box before (if it came from the queue) is taken out again. */
  const queueRestorer = (countBefore: number, pulledBefore: typeof pulled) => () => {
    const q = p.queue!
    if (pulled && q.count() < countBefore + (pulledBefore ? 1 : 0)) q.putBack(pulled.index, pulled.text)
    if (pulledBefore) q.take(pulledBefore.index)
  }

  const submit = () => {
    if (!area) return
    // What is sent is the text in full; what the transcript shows is what the box showed.
    const value = full()
    const shown = area.plainText
    if (!value.trim()) return
    const box = marks?.snapshot()
    history.add(value)
    pulled = undefined
    area.setText("")
    marks?.clear()
    setPopup(undefined)
    // Cleared first: a command may put text of its own there (/undo puts the prompt back). A
    // refusal puts what was typed back — placeholders and all — unless something else has been
    // put there.
    if (p.onSubmit(value, shown !== value ? shown : undefined) === false && !area.plainText) {
      if (box && marks) marks.restore(box)
      else area.setText(value)
      area.gotoBufferEnd()
    }
  }

  return (
    <box flexDirection="column" flexShrink={0}>
      <Show when={popup()}>
        <box flexDirection="column" paddingLeft={3} backgroundColor={c().menu}>
          <For each={popup()!.items}>
            {(it, i) => (
              <text wrapMode="none" truncate bg={i() === sel() ? c().menuCurrent : undefined}>
                <span style={{ fg: i() === sel() ? c().title : c().label }}>{it.label}</span>
                <span style={{ fg: c().muted }}>{it.detail ? `  ${it.detail}` : ""}</span>
              </text>
            )}
          </For>
        </box>
      </Show>
      <box flexDirection="row" border={["top"]} borderColor={p.busy() ? c().dim : c().border}>
        <text fg={p.busy() ? c().dim : c().accent}>{theme().branding.promptSymbol} </text>
        <textarea
          ref={(r: TextareaRenderable) => {
            area = r
            marks = new Placeholders(r, () => style().getStyleId("extmark.paste") ?? undefined)
            p.ref?.(r)
            p.handle?.({ expanded: full, expandedSelection: () => marks?.expandedSelection() })
          }}
          focused={p.focused()}
          flexGrow={1}
          minHeight={1}
          maxHeight={8}
          wrapMode="word"
          syntaxStyle={style()}
          textColor={c().prompt}
          focusedTextColor={c().prompt}
          cursorColor={c().accent}
          placeholder={p.busy() ? "working… (enter adds a message to it; esc stops)" : "Ask · / commands · @ files · !shell"}
          placeholderColor={c().dim}
          keyBindings={[
            { name: "return", action: "submit" },
            { name: "return", shift: true, action: "newline" },
            { name: "return", meta: true, action: "newline" },
            { name: "j", ctrl: true, action: "newline" },
          ]}
          onContentChange={compute}
          onCursorChange={compute}
          onSubmit={submit}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (!area) return
            if (e.ctrl && e.name === "v" && pasteClipboardImage()) return e.preventDefault()
            if (e.ctrl && e.name === "b" && p.onBackground) {
              p.onBackground()
              return e.preventDefault()
            }
            const pop = popup()
            if (pop) {
              const n = pop.items.length
              if (e.name === "up" || e.name === "down") {
                setSel((i) => (i + (e.name === "up" ? n - 1 : 1)) % n)
                return e.preventDefault()
              }
              if (e.name === "tab" || (e.name === "return" && !e.shift && !e.meta)) {
                const send = accept(e.name === "return")
                e.preventDefault()
                if (send) submit()
                return
              }
              if (e.name === "escape") {
                dismissedAt = area.plainText
                setPopup(undefined)
                return e.preventDefault()
              }
            }
            if (e.name !== "up" && e.name !== "down") return
            // In full: a draft with a placeholder in it comes back from history as its text.
            const t = full()
            const now = performance.now()
            if (burst && burst.dir === e.name && now - burst.at < BURST_MS && p.onWheel) {
              // The second arrow of a burst: it was the wheel. Undo the first, scroll for both.
              const u = burst.undo
              let lines = 1
              if (u) {
                u.queue?.()
                pulled = u.pulled
                history.restore(u.history)
                marks!.restore(u.box)
                burst.undo = undefined
                lines = 2
              }
              burst.at = now
              p.onWheel(e.name === "up" ? -1 : 1, lines)
              return e.preventDefault()
            }
            const before = { box: marks!.snapshot(), history: history.mark(), pulled: pulled && { ...pulled } }
            burst = { dir: e.name, at: now, undo: before }
            const atFirst = !area.getTextRange(0, area.cursorOffset).includes("\n")
            const atLast = !area.getTextRange(area.cursorOffset, 0x3fffffff).includes("\n")
            if ((e.name === "up" && atFirst) || (e.name === "down" && atLast)) {
              const countBefore = p.queue?.count()
              const next = walk(e.name, t)
              // Undoing a step through the queue: put the queue back as it was.
              if (p.queue && countBefore !== undefined) burst.undo!.queue = queueRestorer(countBefore, before.pulled)
              if (next === undefined) return
              area.setText(next)
              area.gotoBufferEnd()
              e.preventDefault()
            }
          }}
        />
      </box>
    </box>
  )
}
