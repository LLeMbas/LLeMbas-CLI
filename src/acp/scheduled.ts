// Scheduled work on a linked computer (harness acp.md, spec 3.5.0): what this device makes of a
// scheduled turn and of a monitor's watch command. The server decides when a schedule runs; the
// device decides whether (Accept scheduled work, `remote.scheduled`) and how far (the schedule's
// mode, never wider than Edit unless it says Auto, lowered to remote.max_mode). The pure rules are
// here, run by the conformance areas `scheduled`, `silent` and `monitor`; agent.ts wires them in.
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { loadConfig } from "../config/load.ts"
import type { Mode, PermissionConfig } from "../config/schema.ts"
import { LOOP } from "../harness.ts"
import { DEFAULT_RULES, evaluate, toRules, type Rule } from "../permission/evaluate.ts"
import { BUILTIN_HARDLINE, hardlineRules, type HardlineRule } from "../permission/hardline.ts"
import { fillPrompt } from "../prompt/fill.ts"
import { findProject, trustOf } from "../project/root.ts"
import type { Message } from "../provider/types.ts"

export const SCHEDULED = LOOP.scheduled

const RANK: Record<Mode, number> = { auto: 0, edit: 1, manual: 2, plan: 3 }
/** A mode lowered to `max` (agent.ts clampMode, kept here so neither imports the other). */
const clampMode = (wanted: Mode, max: Mode): Mode => (RANK[wanted] < RANK[max] ? max : wanted)

/** Why a scheduled request is refused: `data.reason` of the -32602. */
export type Refusal = "scheduled_off" | "plan" | "folder" | "permission"

/** What a scheduled request says (`_meta.lembas.scheduled`, or `_lembas/monitor`'s params). */
export interface ScheduledMeta {
  schedule_id?: string
  run_id?: string
  title?: string
  mode?: unknown
  approval_wait_s?: unknown
  /** Spec 3.8.0 (reports.md §6): the schedule's notify-when. Absent: a server before 3.8.0. */
  notify?: unknown
}

/** A scheduled turn's settings, once the device has judged it. */
export interface ScheduledTurn {
  scheduleId: string
  runId: string
  title: string
  mode: Mode
  waitMs: number
  /** Spec 3.8.0: the schedule's notify-when, when the server said one — the run may then file a
   *  report (unless `never`) and the retired sentinel means nothing. Absent: a 3.5–3.7 server,
   *  whose runs are judged as before. */
  notify?: Notify
}

/** The schedule's mode and approval wait as this device runs them, or why it refuses
 *  (conformance/scheduled.json). `accept`: remote.scheduled with remote work on. */
export function scheduledMode(o: { accept: boolean; mode?: unknown; max_mode: Mode; approval_wait_s?: unknown }): { mode: Mode; wait_s: number } | { refused: Refusal } {
  if (!o.accept) return { refused: "scheduled_off" }
  if (o.mode === "plan") return { refused: "plan" }
  // An unknown word is the default, never anything wider (`unrestricted` is not read as auto here).
  const chosen: Mode = (SCHEDULED.modes as string[]).includes(o.mode as string) ? (o.mode as Mode) : (SCHEDULED.default_mode as Mode)
  return { mode: clampMode(chosen, o.max_mode), wait_s: approvalWait(o.approval_wait_s) }
}

/** The approval wait in whole seconds, clamped (loop.json scheduled.approval_wait_seconds). */
export function approvalWait(v: unknown): number {
  const W = SCHEDULED.approval_wait_seconds
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : W.default
  return Math.max(W.min, Math.min(W.max, n))
}

/** The fixed text of a refusal. */
export function refusalText(reason: "scheduled_off" | "plan"): string {
  return reason === "plan" ? SCHEDULED.texts.plan : SCHEDULED.texts.off
}

/** The feedback a scheduled approval nobody answered gives the model. */
export function deniedText(waitMs: number): string {
  return fillPrompt(SCHEDULED.texts.denied, { minutes: String(Math.max(1, Math.round(waitMs / 60_000))) })
}

// --- The sentinel --------------------------------------------------------------------------

const marks = (line: string) => line.trim().replace(/\.+$/, "").trim().toUpperCase() === SCHEDULED.sentinel

/** Whether a reply is silent: the sentinel on its first or last non-empty line, any case, every
 *  trailing full stop forgiven (conformance/silent.json; the server's `notify.is_silent`). */
export function isSilent(text: string): boolean {
  const lines = (text ?? "")
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  return lines.length > 0 && (marks(lines[0]!) || marks(lines[lines.length - 1]!))
}

/** The reply without any sentinel line, trimmed: what a preview shows. */
export function stripSentinel(text: string): string {
  return (text ?? "")
    .trim()
    .split(/\r?\n/)
    .filter((l) => !marks(l))
    .join("\n")
    .trim()
}

/** The text of the last assistant message: a turn's final reply. */
export function finalReply(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === "user") return ""
    if (m.role !== "assistant") continue
    const text = m.parts.map((p) => (p.type === "text" ? p.text : "")).join("")
    if (text.trim()) return text
  }
  return ""
}

/** The run's outcome, for `session/prompt`'s `_meta.lembas.scheduled`. */
export function runOutcome(o: { runId: string; reason: string; text: string; error?: string; notify?: Notify; report?: Report }) {
  let status: "ok" | "silent" | "failed" | "cancelled"
  let error: string | null = null
  if (o.reason === "cancelled") status = "cancelled"
  else if (o.reason === "error") {
    status = "failed"
    error = o.error || "the turn failed"
  } else if (!o.text.trim()) {
    status = "failed"
    error = SCHEDULED.texts.no_reply
  } else status = o.notify === undefined && isSilent(o.text) ? "silent" : "ok"
  // Spec 3.8.0: the report written in the turn travels with its answer — also from a turn that
  // then failed: what was found is not thrown away with the error. `silent` is a status of 3.5.0.
  return { run_id: o.runId, status, text: o.text, error, ...(o.report ? { report: o.report } : {}) }
}

// --- The watch command ---------------------------------------------------------------------

/** `sha256:` and the hex SHA-256 of the output's bytes as read, a newline, and the exit status:
 *  the status after the bytes, so a stream is hashed as it comes (conformance/monitor.json). */
export function monitorHash(exit: number, output: Uint8Array | string): string {
  const h = createHash("sha256")
  h.update(typeof output === "string" ? Buffer.from(output, "utf8") : output)
  h.update(`\n${exit}`)
  return `sha256:${h.digest("hex")}`
}

/** The permission context a `bash` call in `cwd` would be judged in: the hardline, the default
 *  rules, the global rules and — in a trusted project — the project's (as app.ts builds them). */
export function permissionFor(cwd: string): { rules: Rule[]; hardline: HardlineRule[]; root: string; planDir: string; projectDir: string } {
  const project = findProject(cwd)
  const trusted = trustOf(project.root) === "trusted"
  const loaded = loadConfig({ projectConfigDir: project.dir, trusted })
  return {
    rules: [...toRules(DEFAULT_RULES, "default"), ...loaded.permissions.flatMap((p, i) => toRules(p, loaded.permissionSources[i] ?? "global"))],
    hardline: hardlineRules({ extra: loaded.config.hardline_extra, disable: loaded.config.hardline_disable }),
    root: project.root,
    planDir: join(project.dir, "plans"),
    projectDir: project.dir,
  }
}

/** Whether a watch command may run in `mode`: only where the mode allows it without asking
 *  (conformance/monitor.json `judge`). */
export function judgeMonitor(line: string, mode: Mode, ctx: { rules: Rule[]; hardline: HardlineRule[]; root: string; cwd?: string; planDir?: string; projectDir?: string }): { run: true } | { refused: "asks" | "denied"; text: string } {
  const d = evaluate({ permission: "bash", class: "execute", patterns: [line], command: line, paths: [ctx.cwd ?? ctx.root] }, { mode, rules: ctx.rules, hardline: ctx.hardline, root: ctx.root, planDir: ctx.planDir, projectDir: ctx.projectDir })
  if (d.action === "allow") return { run: true }
  const reason = d.reason || (d.action === "ask" ? "it is not allowed without asking" : "refused")
  if (d.action === "ask") return { refused: "asks", text: fillPrompt(SCHEDULED.texts.monitor_asks, { mode, reason }) }
  return { refused: "denied", text: fillPrompt(SCHEDULED.texts.monitor_denied, { reason }) }
}

/** The conformance runner's judge: the default rules and the case's own as global rules. */
export function judgeCase(line: string, mode: Mode, extra?: PermissionConfig) {
  const rules = [...toRules(DEFAULT_RULES, "default"), ...toRules(extra ?? {}, "global")]
  return judgeMonitor(line, mode, { rules, hardline: BUILTIN_HARDLINE, root: "/project", planDir: "/project/.agent/plans", projectDir: "/project/.agent" })
}

export interface MonitorResult {
  hash: string | null
  exit: number | null
  timed_out: boolean
  excerpt: string
  truncated: boolean
  bytes: number
  duration_ms: number
}

/** The watch command's timeout in seconds, defaulted and clamped. */
export function monitorTimeout(v: unknown): number {
  const T = SCHEDULED.monitor.timeout_seconds
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : T.default
  return Math.max(T.min, Math.min(T.max, n))
}

/** Run a watch command as `bash -c` in `cwd`, in its own process group, with no input; stop the
 *  group at the timeout. Everything streamed is hashed; the first output_max_bytes are kept. */
export function runMonitor(command: string, cwd: string, timeoutS: number, env: Record<string, string | undefined> = process.env): Promise<MonitorResult> {
  const M = SCHEDULED.monitor
  const started = Date.now()
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", `exec 2>&1\n${command}`], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], env })
    const hash = createHash("sha256")
    const kept: Buffer[] = []
    let keptBytes = 0
    let bytes = 0
    let timedOut = false
    const onData = (d: Buffer) => {
      bytes += d.length
      hash.update(d)
      if (keptBytes < M.output_max_bytes) {
        const piece = d.subarray(0, M.output_max_bytes - keptBytes)
        kept.push(piece)
        keptBytes += piece.length
      }
    }
    child.stdout!.on("data", onData)
    child.stderr!.on("data", onData)
    const killGroup = (sig: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, sig)
      } catch {}
    }
    const timer = setTimeout(() => {
      timedOut = true
      killGroup("SIGTERM")
      setTimeout(() => killGroup("SIGKILL"), 2000).unref()
    }, timeoutS * 1000)
    let done = false
    const finish = (code: number | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      const text = Buffer.concat(kept).toString("utf8")
      const excerpt = text.slice(0, M.excerpt_chars)
      const exit = timedOut || child.signalCode ? null : code
      if (exit !== null) hash.update(`\n${exit}`)
      resolve({
        hash: exit === null ? null : `sha256:${hash.digest("hex")}`,
        exit,
        timed_out: timedOut,
        excerpt,
        truncated: bytes > Buffer.byteLength(excerpt, "utf8"),
        bytes,
        duration_ms: Date.now() - started,
      })
    }
    child.on("close", (code) => finish(code))
    child.on("error", () => finish(127))
  })
}

// ---- Reports (harness reports.md, spec 3.8.0) ----

const NOTIFY = SCHEDULED.notify
export type Notify = "always" | "when" | "never"

/** A report as report_write files it. */
export interface Report {
  title: string
  body: string
  summary: string
  importance: "normal" | "high"
}

/** A schedule's notify-when as a value: a word nobody knows, or none, is the default. */
export function notifyOf(v: unknown): Notify {
  return (NOTIFY.values as string[]).includes(v as string) ? (v as Notify) : (NOTIFY.default as Notify)
}

/** The instruction placed in the run's prompt (reports.md §3): the text for the value, the
 *  condition the person's words — one line, trimmed, without a closing full stop — or the default
 *  one; "" for never. */
export function notifyInstruction(notify: unknown, condition?: unknown): string {
  const n = notifyOf(notify)
  if (n === "never") return ""
  if (n === "always") return NOTIFY.texts.always
  const own = typeof condition === "string" ? condition.split(/\s+/).filter(Boolean).join(" ").replace(/\.+$/, "").trim() : ""
  return fillPrompt(NOTIFY.texts.when, { condition: own || NOTIFY.default_condition })
}

/** Whether report_write is in a session's list, and what a call meets (reports.md §2): only a
 *  session a schedule opened for its run, when it notifies at all, and never a subagent's; in
 *  such a session a turn that is not the schedule's answers the tool's unavailable text. */
export function reportTool(o: { session: string; notify?: unknown; turn: string; subagent?: boolean }): "offered" | "absent" | "unavailable" {
  if (o.session !== "scheduled" || o.subagent || notifyOf(o.notify) === "never") return "absent"
  return o.turn === "run" ? "offered" : "unavailable"
}

/** What report_write answers: the first report of a run is filed, a later one replaces it. */
export const reportResult = (calls: number) => (calls > 1 ? NOTIFY.result.replaced : NOTIFY.result.filed)

/** A report_write call's arguments as a report. */
export function asReport(args: { title?: unknown; body?: unknown; summary?: unknown; importance?: unknown }): Report {
  return { title: String(args.title ?? "").trim(), body: String(args.body ?? ""), summary: String(args.summary ?? "").trim(), importance: args.importance === "high" ? "high" : "normal" }
}

const cutTo = (s: string, max: number) => ([...s].length > max ? `${[...s].slice(0, max - 1).join("")}…` : s)

/** What a run leaves (reports.md §4): its report — the last one written; under `always`, with
 *  none written, the answer filed as one — and the history line. The retired sentinel is read as
 *  nothing to tell (§5). */
export function runLeaves(o: { notify?: unknown; title: string; calls: Parameters<typeof asReport>[0][]; answer: string }): { report: Report | null; note: string } {
  const notify = notifyOf(o.notify)
  const answer = (isSilent(o.answer ?? "") ? stripSentinel(o.answer) : (o.answer ?? "")).trim()
  const first = answer.split(/\r?\n/).map((l) => l.trim()).find(Boolean)
  const note = first ? cutTo(first, NOTIFY.note_max) : SCHEDULED.texts.no_reply
  if (o.calls.length) return { report: asReport(o.calls[o.calls.length - 1]!), note }
  if (notify !== "always" || !answer) return { report: null, note }
  const paragraph = answer.split(/\r?\n\s*\r?\n/)[0]!.split(/\s+/).filter(Boolean).join(" ")
  return { report: { title: o.title, body: answer, summary: cutTo(paragraph, NOTIFY.summary_max), importance: "normal" }, note }
}
