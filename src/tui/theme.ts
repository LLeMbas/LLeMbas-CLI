// The theme for OpenTUI: the palettes and the loader are palette.ts; here, what turns a theme into
// the renderer's background and the markdown styles.
import { RGBA, SyntaxStyle } from "@opentui/core"
import type { Theme } from "./palette.ts"
export * from "./palette.ts"

/** Paint the screen with the theme's background, or give it back to the terminal (a theme with
 *  no `bg`, or theme_background: terminal). */
export function paintBackground(r: { setBackgroundColor(c: string): void }, t: Theme, mode: "theme" | "terminal" | undefined) {
  r.setBackgroundColor(mode !== "terminal" && t.colors.bg ? t.colors.bg : "transparent")
}

/** Markdown styling for assistant text, from the theme. Create once per theme: it holds native memory. */
export function markdownStyle(s: Theme): SyntaxStyle {
  const c = s.colors
  const hex = (h: string) => RGBA.fromHex(h)
  return SyntaxStyle.fromStyles({
    default: { fg: hex(c.text) },
    "markup.heading": { fg: hex(c.title), bold: true },
    "markup.heading.1": { fg: hex(c.title), bold: true },
    "markup.heading.2": { fg: hex(c.title), bold: true },
    "markup.heading.3": { fg: hex(c.accent), bold: true },
    "markup.strong": { fg: hex(c.accent), bold: true },
    "markup.bold": { fg: hex(c.accent), bold: true },
    "markup.italic": { italic: true },
    "markup.raw": { fg: hex(c.code) },
    "markup.raw.block": { fg: hex(c.code) },
    "markup.list": { fg: hex(c.label) },
    "markup.quote": { fg: hex(c.muted), italic: true },
    "markup.link": { fg: hex(c.link), underline: true },
    "markup.link.url": { fg: hex(c.link), underline: true },
    "markup.link.label": { fg: hex(c.link) },
    keyword: { fg: hex(c.keyword) },
    string: { fg: hex(c.string) },
    comment: { fg: hex(c.comment), italic: true },
    number: { fg: hex(c.number) },
    function: { fg: hex(c.func) },
    type: { fg: hex(c.type) },
  })
}

/** Reasoning is shown dimmed, in one colour. */
export function reasoningStyle(s: Theme): SyntaxStyle {
  return SyntaxStyle.fromStyles({ default: { fg: RGBA.fromHex(s.colors.reasoning), italic: true } })
}
