// Paste placeholders in the prompt box. A long paste is shown as `[Pasted text 40 lines]` and an
// image as `[Image 2]`; what is sent is the text itself, or the `@path` of the saved image. The
// placeholder is an OpenTUI extmark over the label (virtual: the cursor steps over it and one
// backspace removes it whole), and the content is kept here, by the extmark's id.
//
// Offsets in the textarea are display columns, not string indices (a wide character is two), so
// nothing here slices `plainText` by an offset: text is taken with `getTextRange`.
import type { TextareaRenderable } from "@opentui/core"

/** A paste at least this many lines long is shown as a placeholder… */
export const PASTE_LINES = 3
/** …or longer than this many characters. */
export const PASTE_CHARS = 150

/** The placeholder a pasted text is shown as, or undefined when it is short enough to show whole. */
export function pasteLabel(text: string): string | undefined {
  const lines = text.split("\n").length
  if (lines >= PASTE_LINES) return `[Pasted text ${lines} lines]`
  const chars = [...text].length
  return chars > PASTE_CHARS ? `[Pasted text ${chars} chars]` : undefined
}

export const imageLabel = (n: number) => `[Image ${n}]`

/** The number the next image gets: one after the highest among `labels`. */
export function nextImageNumber(labels: string[]): number {
  let max = 0
  for (const l of labels) {
    const m = /^\[Image (\d+)\]$/.exec(l)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return max + 1
}

export interface Placeholder {
  label: string
  /** What is sent in its place. */
  content: string
  kind: "text" | "image"
}

/** The box as it can be put back: its text, and where each placeholder was. */
export interface BoxSnapshot {
  text: string
  cursor: number
  marks: { start: number; end: number; item: Placeholder }[]
}

type Area = Pick<TextareaRenderable, "plainText" | "cursorOffset" | "insertText" | "getTextRange" | "extmarks" | "setText" | "setSelection" | "getSelection" | "hasSelection">

/** Beyond any text a prompt box holds: `getTextRange` clamps it to the end. */
const END = 0x3fffffff

export class Placeholders {
  private items = new Map<number, Placeholder>()
  private typeId: number

  constructor(
    private area: Area,
    private styleId?: () => number | undefined,
  ) {
    this.typeId = area.extmarks.registerType("lembas-paste")
  }

  /** The placeholders in the box now, in order. One deleted is gone from here; an undo that
   *  brings its label back brings it back (the extmark returns under the same id). */
  live(): { start: number; end: number; item: Placeholder }[] {
    return this.area.extmarks
      .getAllForTypeId(this.typeId)
      .flatMap((m) => {
        const item = this.items.get(m.id)
        // A label that was edited into something else no longer stands for its content.
        return item && this.area.getTextRange(m.start, m.end) === item.label ? [{ start: m.start, end: m.end, item }] : []
      })
      .sort((a, b) => a.start - b.start)
  }

  get any(): boolean {
    return this.items.size > 0 && this.live().length > 0
  }

  /** Put a placeholder at the cursor, with a space after it. */
  insert(item: Placeholder) {
    const start = this.area.cursorOffset
    this.area.insertText(`${item.label} `)
    // A label is ASCII: its width is its length.
    this.mark(start, start + item.label.length, item)
  }

  private mark(start: number, end: number, item: Placeholder) {
    const id = this.area.extmarks.create({ start, end, virtual: true, typeId: this.typeId, ...(this.styleId?.() !== undefined ? { styleId: this.styleId!() } : {}) })
    this.items.set(id, item)
  }

  /** The next image's number: after the highest in the box. */
  nextImage(): number {
    return nextImageNumber(this.live().map((m) => m.item.label))
  }

  /** The text between two offsets with every placeholder inside them replaced by its content. */
  expandedRange(from: number, to: number): string {
    let out = ""
    let at = from
    for (const m of this.live()) {
      if (m.start < from || m.end > to) continue
      out += this.area.getTextRange(at, m.start) + m.item.content
      at = m.end
    }
    return out + this.area.getTextRange(at, to)
  }

  /** What the box says, in full: every placeholder replaced by its content. */
  expanded(): string {
    return this.items.size ? this.expandedRange(0, END) : this.area.plainText
  }

  /** What is selected in the box, in full — undefined when nothing in the box is selected. */
  expandedSelection(): string | undefined {
    if (!this.area.hasSelection()) return undefined
    const sel = this.area.getSelection()
    if (!sel || sel.start === sel.end) return undefined
    return this.expandedRange(Math.min(sel.start, sel.end), Math.max(sel.start, sel.end))
  }

  /** A placeholder that ends at the cursor (or one space before it) and stands for exactly
   *  `content` is replaced by the content itself — pasting the same thing again right after its
   *  placeholder shows it whole. */
  expandAtCursor(content: string): boolean {
    const cursor = this.area.cursorOffset
    const m = this.live().find((x) => x.item.kind === "text" && x.item.content === content && (x.end === cursor || x.end + 1 === cursor))
    if (!m) return false
    for (const e of this.area.extmarks.getAllForTypeId(this.typeId)) if (e.start === m.start && e.end === m.end) this.area.extmarks.delete(e.id)
    this.area.setSelection(m.start, cursor)
    this.area.insertText(content)
    return true
  }

  snapshot(): BoxSnapshot {
    return { text: this.area.plainText, cursor: this.area.cursorOffset, marks: this.live() }
  }

  /** Put the box back as it was, placeholders and all. (`setText` drops every extmark.) */
  restore(s: BoxSnapshot) {
    this.area.setText(s.text)
    this.items.clear()
    for (const m of s.marks) this.mark(m.start, m.end, m.item)
    this.area.cursorOffset = s.cursor
  }

  /** The box was emptied or given other text: nothing is a placeholder any more. */
  clear() {
    this.items.clear()
    this.area.extmarks.clear()
  }
}
