// `/schedule`: the account's schedules on the LLeMbas server, over the schedule routes of /api/v2,
// which accept this device's token (harness acp.md *The HTTP API*, spec 3.5.0). Scheduling is the
// server's — the rule, the runs, the history, the notifications; this is a window onto it from the
// terminal: list, create from words (the server's compile), pause, resume, run now, history.
import { remoteState } from "../config/remote.ts"
import { apiCall, LembasError, SignInRejected } from "./client.ts"
import { soleInstance } from "./personal.ts"
import { LOOP } from "../harness.ts"

export interface Run {
  id: string
  status: string
  timing?: string
  due_at?: string | null
  started_at?: string | null
  finished_at?: string | null
  waiting_for?: string | null
  retry_at?: string | null
  model?: { name?: string | null } | null
  preview?: string
  error?: { class?: string; text?: string } | null
  /** Spec 3.8.0: the report this run filed, if it filed one. */
  report?: string | null
}

export interface Schedule {
  id: string
  title: string
  instruction: string
  description?: string | null
  enabled: boolean
  next_run?: string | null
  last_run?: Run | null
  running?: boolean
  runs_on?: { device?: string; device_name?: string; cwd?: string; mode?: string } | null
  watch?: { kind: string; url?: string; command?: string } | null
  /** Spec 3.8.0 (harness reports.md §3): when its owner hears from it, and — for `when` — the
   *  condition in their words. Absent on a server before 3.8.0. */
  notify?: string | null
  notify_when?: string | null
}

/** A schedule's notify-when in words, as the list and the form say it. */
export function notifyWords(notify: string | null | undefined, condition?: string | null): string {
  const N = LOOP.scheduled.notify
  if (notify === "always") return "a report every run"
  if (notify === "never") return "no reports"
  return `a report when ${(condition ?? "").trim() || N.default_condition}`
}

export interface Compiled {
  ok: boolean
  reason?: string | null
  title: string
  instruction: string
  target?: string
  rule: Record<string, unknown>
  description?: string | null
  next_runs: string[]
  timezone?: string
}

/** One call to the schedule (and report) routes; the server's own refusal (`detail`) as the error. */
export async function api(method: string, path: string, body?: unknown, what = "schedules"): Promise<any> {
  const one = soleInstance()
  if (!one) throw new LembasError("not logged in to one LLeMbas server (/login)")
  const r = await apiCall(one.instance.base_url, one.token, one.instance.ca ? { ca: one.instance.ca } : undefined, method, `/api/v2${path}`, body)
  const detail = typeof r.json?.detail === "string" ? r.json.detail : undefined
  if (r.status === 401 && !detail) throw new SignInRejected("the server no longer accepts this sign-in — /login again")
  // A server from before spec 3.5.0 lets only an app's token reach /api/v2.
  if (r.status === 401 || (r.status === 403 && /scope|token/i.test(detail ?? "")))
    throw new LembasError(`${one.instance.connection} does not let a linked computer manage ${what} yet (it needs a newer LLeMbas server)`)
  if (r.status === 404 && !detail) throw new LembasError(`${one.instance.connection} has no ${what} here (an older LLeMbas server)`)
  if (r.status >= 400) throw new LembasError(detail ?? `${method} ${path}: ${r.status}`)
  return r.json
}

export const listSchedules = async (): Promise<Schedule[]> => ((await api("GET", "/schedules"))?.schedules ?? []) as Schedule[]
export const compileWords = async (text: string): Promise<Compiled> => (await api("POST", "/schedules/compile", { text })) as Compiled
export const pauseSchedule = async (id: string): Promise<Schedule> => (await api("POST", `/schedules/${encodeURIComponent(id)}/pause`)).schedule
export const resumeSchedule = async (id: string): Promise<Schedule> => (await api("POST", `/schedules/${encodeURIComponent(id)}/resume`)).schedule
export const runSchedule = async (id: string): Promise<Run> => (await api("POST", `/schedules/${encodeURIComponent(id)}/run`)).run
export const scheduleRuns = async (id: string, limit = 10): Promise<{ runs: Run[]; more: boolean }> => {
  const r = await api("GET", `/schedules/${encodeURIComponent(id)}/runs?limit=${limit}`)
  return { runs: (r?.runs ?? []) as Run[], more: r?.more === true }
}
export const runResult = async (id: string, run: string): Promise<{ run: Run; text: string | null }> => api("GET", `/schedules/${encodeURIComponent(id)}/runs/${encodeURIComponent(run)}`)

/** Create one from what compile said. `here`: it runs on this computer, in `cwd`, in Edit
 *  (`runs_on.device: "this"` is the calling device). */
export async function createSchedule(c: Compiled, request: string, here?: { cwd: string }, notify?: { notify: string; condition?: string }): Promise<Schedule> {
  const body: Record<string, unknown> = { title: c.title, instruction: c.instruction, request, rule: c.rule, ...(c.target ? { target: c.target } : {}) }
  // Spec 3.8.0: notify when — the three values, and the person's own words for `when`.
  if (notify) Object.assign(body, { notify: notify.notify, ...(notify.notify === "when" && notify.condition?.trim() ? { notify_when: notify.condition.trim() } : {}) })
  if (here) body.runs_on = { device: "this", cwd: here.cwd, mode: "edit" }
  return (await api("POST", "/schedules", body)).schedule
}

/** A schedule by its id, or by a title that starts with `query` (no case) when only one does. */
export function findSchedule(all: Schedule[], query: string): Schedule | string {
  const q = query.trim()
  if (!q) return "name a schedule: its id or the start of its title (/schedule lists them)"
  const exact = all.find((s) => s.id === q)
  if (exact) return exact
  const low = q.toLowerCase()
  const titled = all.filter((s) => s.title.toLowerCase() === low)
  if (titled.length === 1) return titled[0]!
  const starts = all.filter((s) => s.title.toLowerCase().startsWith(low))
  if (starts.length === 1) return starts[0]!
  if (!starts.length) return `no schedule "${q}" — /schedule lists them`
  return `"${q}" fits ${starts.length} schedules: ${starts.map((s) => `${s.title} (${s.id})`).join(", ")} — use the id`
}

/** A time as the person reads it: the local date and time, minutes only. */
export function when(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, "0")
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const sameDay = d.toDateString() === now.toDateString()
  return sameDay ? `today ${time}` : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`
}

/** A run's status in a word or two: what history and the list show. */
export function runStatus(r: Run): string {
  if (r.status === "waiting") return r.waiting_for === "device" ? "waiting for the computer" : r.waiting_for === "model" ? "waiting for a free model" : "waiting to try again"
  if (r.status === "missed") return "missed"
  if (r.status === "unchanged") return "unchanged (nothing new)"
  if (r.status === "silent") return "nothing to report"
  if (r.status === "ok" && r.report) return "ok — a report"
  return r.status
}

/** `/schedule` and `/schedule list`. */
export function listLines(all: Schedule[], now = new Date()): string[] {
  if (!all.length) return ["no schedules yet — /schedule new <what, and when> (\"every weekday at 8 summarise the open issues\")"]
  const out: string[] = []
  for (const s of all) {
    const state = s.running ? "running" : s.enabled ? `next ${when(s.next_run, now)}` : "paused"
    const last = s.last_run ? ` · last ${runStatus(s.last_run)}${s.last_run.finished_at ? ` ${when(s.last_run.finished_at, now)}` : ""}` : ""
    const where = s.runs_on ? ` · on ${s.runs_on.device_name || "a computer"}${s.runs_on.cwd ? ` in ${s.runs_on.cwd}` : ""}` : ""
    const watch = s.watch ? ` · watches ${s.watch.kind === "url" ? s.watch.url : s.watch.command}` : ""
    const reports = s.notify ? ` · ${notifyWords(s.notify, s.notify_when)}` : ""
    out.push(`${s.title} (${s.id}) — ${s.description || "no rule"}`)
    out.push(`  ${state}${last}${where}${watch}${reports}`)
  }
  out.push("", "/schedule new <words> · pause|resume|run|history <id or title>")
  return out
}

/** `/schedule history`: the newest runs first. Previews are model output: shown as plain text. */
export function historyLines(s: Schedule, runs: Run[], more: boolean, now = new Date()): string[] {
  const out = [`${s.title} (${s.id}) — ${s.description || "no rule"}`]
  if (!runs.length) out.push("  no runs yet")
  for (const r of runs) {
    const at = when(r.finished_at ?? r.started_at ?? r.due_at, now)
    const model = r.model?.name ? ` · ${r.model.name}` : ""
    out.push(`  ${at}  ${runStatus(r)}${r.timing === "late" ? " (late)" : r.timing === "catch_up" ? " (caught up)" : ""}${model}  [${r.id}]`)
    const said = r.error?.text || (r.preview ?? "").replace(/\s+/g, " ").trim()
    if (said) out.push(`    ${said.length > 160 ? said.slice(0, 159) + "…" : said}`)
  }
  if (more) out.push("  … older runs on the server")
  return out
}

/** What compile made of the words, before anything is created. */
export function previewLines(c: Compiled, now = new Date()): string[] {
  const out = [`${c.title || "(no title)"} — ${c.description || "no rule worked out"}`]
  if (c.instruction) out.push(`  does: ${c.instruction}`)
  if (c.next_runs.length) out.push(`  next: ${c.next_runs.map((t) => when(t, now)).join(", ")}${c.timezone ? ` (${c.timezone})` : ""}`)
  if (!c.ok && c.reason) out.push(`  ${c.reason}`)
  return out
}

/** Whether a schedule could run here, in `cwd`: Accept scheduled work is on and remote work may use it. */
export function canRunHere(): boolean {
  const s = remoteState()
  return s.enabled && s.scheduled && s.roots.length > 0
}
