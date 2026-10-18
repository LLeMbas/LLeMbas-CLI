// Every colour the TUI uses comes from here — no hex literal anywhere else under src/tui/. This
// file is the palettes and the loader only, with nothing from OpenTUI, so `lembas run` can use
// it without loading the renderer; theme.ts adds what needs OpenTUI.
// The default theme, moria, is the LLeMbas web UI's own dark one (src/lembas/web/static/css/
// tokens.css), shire its light one; lembas is dark, cyan on ink, blue and violet beside it, and
// lembas-light its light counterpart. hermes is Hermes Agent's default ("Classic Hermes — gold",
// hermes_cli/skin_engine.py and agent/display.py, MIT, © 2025 Nous Research).
// A user theme is ~/.config/lembas/themes/<name>.yaml (skins/ is still read) with any subset
// of these keys, merged over moria.
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parse } from "yaml"
import { PLAIN, type IconSet } from "./icons.ts"
export type { IconSet }
import { paths } from "../config/paths.ts"

export interface Theme {
  name: string
  colors: {
    /** The screen behind everything; none: the terminal's own (hermes, mono). */
    bg?: string
    text: string
    muted: string
    dim: string
    title: string
    accent: string
    border: string
    label: string
    ok: string
    error: string
    warn: string
    info: string
    prompt: string
    panel: string
    selection: string
    menu: string
    menuCurrent: string
    statusText: string
    statusStrong: string
    statusDim: string
    statusGood: string
    statusWarn: string
    statusBad: string
    statusCritical: string
    reasoning: string
    userBar: string
    diffAddedBg: string
    diffRemovedBg: string
    diffContextBg: string
    diffAddedSign: string
    diffRemovedSign: string
    lineNumber: string
    code: string
    link: string
    /** Code in replies. */
    keyword: string
    string: string
    number: string
    func: string
    type: string
    comment: string
  }
  branding: { agentName: string; responseLabel: string; promptSymbol: string; toolPrefix: string }
  /** The line while the model works: a frame every tick, a verb while it thinks. */
  spinner: { verbs: string[]; frames: string[] }
  toolEmoji: Record<string, string>
  /** The other pictures: an MCP tool, any other tool, a refused call, the microphone, the speaker, a locked server. */
  icons: { mcp: string; other: string; denied: string; mic: string; speaker: string; locked: string }
}

export const HERMES: Theme = {
  name: "hermes",
  colors: {
    text: "#FFF8DC", // banner_text
    muted: "#C0C0C0",
    dim: "#B8860B", // banner_dim
    title: "#FFD700", // banner_title
    accent: "#FFBF00", // ui_accent
    border: "#CD7F32", // banner_border
    label: "#DAA520", // ui_label
    ok: "#4caf50",
    error: "#ef5350",
    warn: "#ffa726",
    info: "#4dabf7", // shell_dollar
    prompt: "#FFF8DC",
    panel: "#1a1a2e", // status_bar_bg
    selection: "#3a3a55",
    menu: "#1a1a2e",
    menuCurrent: "#333355",
    statusText: "#C0C0C0",
    statusStrong: "#FFD700",
    statusDim: "#8A7A4A",
    statusGood: "#8FBC8F",
    statusWarn: "#FFD700",
    statusBad: "#FF8C00",
    statusCritical: "#FF6B6B",
    reasoning: "#8B8682", // session_border
    userBar: "#DAA520",
    diffAddedBg: "#1f3322",
    diffRemovedBg: "#3a1f22",
    diffContextBg: "#16161f",
    diffAddedSign: "#4caf50",
    diffRemovedSign: "#ef5350",
    lineNumber: "#8A7A4A",
    code: "#4dabf7",
    link: "#4dabf7",
    keyword: "#FFBF00",
    string: "#4caf50",
    number: "#ffa726",
    func: "#FFD700",
    type: "#DAA520",
    comment: "#C0C0C0",
  },
  branding: { agentName: "LLeMbas", responseLabel: " LLeMbas ", promptSymbol: "❯", toolPrefix: "┊" },
  spinner: {
    verbs: ["pondering", "contemplating", "musing", "cogitating", "ruminating", "deliberating", "mulling", "reflecting", "reasoning", "analyzing", "synthesizing", "formulating"],
    frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  },
  // Hermes uses ✍️ for write; its variation selector renders 1 or 2 columns depending on the
  // terminal, which misaligns everything after it. 📝 is 2 everywhere.
  toolEmoji: {
    read: "📖",
    write: "📝",
    edit: "🔧",
    multiedit: "🔧",
    apply_patch: "🩹",
    glob: "🔎",
    grep: "🔎",
    list: "📂",
    bash: "💻",
    bash_output: "📜",
    bash_list: "📜",
    bash_kill: "🛑",
    plan_write: "📋",
    plan_update: "📋",
    ask_user: "❓",
    view_image: "📷",
    plan_submit: "🧭",
    task: "🤖",
    tasks: "📚",
    decisions: "📌",
    web_search: "🔍",
    web_fetch: "🌐",
    memory: "🧠",
    session_search: "🧾",
    skills_list: "📘",
    skill_view: "📘",
    skill_manage: "🧩",
    notes_search: "📓",
    note_view: "📓",
    note_manage: "📓",
    knowledge_search: "📖",
    knowledge_get: "📖",
  },
  icons: { mcp: "🔌", other: "⚡", denied: "⛔", mic: "🎤", speaker: "🔊", locked: "🔒" },
}

/** The theme with the chosen icons: `plain` replaces every picture, including a user theme's. */
export function withIcons(s: Theme, set: IconSet | undefined): Theme {
  return set === "plain" ? { ...s, ...PLAIN } : s
}

/** Hermes' `mono` idea: no colour beyond the terminal's own, for light terminals or screenshots. */
export const MONO: Theme = {
  ...HERMES,
  name: "mono",
  colors: Object.fromEntries(Object.keys(HERMES.colors).map((k) => [k, k.endsWith("Bg") || k === "panel" || k === "menu" ? "#202020" : k === "selection" || k === "menuCurrent" ? "#404040" : "#d0d0d0"])) as Theme["colors"],
}

/** What every built-in theme but Hermes's own shares: LLeMbas's branding, the spinner and the icons. */
const LEMBAS_LOOK = { branding: HERMES.branding, spinner: HERMES.spinner, toolEmoji: HERMES.toolEmoji, icons: HERMES.icons }

/** lembas — dark, cyan on ink, blue and violet beside it; danger a warm red, success a leaf
 *  green. Code: keyword violet, string cyan, number amber, function and type blue. */
export const LEMBAS: Theme = {
  name: "lembas",
  colors: {
    bg: "#0a0e14",
    text: "#e8eef5",
    muted: "#93a4b8",
    dim: "#7486a0",
    title: "#2fe3c4",
    accent: "#2fe3c4",
    border: "#2b3b4e",
    label: "#4d8cff",
    ok: "#3ddc84",
    error: "#ff6b5e",
    warn: "#f5b301",
    info: "#4d8cff",
    prompt: "#2fe3c4",
    panel: "#10161f",
    selection: "#1e2a38",
    menu: "#10161f",
    menuCurrent: "#18222f",
    statusText: "#93a4b8",
    statusStrong: "#2fe3c4",
    statusDim: "#7486a0",
    statusGood: "#3ddc84",
    statusWarn: "#f5b301",
    statusBad: "#ff6b5e",
    statusCritical: "#ff4fd8",
    reasoning: "#7486a0",
    userBar: "#4d8cff",
    diffAddedBg: "#102721",
    diffRemovedBg: "#27191d",
    diffContextBg: "#0d121b",
    diffAddedSign: "#3ddc84",
    diffRemovedSign: "#ff6b5e",
    lineNumber: "#7486a0",
    code: "#2fe3c4",
    link: "#4d8cff",
    keyword: "#8b7bff",
    string: "#2fe3c4",
    number: "#f5b301",
    func: "#4d8cff",
    type: "#4d8cff",
    comment: "#7486a0",
  },
  ...LEMBAS_LOOK,
}

/** lembas-light: lembas derived for a light background, with contrast floors of 7:1 for text
 *  and 4.5:1 for the rest. */
export const LEMBAS_LIGHT: Theme = {
  name: "lembas-light",
  colors: {
    bg: "#f3f6f9",
    text: "#0a0e14",
    muted: "#3d4b5c",
    dim: "#56657a",
    title: "#0a7a68",
    accent: "#0a7a68",
    border: "#b2bfcc",
    label: "#2356c4",
    ok: "#16794a",
    error: "#c2372b",
    warn: "#8a5c00",
    info: "#2356c4",
    prompt: "#0a7a68",
    panel: "#e8edf2",
    selection: "#d3dbe4",
    menu: "#ffffff",
    menuCurrent: "#e2e8ef",
    statusText: "#3d4b5c",
    statusStrong: "#08665a",
    statusDim: "#56657a",
    statusGood: "#16794a",
    statusWarn: "#8a5c00",
    statusBad: "#c2372b",
    statusCritical: "#b5179e",
    reasoning: "#56657a",
    userBar: "#2356c4",
    diffAddedBg: "#d8e7e4",
    diffRemovedBg: "#eddfe0",
    diffContextBg: "#e8edf2",
    diffAddedSign: "#16794a",
    diffRemovedSign: "#c2372b",
    lineNumber: "#56657a",
    code: "#0a7a68",
    link: "#2356c4",
    keyword: "#5a48d6",
    string: "#0a7a68",
    number: "#8a5c00",
    func: "#2356c4",
    type: "#2356c4",
    comment: "#56657a",
  },
  ...LEMBAS_LOOK,
}

/** LLeMbas's default, moria (tokens.css): ink on near-black, a pale-cyan accent, the leaf green
 *  of its brand. Code as LLeMbas colours it (chat.css): keyword warning, string success, number
 *  danger, function accent. */
export const MORIA: Theme = {
  name: "moria",
  colors: {
    bg: "#0B0D10",
    text: "#E2E8EC",
    muted: "#A6B2BC",
    dim: "#808D98",
    title: "#7EE081",
    accent: "#8FD8E8",
    border: "#5C6976",
    label: "#B4E6F1",
    ok: "#5FD6B0",
    error: "#F0735F",
    warn: "#F0A840",
    info: "#8FD8E8",
    prompt: "#7EE081",
    panel: "#11151A",
    selection: "#232B34",
    menu: "#171C22",
    menuCurrent: "#1D232B",
    statusText: "#A6B2BC",
    statusStrong: "#7EE081",
    statusDim: "#808D98",
    statusGood: "#5FD6B0",
    statusWarn: "#F0A840",
    statusBad: "#F0735F",
    statusCritical: "#F4907F",
    reasoning: "#808D98",
    userBar: "#8FD8E8",
    diffAddedBg: "#152523",
    diffRemovedBg: "#261919",
    diffContextBg: "#11151A",
    diffAddedSign: "#5FD6B0",
    diffRemovedSign: "#F0735F",
    lineNumber: "#808D98",
    code: "#8FD8E8",
    link: "#8FD8E8",
    keyword: "#F0A840",
    string: "#5FD6B0",
    number: "#F0735F",
    func: "#8FD8E8",
    type: "#B4E6F1",
    comment: "#808D98",
  },
  ...LEMBAS_LOOK,
}

/** LLeMbas's light theme, shire (tokens.css): dark ink on parchment, a forest-green accent. */
export const SHIRE: Theme = {
  name: "shire",
  colors: {
    bg: "#F1EAD6",
    text: "#1F2418",
    muted: "#474D3B",
    dim: "#5E6250",
    title: "#3D6B1C",
    accent: "#285F3C",
    border: "#A99C78",
    label: "#1F4D30",
    ok: "#2B6A55",
    error: "#A3321F",
    warn: "#7E5200",
    info: "#285F3C",
    prompt: "#3D6B1C",
    panel: "#E7DEC6",
    selection: "#E2D8BD",
    menu: "#F8F3E5",
    menuCurrent: "#ECE4CF",
    statusText: "#474D3B",
    statusStrong: "#1F4D30",
    statusDim: "#555948",
    statusGood: "#2B6A55",
    statusWarn: "#7E5200",
    statusBad: "#A3321F",
    statusCritical: "#862818",
    reasoning: "#5E6250",
    userBar: "#285F3C",
    diffAddedBg: "#d9dbc7",
    diffRemovedBg: "#e8d4c0",
    diffContextBg: "#E7DEC6",
    diffAddedSign: "#2B6A55",
    diffRemovedSign: "#A3321F",
    lineNumber: "#5E6250",
    code: "#285F3C",
    link: "#285F3C",
    keyword: "#7E5200",
    string: "#2B6A55",
    number: "#A3321F",
    func: "#285F3C",
    type: "#1F4D30",
    comment: "#5E6250",
  },
  ...LEMBAS_LOOK,
}

export const DEFAULT_THEME = MORIA
export const BUILTIN_THEMES: Record<string, Theme> = { lembas: LEMBAS, "lembas-light": LEMBAS_LIGHT, moria: MORIA, shire: SHIRE, hermes: HERMES, mono: MONO }

/** Where user themes are read from: themes/ first, then the old skins/. */
const userDirs = () => [join(paths.config, "themes"), join(paths.config, "skins")]

export function themeNames(): string[] {
  const user: string[] = []
  for (const dir of userDirs()) {
    try {
      for (const f of new Bun.Glob("*.yaml").scanSync({ cwd: dir })) user.push(f.replace(/\.yaml$/, ""))
    } catch {}
  }
  return [...new Set([...Object.keys(BUILTIN_THEMES), ...user])]
}

/** A named theme: built-in, or a user YAML merged over the default. Unknown → the default. */
export function loadTheme(name: string | undefined, icons?: IconSet): { theme: Theme; warning?: string } {
  const r = loadThemeOnly(name)
  return { ...r, theme: withIcons(r.theme, icons) }
}

/** The names the default themes had before they were called lembas: a config that still says one
 *  keeps its look. */
export const RENAMED_THEMES: Record<string, string> = { houmeres: "lembas", "houmeres-light": "lembas-light" }

function loadThemeOnly(name: string | undefined): { theme: Theme; warning?: string } {
  const n = name ?? DEFAULT_THEME.name
  if (BUILTIN_THEMES[n]) return { theme: BUILTIN_THEMES[n]! }
  const file = userDirs().map((d) => join(d, `${n}.yaml`)).find((f) => existsSync(f))
  if (!file && RENAMED_THEMES[n]) return { theme: BUILTIN_THEMES[RENAMED_THEMES[n]]! }
  if (!file) return { theme: DEFAULT_THEME, warning: `theme "${n}" not found; using ${DEFAULT_THEME.name}` }
  try {
    const u = (parse(readFileSync(file, "utf8")) ?? {}) as Partial<Theme>
    const base = DEFAULT_THEME
    return {
      theme: {
        name: n,
        colors: { ...base.colors, ...u.colors },
        branding: { ...base.branding, ...u.branding },
        spinner: { ...base.spinner, ...u.spinner },
        toolEmoji: { ...base.toolEmoji, ...u.toolEmoji },
        icons: { ...base.icons, ...u.icons },
      },
    }
  } catch (e) {
    return { theme: DEFAULT_THEME, warning: `theme ${file}: ${(e as Error).message}; using ${DEFAULT_THEME.name}` }
  }
}

