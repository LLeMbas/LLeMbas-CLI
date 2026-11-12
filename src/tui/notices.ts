// What a line the program says looks like, by what kind of line it is — one table, read by the
// transcript, the menus and `lembas run`. A warning sign always means something needs attention:
// a thing that simply happened is `info`, one that went well and is worth a mark is `success`.
import type { Theme } from "./palette.ts"

export type NoticeLevel = "info" | "success" | "warn" | "error"

export const NOTICES: Record<NoticeLevel, { glyph: string; color: keyof Theme["colors"]; means: string }> = {
  info: { glyph: "·", color: "muted", means: "something happened, or was asked for; nothing to do" },
  success: { glyph: "✓", color: "ok", means: "what was asked for is done" },
  warn: { glyph: "⚠", color: "warn", means: "needs attention: something did not work as meant, or will not" },
  error: { glyph: "✗", color: "error", means: "failed" },
}

/** A state's mark in a list (a server, a job, a rule): the same four meanings, plus the neutral
 *  ones a list needs. */
export const MARKS = {
  on: { glyph: "●", color: "ok" },
  busy: { glyph: "…", color: "info" },
  off: { glyph: "○", color: "dim" },
  attention: { glyph: NOTICES.warn.glyph, color: NOTICES.warn.color },
  failed: { glyph: NOTICES.error.glyph, color: NOTICES.error.color },
} as const satisfies Record<string, { glyph: string; color: keyof Theme["colors"] }>

export type Mark = keyof typeof MARKS
