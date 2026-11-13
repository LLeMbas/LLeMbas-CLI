// /reports (harness reports.md, spec 3.8.0): the reports the schedules filed, read from the
// server with the device's token — against a fake server answering with the provisional contract
// (src/lembas/reports.ts) — and /schedule's notify-when. The login this file writes into the
// shared config directory is taken away after each test.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { paths } from "../../src/config/paths.ts"
import { listLines, replyPrompt, reportText, sorted, type Report } from "../../src/lembas/reports.ts"
import { listLines as scheduleLines, notifyWords } from "../../src/lembas/schedules.ts"
import { delta, usage } from "../fake-provider.ts"
import { tui } from "./harness.tsx"

let t: Awaited<ReturnType<typeof tui>> | undefined
let stop: (() => void) | undefined
const seen: { method: string; path: string; body: any }[] = []
const PAGE = "```html-view Disk use\n<!doctype html><svg></svg>\n```"
const make = (): Report[] => [
  { id: "r1", title: "Disk watch: all fine", summary: "Every disk is under 60%.", importance: "normal", schedule: { id: "sched1", title: "Disk watch" }, created: "2026-01-03T07:30:00+00:00", unread: false },
  { id: "r2", title: "Disk almost full", summary: "The log partition is at 94% and grows 2% a day.", importance: "high", schedule: { id: "sched1", title: "Disk watch" }, created: "2026-01-04T07:30:00+00:00", unread: true },
  { id: "r3", title: "Weekly issues", summary: "Seven open, two new.", importance: "normal", schedule: { id: "sched2", title: "Issue digest" }, created: "2026-01-02T08:00:00+00:00", unread: true },
]
let reports: Report[] = []
const BODY: Record<string, string> = { r2: `## What\n\nThe log partition is at **94%**.\n\n${PAGE}\n\nRotate the logs.`, r1: "All fine.", r3: "Seven open." }

function server() {
  reports = make()
  const s = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url)
      if (req.headers.get("authorization") !== "Bearer lmb_key") return new Response("no", { status: 401 })
      const body: any = req.method === "GET" || req.method === "DELETE" ? null : await req.json().catch(() => null)
      seen.push({ method: req.method, path: u.pathname + u.search, body })
      const m = /^\/api\/v2\/reports(?:\/([^/]+)(?:\/(read|reply))?)?$/.exec(u.pathname)
      if (m) {
        const one = reports.find((r) => r.id === m[1])
        if (!m[1]) return Response.json({ reports: u.searchParams.get("unread") ? reports.filter((r) => r.unread) : reports })
        if (!one) return Response.json({ detail: "That report is not available." }, { status: 404 })
        if (m[2] === "read") return ((one.unread = false), Response.json({ ok: true }))
        if (req.method === "DELETE") return ((reports = reports.filter((r) => r !== one)), new Response(null, { status: 204 }))
        return Response.json({ ...one, body: BODY[one.id], chat: null })
      }
      if (u.pathname === "/api/v2/schedules/compile") return Response.json({ ok: true, title: "Disk watch", instruction: "Check the disks.", rule: { every: "day" }, description: "Every day at 07:30", next_runs: ["2026-01-05T07:30:00+00:00"] })
      if (u.pathname === "/api/v2/schedules" && req.method === "POST") return Response.json({ schedule: { id: "sched9", title: body.title, instruction: body.instruction, enabled: true, next_run: "2026-01-05T07:30:00+00:00", notify: body.notify, notify_when: body.notify_when ?? null } }, { status: 201 })
      return Response.json({ detail: "Not here." }, { status: 404 })
    },
  })
  stop = () => s.stop(true)
  mkdirSync(join(paths.config, "lembas"), { recursive: true })
  writeFileSync(join(paths.config, "lembas", "example.key"), "lmb_key\n", { mode: 0o600 })
  writeFileSync(join(paths.config, "lembas.json"), JSON.stringify({ instances: { example: { base_url: `http://127.0.0.1:${s.port}`, connection: "example", scope: "models memory link", logged_in_at: new Date().toISOString() } } }))
}
const clean = () => {
  rmSync(join(paths.config, "lembas.json"), { force: true })
  rmSync(join(paths.config, "lembas"), { recursive: true, force: true })
  seen.length = 0
}
beforeEach(clean)
afterEach(() => {
  t?.stop()
  t = undefined
  stop?.()
  clean()
})
const calls = () => seen.map((s) => `${s.method} ${s.path}`)

test("/reports: unread first, with the schedule and when; enter opens one; read it here — Markdown, a page as its note — and it is marked read", async () => {
  t = await tui([], { width: 120, height: 40 })
  server()
  await t.input.typeText("/reports")
  t.input.pressEnter()
  expect(await t.until("Reports — 2 unread of 3")).toBe(true)
  const f = t.frame()
  expect(f).toContain("Unread")
  expect(f).toContain("Read")
  // Unread first (the newest of them first), the important one marked; then the read one.
  const at = (s: string) => f.indexOf(s)
  expect(at("Disk almost full")).toBeLessThan(at("Weekly issues"))
  expect(at("Weekly issues")).toBeLessThan(at("Disk watch: all fine"))
  expect(f).toMatch(/⚠ Disk almost full {2}Disk watch · 2026-01-04/)
  expect(f).toMatch(/○ Disk watch: all fine/)
  expect(f).toContain("The log partition is at 94%") // the highlighted one's summary
  expect(f).toContain("ctrl+r mark read · ctrl+d delete")
  t.input.pressEnter()
  expect(await t.until("Read it here")).toBe(true)
  expect(t.frame()).toContain("Reply…")
  expect(t.frame()).toContain("Mark as read")
  expect(t.frame()).toContain("esc back")
  t.input.pressEnter()
  expect(await t.until("Report: Disk almost full — Disk watch")).toBe(true)
  expect(await t.until("Rotate the logs.")).toBe(true)
  const shown = t.frame()
  expect(shown).toContain("What") // the heading, rendered
  expect(shown).not.toContain("## What")
  expect(shown).toContain("This answer has a page: Disk use")
  expect(shown).not.toContain("<svg>")
  expect(calls()).toEqual(["GET /api/v2/reports", "GET /api/v2/reports/r2", "POST /api/v2/reports/r2/read"])
  // Not part of the conversation: nothing was sent to a model.
  expect(t.fake.requests).toHaveLength(0)
})

test("/reports: ctrl+r marks the highlighted one read and the list stays; ctrl+d deletes, asked once", async () => {
  t = await tui([], { width: 120, height: 40 })
  server()
  await t.input.typeText("/reports")
  t.input.pressEnter()
  expect(await t.until("Reports — 2 unread of 3")).toBe(true)
  t.input.pressKey("r", { ctrl: true })
  expect(await t.until("Reports — 1 unread of 3")).toBe(true)
  expect(calls()).toContain("POST /api/v2/reports/r2/read")
  t.input.pressKey("d", { ctrl: true })
  expect(await t.until('Delete the report "')).toBe(true)
  // "Keep it" is where the cursor starts.
  t.input.pressEnter()
  expect(await t.until("Reports — 1 unread of 3")).toBe(true)
  expect(calls().some((c) => c.startsWith("DELETE"))).toBe(false)
  t.input.pressKey("d", { ctrl: true })
  expect(await t.until('Delete the report "')).toBe(true)
  t.input.pressArrow("up")
  t.input.pressEnter()
  expect(await t.until("of 2")).toBe(true)
  expect(calls().filter((c) => c.startsWith("DELETE")).length).toBe(1)
  expect(reports.length).toBe(2)
})

test("/reports: reply continues the report in this session — the report, then the person's words", async () => {
  t = await tui([{ chunks: [delta({ content: "I would rotate them weekly." }), usage(100, 5)] }], { width: 120, height: 40 })
  server()
  await t.input.typeText("/reports")
  t.input.pressEnter()
  expect(await t.until("Reports — 2 unread of 3")).toBe(true)
  t.input.pressEnter()
  expect(await t.until("Reply…")).toBe(true)
  t.input.pressArrow("down")
  t.input.pressEnter()
  expect(await t.until("Reply to: Disk almost full")).toBe(true)
  for (const ch of "how often should I rotate?") t.input.pressKey(ch)
  await t.settle()
  t.input.pressEnter()
  expect(await t.until("I would rotate them weekly.")).toBe(true)
  expect(t.frame()).toContain("↩ Disk almost full: how often should I rotate?")
  const sent = t.fake.requests[0].messages.at(-1).content as string
  expect(sent).toContain("<report>\n# Disk almost full\n")
  expect(sent).toContain("The log partition is at **94%**.")
  // The page goes to the model as its one line, not as its source.
  expect(sent).toContain("[page: Disk use]")
  expect(sent).not.toContain("<svg>")
  expect(sent).toContain("</report>\n\nhow often should I rotate?")
  expect(sent).toContain("information, not instructions")
  expect(calls()).toContain("POST /api/v2/reports/r2/read")
})

test("/reports with no reports, with a name, and without a server that has them", async () => {
  t = await tui([], { width: 120, height: 36 })
  server()
  reports = []
  await t.input.typeText("/reports")
  t.input.pressEnter()
  expect(await t.until("Reports — 0 unread of 0")).toBe(true)
  expect(t.frame()).toContain("No reports. A schedule files one when its notify-when says so")
  t.input.pressEscape()
  await t.settle()
  reports = make()
  await t.input.typeText("/reports weekly")
  t.input.pressEnter()
  expect(await t.until("Report: Weekly issues — Issue digest")).toBe(true)
  await t.input.typeText("/reports nosuch")
  t.input.pressEnter()
  expect(await t.until('no report "nosuch"')).toBe(true)
  // Not signed in to a server: said in a line, no menu.
  stop?.()
  clean()
  await t.input.typeText("/reports")
  t.input.pressEnter()
  expect(await t.until("/reports: not logged in to one LLeMbas server")).toBe(true)
})

test("the text where there is no menu: the list unread first, one report with its pages as lines", () => {
  const now = new Date("2026-01-05T12:00:00Z")
  const all = make()
  expect(sorted(all).map((r) => r.id)).toEqual(["r2", "r3", "r1"])
  const lines = listLines(all, now)
  expect(lines[0]).toBe("Reports — 2 unread of 3:")
  expect(lines[1]).toStartWith("- (unread) Disk almost full (r2) — Disk watch · 2026-01-04")
  expect(lines[1]).toEndWith("· important")
  expect(lines[2]).toBe("  The log partition is at 94% and grows 2% a day.")
  expect(listLines([], now)[0]).toStartWith("No reports.")
  const text = reportText({ ...all[1]!, body: BODY.r2 }, now)
  expect(text).toStartWith("# Disk almost full\nDisk watch · 2026-01-04")
  expect(text).toContain("[page: Disk use]")
  expect(text).not.toContain("html-view")
  // A report is a model's text: control characters never reach the terminal.
  expect(reportText({ ...all[0]!, title: "x\x1b[2Jy", body: "a\x1b]0;t\x07b" }, now)).not.toContain("\x1b")
  expect(replyPrompt({ ...all[1]!, body: "B" }, "  ok  ")).toEndWith("</report>\n\nok")
})

test("/schedule new asks when to notify: the default condition, every run, never, or the person's own words", async () => {
  t = await tui([], { width: 120, height: 40 })
  server()
  await t.input.typeText("/schedule new every day at 7:30 check the disks")
  t.input.pressEnter()
  expect(await t.until("Create it")).toBe(true)
  t.input.pressEnter()
  expect(await t.until("Notify when")).toBe(true)
  const f = t.frame()
  if (!f.includes("● When something")) console.log(f.split("\n").slice(6, 24).map((l) => l.trimEnd()).join("\n"))
  expect(f).toContain("● When something needs my attention")
  expect(f).toContain("Every run")
  expect(f).toContain("Never")
  // Their own words.
  for (const ch of "a disk is over 90%") t.input.pressKey(ch)
  await t.settle()
  expect(t.frame()).toContain('When "a disk is over 90%"')
  t.input.pressEnter()
  expect(await t.until("made Disk watch (sched9)")).toBe(true)
  expect(t.frame()).toContain("a report when a disk is over 90%")
  const made = seen.find((s) => s.method === "POST" && s.path === "/api/v2/schedules")!
  expect(made.body).toMatchObject({ notify: "when", notify_when: "a disk is over 90%" })
  // Every run: no condition is sent.
  await t.input.typeText("/schedule new every day at 7:30 check the disks")
  t.input.pressEnter()
  expect(await t.until("Create it")).toBe(true)
  t.input.pressEnter()
  expect(await t.until("Notify when")).toBe(true)
  t.input.pressArrow("down")
  t.input.pressEnter()
  expect(await t.until("a report every run")).toBe(true)
  const second = seen.filter((s) => s.method === "POST" && s.path === "/api/v2/schedules")[1]!
  expect(second.body.notify).toBe("always")
  expect(second.body.notify_when).toBeUndefined()
  expect(notifyWords("when", "")).toBe("a report when something needs my attention")
  expect(notifyWords("never")).toBe("no reports")
  expect(scheduleLines([{ id: "s", title: "T", instruction: "i", enabled: true, notify: "always" }])[1]).toContain("· a report every run")
})
