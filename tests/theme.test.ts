// Themes: every built-in one complete and readable, a user theme merged over the default, the old
// `skin` key still honoured. The contrast floors are LLeMbas's (tests/test_theme_contrast.py):
// body text 7:1 on its background, everything else that is read 4.5:1.
import { expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { loadConfig } from "../src/config/load.ts"
import { paths } from "../src/config/paths.ts"
import { BUILTIN_THEMES, DEFAULT_THEME, HERMES, loadTheme, RENAMED_THEMES, themeNames, type Theme } from "../src/tui/palette.ts"

const lum = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16)
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!
}
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x! + 0.05) / (y! + 0.05)
}

// The themes that paint their own background (hermes and mono keep the terminal's).
const painted = Object.values(BUILTIN_THEMES).filter((t) => t.colors.bg)

test("the default is moria, and every built-in theme has every colour as #rrggbb", () => {
  expect(DEFAULT_THEME.name).toBe("moria")
  expect(painted.map((t) => t.name).sort()).toEqual(["lembas", "lembas-light", "moria", "shire"])
  for (const t of Object.values(BUILTIN_THEMES)) {
    for (const k of Object.keys(HERMES.colors) as (keyof Theme["colors"])[]) expect({ theme: t.name, key: k, ok: /^#[0-9a-fA-F]{6}$/.test(t.colors[k] ?? "") }).toEqual({ theme: t.name, key: k, ok: true })
  }
})

test("readable: text 7:1 on the background; what is read 4.5:1 on the background, the status bar 4.5:1 on the bar", () => {
  const onBg = ["muted", "dim", "title", "accent", "label", "ok", "error", "warn", "info", "prompt", "reasoning", "lineNumber", "code", "link", "keyword", "string", "number", "func", "type", "comment"] as const
  const onPanel = ["statusText", "statusStrong", "statusDim", "statusGood", "statusWarn", "statusBad", "statusCritical"] as const
  const low: string[] = []
  for (const t of painted) {
    const c = t.colors
    if (contrast(c.text, c.bg!) < 7) low.push(`${t.name} text ${contrast(c.text, c.bg!).toFixed(2)}`)
    for (const k of onBg) if (contrast(c[k], c.bg!) < 4.5) low.push(`${t.name} ${k} ${contrast(c[k], c.bg!).toFixed(2)}`)
    for (const k of onPanel) if (contrast(c[k], c.panel) < 4.5) low.push(`${t.name} ${k} on panel ${contrast(c[k], c.panel).toFixed(2)}`)
    if (contrast(c.text, c.menu) < 7) low.push(`${t.name} text on menu ${contrast(c.text, c.menu).toFixed(2)}`)
  }
  expect(low).toEqual([])
})

test("a user theme in themes/ (or the old skins/) is merged over the default; an unknown one falls back with a warning", () => {
  mkdirSync(join(paths.config, "themes"), { recursive: true })
  writeFileSync(join(paths.config, "themes", "mine.yaml"), "colors:\n  accent: '#ff00ff'\n")
  mkdirSync(join(paths.config, "skins"), { recursive: true })
  writeFileSync(join(paths.config, "skins", "old.yaml"), "colors:\n  title: '#00ff00'\n")
  expect(themeNames()).toEqual(expect.arrayContaining(["lembas", "mine", "old"]))
  const mine = loadTheme("mine").theme
  expect(mine.colors.accent).toBe("#ff00ff")
  expect(mine.colors.bg).toBe(DEFAULT_THEME.colors.bg)
  expect(loadTheme("old").theme.colors.title).toBe("#00ff00")
  const none = loadTheme("nope")
  expect(none.theme.name).toBe("moria")
  expect(none.warning).toContain('theme "nope" not found')
})

test("a theme by the name the default had before is the default under its name now", () => {
  for (const [was, is] of Object.entries(RENAMED_THEMES)) expect(loadTheme(was).theme).toBe(BUILTIN_THEMES[is]!)
})

test("`skin:` in an old config.yaml is read as the theme, with a note to rename it", () => {
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(join(paths.config, "config.yaml"), "skin: moria\n")
  const l = loadConfig()
  expect(l.config.theme).toBe("moria")
  expect(l.warnings.join("\n")).toContain("`skin` is now called `theme`")
})
