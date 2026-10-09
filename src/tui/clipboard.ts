// Copying out of the TUI. The mouse belongs to the TUI (it scrolls and selects), so the terminal's
// own selection — and with it Ctrl+Shift+C — only works while Shift is held. What the TUI selects is
// copied two ways: OSC 52, which asks the terminal to set the clipboard (and works over SSH where the
// terminal takes it: kitty, WezTerm, foot, Alacritty, Windows Terminal, iTerm2, tmux…), and, on the
// machine itself, the system clipboard through wl-copy / xclip / xsel / pbcopy. VTE terminals
// (GNOME Terminal, LXTerminal, Tilix) take neither OSC 52 nor synchronized output.

export interface ClipboardRenderer {
  readonly capabilities: { readonly remote: boolean; readonly osc52_support: "supported" | "unsupported" | "unknown" } | null
  copyToClipboardOSC52(text: string): boolean
}

export interface Copied {
  /** Where it went: "terminal" (OSC 52, known to work), "terminal?" (sent, support unknown), "system". */
  via: ("terminal" | "terminal?" | "system")[]
  remote: boolean
}

type Env = Record<string, string | undefined>

/** The local clipboard program, or none (over SSH the local clipboard is the wrong machine's). */
export function hostCopier(env: Env = process.env, which: (cmd: string) => string | null = Bun.which, os = process.platform): string[] | undefined {
  if (os === "darwin" && which("pbcopy")) return ["pbcopy"]
  if (env.WAYLAND_DISPLAY && which("wl-copy")) return ["wl-copy"]
  if (env.DISPLAY && which("xclip")) return ["xclip", "-selection", "clipboard"]
  if (env.DISPLAY && which("xsel")) return ["xsel", "--clipboard", "--input"]
  return undefined
}

export function isRemote(r: ClipboardRenderer, env: Env = process.env): boolean {
  return !!(r.capabilities?.remote || env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT)
}

function spawnCopier(cmd: string[], text: string) {
  const p = Bun.spawn(cmd, { stdin: "pipe", stdout: "ignore", stderr: "ignore" })
  p.stdin.write(text)
  void p.stdin.end()
}

export function copyText(r: ClipboardRenderer, text: string, env: Env = process.env, host = hostCopier(env), run = spawnCopier): Copied {
  const remote = isRemote(r, env)
  const via: Copied["via"] = []
  const osc = r.capabilities?.osc52_support ?? "unknown"
  if (osc !== "unsupported" && r.copyToClipboardOSC52(text)) via.push(osc === "supported" ? "terminal" : "terminal?")
  if (!remote && host) {
    try {
      run(host, text)
      via.push("system")
    } catch {}
  }
  return { via, remote }
}

/** What to say after a copy. Sent is enough: whether a terminal took OSC 52 cannot be told from
 *  here (its probe often answers "unknown" and copies anyway — LXTerminal does), so a copy that
 *  went out is not second-guessed. Only one that could go nowhere says how to copy instead. */
export function copiedMessage(n: number, c: Copied): { text: string; warn: boolean } {
  const what = `${n.toLocaleString("en")} character${n === 1 ? "" : "s"}`
  if (c.via.length) return { text: `copied ${what}`, warn: false }
  return { text: `could not copy ${what}: hold Shift while you drag to select with the terminal itself, then Ctrl+Shift+C (or set mouse: false in config.yaml)`, warn: true }
}
