// Display (harness spec 3.7.0, harness/display.md): what every client says about a tool call, the
// end of a reply and a number — the title, the states, the facts after the title. Pure: the TUI,
// the progress tracker and the ACP agent all read these.
import { LOOP } from "../harness.ts"
import { fillPrompt } from "../prompt/fill.ts"
import { duration } from "../duration.ts"

const D = LOOP.display

/** How a number is written: the plain format (no grouping, `.`) unless a client passes its own. */
export type NumberFormat = (n: number, decimals?: number) => string

export const plainNumber: NumberFormat = (n, decimals) => (decimals === undefined ? String(n) : n.toFixed(decimals))

/** A formatter for a locale (display.md §6): the platform's grouping and decimal mark. An unknown
 *  locale is the plain format. */
export function localeNumber(locale: string | undefined): NumberFormat {
  if (!locale) return plainNumber
  try {
    const whole = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 })
    const cache = new Map<number, Intl.NumberFormat>()
    return (n, decimals) => {
      if (decimals === undefined) return (Number.isInteger(n) ? whole : new Intl.NumberFormat(locale)).format(n)
      let f = cache.get(decimals)
      if (!f) cache.set(decimals, (f = new Intl.NumberFormat(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })))
      return f.format(n)
    }
  } catch {
    return plainNumber
  }
}

/** The locale a terminal runs in, as a BCP 47 tag: LC_ALL, then LC_NUMERIC, then LANG
 *  (`sk_SK.UTF-8` → `sk-SK`). `C`, `POSIX` and nothing at all are no locale: the plain format. */
export function terminalLocale(env: Record<string, string | undefined> = process.env): string | undefined {
  const raw = env.LC_ALL || env.LC_NUMERIC || env.LANG
  if (!raw) return undefined
  const name = raw.split(/[.@]/)[0]!
  if (!name || name === "C" || name === "POSIX") return undefined
  const tag = name.replace(/_/g, "-")
  try {
    return Intl.getCanonicalLocales(tag)[0]
  } catch {
    return undefined
  }
}

/** One line, cut to the title's length in code points (79 and an ellipsis). */
export function shortTitle(s: string | undefined): string | undefined {
  if (!s) return undefined
  const line = s.trim().split("\n")[0]!.trim()
  if (!line) return undefined
  const max = LOOP.progress.what_max
  const points = [...line]
  return points.length > max ? `${points.slice(0, max - 1).join("")}…` : line
}

/** The files a patch names: its `*** Add/Update/Delete File:` lines, else its `+++ ` lines. */
function patchFiles(patch: string): string[] {
  const lines = patch.split("\n")
  const named = lines.flatMap((l) => {
    const head = D.title.patch_files.find((h) => l.startsWith(h))
    return head ? [l.slice(head.length).trim()] : []
  })
  if (named.length) return named.filter(Boolean)
  return lines
    .filter((l) => l.startsWith("+++ "))
    .map((l) => l.slice(4).split("\t")[0]!.trim().replace(/^b\//, ""))
    .filter((f) => f && f !== "/dev/null")
}

/** A tool call's one short title (display.md §1), from its arguments alone: the same string in the
 *  transcript, as `what` of running_tool and as the link's tool_call title. */
export function callTitle(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined
  const a = args as Record<string, unknown>
  if (Array.isArray(a.questions)) {
    const headers = (a.questions as unknown[]).map((q) => (q && typeof q === "object" ? (q as { header?: unknown }).header : undefined)).filter((h): h is string => typeof h === "string" && h.trim() !== "")
    const t = shortTitle(headers.map((h) => h.trim()).join(D.title.questions_join))
    if (t) return t
  }
  if (typeof a.patch === "string") {
    const t = shortTitle(patchFiles(a.patch).join(D.title.patch_join))
    if (t) return t
  }
  for (const k of D.title.keys) {
    const v = a[k]
    if (typeof v === "string" && v.trim()) return shortTitle(v)
  }
  return undefined
}

export type CallState = "running" | "done" | "failed" | "denied"

/** A finished call's duration (display.md §2): tenths under a minute, then 1m 05s, 2h 03m. None
 *  for a call that is running or was denied, or whose time was not kept. */
export function callDuration(state: CallState, ms: number | undefined): string | undefined {
  if (D.no_duration.includes(state) || ms === undefined || !Number.isFinite(ms)) return undefined
  return duration(ms)
}

/** The lines a unified diff adds and removes, counted by its hunks (display.md §2): nothing
 *  outside a hunk counts, so a file header never does and a removed `-- x` line always does. */
export function diffCounts(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  let old = 0
  let fresh = 0
  for (const l of diff.split("\n")) {
    if (old <= 0 && fresh <= 0) {
      const m = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(l)
      if (m) {
        old = m[1] === undefined ? 1 : Number(m[1])
        fresh = m[2] === undefined ? 1 : Number(m[2])
      }
      continue
    }
    if (l.startsWith("+")) {
      added++
      fresh--
    } else if (l.startsWith("-")) {
      removed++
      old--
    } else if (l.startsWith("\\")) continue
    else {
      old--
      fresh--
    }
  }
  return { added, removed }
}

const fill = (t: string, v: Record<string, string>) => fillPrompt(t, v)

/** `+3 −1` for an edit. */
export function changeText(c: { added: number; removed: number }, num: NumberFormat = plainNumber): string {
  return fill(D.change, { added: num(c.added), removed: num(c.removed) })
}

/** The facts after a finished call's title (display.md §2): an edit's change, a command's exit
 *  code when it is not 0, a search's hits. */
export function callFacts(f: { block?: string; diff?: string; exit?: number | null; hits?: number }, num: NumberFormat = plainNumber): string[] {
  const out: string[] = []
  if (f.block === "edit" && f.diff) out.push(changeText(diffCounts(f.diff), num))
  if (f.block === "shell" && typeof f.exit === "number" && f.exit !== 0) out.push(fill(D.exit, { code: String(f.exit) }))
  if (f.block === "search" && typeof f.hits === "number") out.push(fill(f.hits === 1 ? D.hit : D.hits, { count: num(f.hits) }))
  return out
}

/** Whether a tool's block is drawn as a call at all (display.md §3). */
export const drawnBlock = (block: string | undefined) => !D.not_drawn.includes(block ?? "tool")
