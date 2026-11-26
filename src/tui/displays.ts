// Side display pane state & extractors (inspired by LiNA's displays, extended with a real-time
// "Live" activity view so you can always see what the agent is doing right now).
import { duration } from "../duration.ts"
import { open as planOpen, summary as planSummary } from "../plan/plan.ts"
import { callDuration, callTitle } from "../session/display.ts"
import { progressLine } from "../session/progress.ts"
import { diffStat } from "../tool/write.ts"
import { num } from "./locale.ts"
import type { Item, Pending, ViewState } from "./state.ts"

export const DISPLAY_TABS = ["live", "files", "changes", "bash"] as const
export type DisplayTab = (typeof DISPLAY_TABS)[number]

/** Minimum terminal width to show the side-by-side display pane cleanly. */
export const DISPLAY_MIN_WIDTH = 100

/** Cap displayed text per entry so huge reads/outputs stay snappy in the terminal. */
const MAX_BODY_CHARS = 40_000

export interface FileEntry {
  id: string
  title: string
  subtitle: string
  body: string
  status: "running" | "done" | "error" | "denied"
}

export interface ChangeEntry {
  id: string
  title: string
  subtitle: string
  diff: string
  status: "proposed" | "done" | "error" | "denied"
  added: number
  removed: number
}

export interface BashEntry {
  id: string
  title: string
  command: string
  subtitle: string
  output: string
  status: "running" | "done" | "error" | "denied"
}

export interface ActivityRow {
  id: string
  name: string
  title: string
  status: "running" | "done" | "error" | "denied"
  detail: string
  children?: { name: string; title: string; isError?: boolean }[]
}

export interface LiveSnapshot {
  phase: ViewState["phase"]
  statusLine: string
  waiting?: { kind: "permission" | "question" | "plan"; title: string; detail: string }
  thinkingTail?: string
  thinkingStreaming: boolean
  activeTools: ActivityRow[]
  recentTools: ActivityRow[]
  latestPreview?: { kind: "diff" | "bash" | "file"; title: string; body: string }
  plan?: { head: string; lines: { text: string; status: string }[] }
  jobs: { id: string; label: string; state: string; detail: string }[]
}

const CHANGE_TOOLS = new Set(["edit", "write", "multiedit", "apply_patch"])
const FILE_TOOLS = new Set(["read", "show"])

function argStr(args: unknown, key: string): string {
  if (!args || typeof args !== "object") return ""
  const v = (args as Record<string, unknown>)[key]
  return typeof v === "string" ? v : ""
}

function clipHead(text: string, max = MAX_BODY_CHARS): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n… (truncated ${text.length - max} chars)`
}

function clipTail(text: string, max = MAX_BODY_CHARS): string {
  if (text.length <= max) return text
  return `… (earlier ${text.length - max} chars omitted)\n${text.slice(-max)}`
}

function tailLines(text: string, maxLines: number): string {
  const lines = text.trimEnd().split("\n")
  if (lines.length <= maxLines) return lines.join("\n")
  return `…\n${lines.slice(-maxLines).join("\n")}`
}

/** Extract files read/shown in the session for the `files` display tab. */
export function extractFiles(items: readonly Item[]): FileEntry[] {
  const out: FileEntry[] = []
  for (const it of items) {
    if (it.kind !== "tool" || !FILE_TOOLS.has(it.name)) continue
    const path = argStr(it.args, "path") || argStr(it.args, "file_path") || it.title || it.name
    const bits = [...(it.facts ?? []), ...(it.note ? [it.note] : [])]
    const dur = callDuration(it.status === "error" ? "failed" : it.status, it.ms)
    if (dur) bits.push(dur)
    if (it.status === "running") bits.unshift("reading…")
    const body = it.output ? clipHead(it.output) : it.status === "running" ? "(reading file…)" : it.note || "(no content)"
    out.push({
      id: it.id,
      title: path,
      subtitle: bits.join(" · "),
      body,
      status: it.status,
    })
  }
  return out
}

/** Extract applied/denied/proposed file changes for the `changes` display tab. */
export function extractChanges(items: readonly Item[], pending?: Pending): ChangeEntry[] {
  const out: ChangeEntry[] = []
  for (const it of items) {
    if (it.kind === "diff" && it.patch) {
      const stat = diffStat(it.patch)
      out.push({
        id: it.id,
        title: it.title,
        subtitle: `+${stat.added} −${stat.removed}`,
        diff: clipHead(it.patch),
        status: "done",
        added: stat.added,
        removed: stat.removed,
      })
      continue
    }
    if (it.kind !== "tool") continue
    if (!it.diff && !CHANGE_TOOLS.has(it.name)) continue
    const path = argStr(it.args, "path") || argStr(it.args, "file_path") || it.title || it.name
    const diff = it.diff ?? ""
    const stat = diff ? diffStat(diff) : { added: 0, removed: 0 }
    const bits: string[] = []
    if (diff) bits.push(`+${stat.added} −${stat.removed}`)
    if (it.status === "denied") bits.push("denied")
    else if (it.status === "error") bits.push(it.note || "error")
    else if (it.status === "running") bits.push("applying…")
    const dur = callDuration(it.status === "error" ? "failed" : it.status, it.ms)
    if (dur) bits.push(dur)
    out.push({
      id: it.id,
      title: path,
      subtitle: bits.join(" · "),
      diff: diff ? clipHead(diff) : it.note || it.output || "(no diff preview)",
      status: it.status === "running" ? "proposed" : it.status,
      added: stat.added,
      removed: stat.removed,
    })
  }
  if (pending?.preview?.diff) {
    const stat = diffStat(pending.preview.diff)
    const target = pending.request.patterns[0] || argStr(pending.args, "path") || pending.tool
    out.push({
      id: "pending-diff",
      title: target,
      subtitle: `WAITING FOR APPROVAL · +${stat.added} −${stat.removed}`,
      diff: clipHead(pending.preview.diff),
      status: "proposed",
      added: stat.added,
      removed: stat.removed,
    })
  }
  return out
}

/** Extract bash commands (running and finished) for the `bash` display tab. */
export function extractBash(items: readonly Item[]): BashEntry[] {
  const out: BashEntry[] = []
  for (const it of items) {
    if (it.kind !== "tool" || it.name !== "bash") continue
    const command = argStr(it.args, "command") || it.title || "bash"
    const firstLine = command.split("\n")[0] || "bash"
    const bits = [...(it.facts ?? []), ...(it.note ? [it.note] : [])]
    const dur = callDuration(it.status === "error" ? "failed" : it.status, it.ms)
    if (dur) bits.push(dur)
    if (it.status === "running") bits.unshift("running…")
    const output = it.output ? clipTail(it.output) : it.status === "running" ? "(running…)" : it.status === "denied" ? `denied: ${it.note || ""}` : "(no output)"
    out.push({
      id: it.id,
      title: firstLine,
      command,
      subtitle: bits.join(" · "),
      output,
      status: it.status,
    })
  }
  return out
}

function toolDetail(it: Extract<Item, { kind: "tool" }>): string {
  if (it.status === "running") return "running…"
  const bits = [...(it.facts ?? []), ...(it.note ? [it.note] : [])]
  const dur = callDuration(it.status === "error" ? "failed" : it.status, it.ms)
  if (dur) bits.push(dur)
  return bits.join(" · ")
}

/** Build a live cockpit view of everything the agent is currently doing. */
export function buildLiveSnapshot(state: ViewState, nowMs = Date.now()): LiveSnapshot {
  let statusLine = "Idle — ready for your prompt"
  if (state.pending) {
    statusLine = `Waiting for approval: ${state.pending.tool}`
  } else if (state.question) {
    statusLine = "Waiting for your answer"
  } else if (state.plan) {
    statusLine = "Waiting for plan approval"
  } else if (state.now) {
    statusLine = progressLine(state.now, nowMs, num)
  } else if (state.preparing) {
    statusLine = `Preparing tool call: ${state.preparing}`
  } else if (state.phase === "waiting" && state.progress) {
    const pct = state.progress.total ? Math.floor((state.progress.done / state.progress.total) * 100) : 0
    statusLine = `Reading prompt ${pct}% (${num(state.progress.done)} / ${num(state.progress.total)})`
  } else if (state.phase === "thinking") {
    statusLine = "Thinking…"
  } else if (state.phase === "tools") {
    statusLine = "Running tools…"
  } else if (state.phase === "writing") {
    statusLine = "Writing reply…"
  } else if (state.phase === "waiting") {
    statusLine = "Waiting for model…"
  }

  let waiting: LiveSnapshot["waiting"]
  if (state.pending) {
    const detail = state.pending.purpose || state.pending.request.command || state.pending.request.patterns.join(", ") || state.pending.decision.reason
    waiting = { kind: "permission", title: state.pending.tool, detail }
  } else if (state.question) {
    waiting = { kind: "question", title: "Question", detail: state.question.req.why || state.question.req.questions[0]?.question || "Answer in the prompt area" }
  } else if (state.plan) {
    waiting = { kind: "plan", title: state.plan.plan?.title || "Plan ready", detail: "Approve or revise the plan below" }
  }

  const activeTools: ActivityRow[] = []
  const doneTools: ActivityRow[] = []
  let latestReasoning: Extract<Item, { kind: "reasoning" }> | undefined
  let latestPreview: LiveSnapshot["latestPreview"]

  for (const it of state.items) {
    if (it.kind === "reasoning") {
      latestReasoning = it
    } else if (it.kind === "tool") {
      const title = it.title ?? callTitle(it.args) ?? ""
      const row: ActivityRow = {
        id: it.id,
        name: it.name,
        title,
        status: it.status,
        detail: toolDetail(it),
        ...(it.children?.length ? { children: it.children.slice(-6) } : {}),
      }
      if (it.status === "running") activeTools.push(row)
      else doneTools.push(row)

      if (it.diff) {
        latestPreview = { kind: "diff", title: title || it.name, body: tailLines(it.diff, 14) }
      } else if (it.name === "bash" && it.output) {
        latestPreview = { kind: "bash", title: title || "bash", body: tailLines(it.output, 10) }
      } else if (FILE_TOOLS.has(it.name) && it.output) {
        latestPreview = { kind: "file", title: title || it.name, body: it.output.split("\n").slice(0, 10).join("\n") }
      }
    }
  }

  const thinkingTail = latestReasoning?.text.trim() ? tailLines(latestReasoning.text.trim(), 10) : undefined
  const plan = state.livePlan && planOpen(state.livePlan) ? planSummary(state.livePlan) : undefined

  const jobs = state.jobs.slice(0, 8).map((j) => {
    const elapsed = duration((j.ended ?? nowMs) - j.started, true)
    const detail = j.state === "running" ? `running · ${elapsed}` : `${j.state} · ${elapsed}`
    return {
      id: j.id,
      label: j.agent ? `${j.agent}: ${j.description}` : j.description,
      state: j.state,
      detail,
    }
  })

  return {
    phase: state.phase,
    statusLine,
    waiting,
    thinkingTail,
    thinkingStreaming: Boolean(latestReasoning?.streaming),
    activeTools,
    recentTools: doneTools.slice(-10).reverse(),
    latestPreview,
    plan,
    jobs,
  }
}

export interface DisplayNavState {
  tab: DisplayTab
  /** True when the user manually navigated tabs or older entries; pauses auto-switching until reset. */
  pinned: boolean
  /** 0-based selected index per list tab; -1 means "follow newest". */
  index: Record<Exclude<DisplayTab, "live">, number>
}

export function initialNav(): DisplayNavState {
  return { tab: "live", pinned: false, index: { files: -1, changes: -1, bash: -1 } }
}

/** Resolve which tab is active right now: auto-jumps to `changes` when a proposed diff awaits approval (unless pinned). */
export function effectiveTab(nav: DisplayNavState, hasProposedDiff: boolean): DisplayTab {
  if (!nav.pinned && hasProposedDiff) return "changes"
  return nav.tab
}

/** Resolve the 0-based entry index for a list tab (clamped, defaulting to newest when -1). */
export function resolveIndex(nav: DisplayNavState, tab: Exclude<DisplayTab, "live">, count: number): number {
  if (count <= 0) return -1
  const raw = nav.index[tab]
  if (raw < 0 || raw >= count) return count - 1
  return raw
}

/** Move between display tabs (`dir`: -1 for Alt+Up, +1 for Alt+Down). */
export function cycleTab(nav: DisplayNavState, dir: -1 | 1): DisplayNavState {
  const i = DISPLAY_TABS.indexOf(nav.tab)
  const next = DISPLAY_TABS[(i + dir + DISPLAY_TABS.length) % DISPLAY_TABS.length]!
  return { ...nav, tab: next, pinned: next !== "live" }
}

/** Move between entries in the active list tab (`dir`: -1 for Alt+Left, +1 for Alt+Right). */
export function stepEntry(nav: DisplayNavState, tab: Exclude<DisplayTab, "live">, dir: -1 | 1, count: number): DisplayNavState {
  if (count <= 0) return nav
  const cur = resolveIndex(nav, tab, count)
  const next = Math.max(0, Math.min(count - 1, cur + dir))
  const atEnd = next === count - 1
  return {
    ...nav,
    tab,
    pinned: true,
    index: { ...nav.index, [tab]: atEnd ? -1 : next },
  }
}

/** Return to live auto-follow (called when a new user prompt starts). */
export function resetFollow(nav: DisplayNavState): DisplayNavState {
  return { tab: "live", pinned: false, index: { ...nav.index, files: -1, changes: -1, bash: -1 } }
}
