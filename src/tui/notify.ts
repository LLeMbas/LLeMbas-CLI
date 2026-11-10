// The finished-reply notice: when a reply finishes, or the agent waits for an answer, while the
// terminal is not focused, the bell rings and the terminal is asked for a desktop notification
// (OSC 9 — iTerm2, WezTerm, kitty, Windows Terminal, foot and others show it; the rest ignore it).
// It names the session and what happened, never what the reply says: a desktop notification may
// be seen by anyone near the screen. `notify: false` turns it off.

/** The words of the notice: the session's title (or "LLeMbas") and what happened. */
export function noticeText(title: string | undefined, what: "finished" | "waiting" | "failed"): string {
  const name = (title ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "LLeMbas"
  const said = what === "finished" ? "finished" : what === "waiting" ? "waits for you" : "stopped with an error"
  return `${name}: ${said}`
}

/** The bytes sent to the terminal: OSC 9 with the text, then the bell. */
export function noticeSequence(text: string): string {
  return `\x1b]9;${text.replace(/[\u0000-\u001f\u007f-\u009f;]/g, " ")}\x07\x07`
}

/** Follows the terminal's focus (OpenTUI's focus and blur events, from focus reporting) and says
 *  whether a notice is due: only once the terminal has said it lost focus — a terminal that
 *  reports nothing is taken as focused, so it never rings for nothing. */
export class FocusWatch {
  focused = true
  constructor(on?: (event: "focus" | "blur", fn: () => void) => void) {
    on?.("focus", () => (this.focused = true))
    on?.("blur", () => (this.focused = false))
  }
}
