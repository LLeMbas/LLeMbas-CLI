// `/schedule` over the schedule routes of /api/v2 with this device's token (harness acp.md, spec
// 3.5.0). A fake server answering with the shapes of the server's contract fixtures; the instance
// index and key are removed after each test (the suite shares one home).
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { paths } from "../src/config/paths.ts"
import { compileWords, createSchedule, findSchedule, historyLines, listLines, listSchedules, pauseSchedule, runSchedule, scheduleRuns, type Run, type Schedule } from "../src/lembas/schedules.ts"

const RUN: Run = {
  id: "run1",
  status: "ok",
  timing: "late",
  due_at: "2026-01-02T03:04:05+00:00",
  started_at: "2026-01-02T03:04:05+00:00",
  finished_at: "2026-01-02T03:04:05+00:00",
  waiting_for: null,
  model: { name: "GPT-OSS" },
  preview: "All the waybread is wrapped.",
  error: null,
}
const SCHED: Schedule = {
  id: "sched1",
  title: "Waybread check",
  instruction: "Check the waybread is wrapped.",
  description: "On the second Monday of each month at 07:30",
  enabled: true,
  next_run: "2026-01-12T07:30:00+00:00",
  last_run: RUN,
  running: false,
}
const COMPILED = {
  ok: true,
  reason: null,
  title: "Waybread check",
  instruction: "Check the waybread is wrapped.",
  target: "chat",
  rule: { at: { nth: [{ n: 2, weekday: 0 }], times: ["07:30"] } },
  description: "On the second Monday of each month at 07:30",
  next_runs: ["2026-01-12T07:30:00+00:00", "2026-02-09T07:30:00+00:00"],
  timezone: "UTC",
}

let stop: (() => void) | undefined
const seen: { method: string; path: string; body: any }[] = []

function server(o: { appOnly?: boolean } = {}) {
  const s = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url)
      if (req.headers.get("authorization") !== "Bearer lmb_key") return new Response("no", { status: 401 })
      const body: any = req.method === "GET" ? null : await req.json().catch(() => null)
      seen.push({ method: req.method, path: u.pathname + u.search, body })
      // An older server: /api/v2 for an app's token only.
      if (o.appOnly) return Response.json({ detail: "This token does not have the app scope." }, { status: 403 })
      if (u.pathname === "/api/v2/schedules" && req.method === "GET") return Response.json({ schedules: [SCHED, { ...SCHED, id: "sched2", title: "Waybread count", enabled: false, last_run: null }] })
      if (u.pathname === "/api/v2/schedules" && req.method === "POST") return Response.json({ schedule: { ...SCHED, id: "sched3", title: body.title } }, { status: 201 })
      if (u.pathname === "/api/v2/schedules/compile") return Response.json(COMPILED)
      if (u.pathname === "/api/v2/schedules/sched1/pause") return Response.json({ schedule: { ...SCHED, enabled: false } })
      if (u.pathname === "/api/v2/schedules/sched1/run") return Response.json({ run: { ...RUN, id: "run9", status: "running" } }, { status: 202 })
      if (u.pathname === "/api/v2/schedules/sched1/runs") return Response.json({ runs: [{ ...RUN, id: "run2", status: "unchanged", preview: "" }, RUN], more: true })
      return Response.json({ detail: "That schedule is not available." }, { status: 404 })
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
  stop?.()
  clean()
})

test("list, pause, run now and history go to the schedule routes with the device's token", async () => {
  server()
  const all = await listSchedules()
  expect(all.map((s) => s.id)).toEqual(["sched1", "sched2"])
  const now = new Date("2026-01-05T12:00:00Z")
  const lines = listLines(all, now)
  expect(lines[0]).toBe("Waybread check (sched1) — On the second Monday of each month at 07:30")
  expect(lines[1]).toContain("· last ok")
  expect(lines[3]).toBe("  paused")
  expect((await pauseSchedule("sched1")).enabled).toBe(false)
  expect((await runSchedule("sched1")).id).toBe("run9")
  const h = await scheduleRuns("sched1")
  const hist = historyLines(SCHED, h.runs, h.more, now)
  expect(hist[1]).toContain("unchanged (nothing new)")
  expect(hist).toContain("    All the waybread is wrapped.")
  expect(hist.at(-1)).toBe("  … older runs on the server")
  expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(["GET /api/v2/schedules", "POST /api/v2/schedules/sched1/pause", "POST /api/v2/schedules/sched1/run", "GET /api/v2/schedules/sched1/runs?limit=10"])
})

test("create from words: compile, then the rule as compiled; here: runs on this device", async () => {
  server()
  const c = await compileWords("every second Monday at 7:30 check the waybread")
  expect(c.description).toBe("On the second Monday of each month at 07:30")
  await createSchedule(c, "every second Monday at 7:30 check the waybread")
  await createSchedule(c, "every second Monday", { cwd: "/work/app" })
  const posts = seen.filter((s) => s.path === "/api/v2/schedules")
  expect(posts[0]!.body).toEqual({ title: "Waybread check", instruction: "Check the waybread is wrapped.", request: "every second Monday at 7:30 check the waybread", rule: COMPILED.rule, target: "chat" })
  expect(posts[1]!.body.runs_on).toEqual({ device: "this", cwd: "/work/app", mode: "edit" })
})

test("an older server that lets only an app's token in: said plainly; not logged in: said", async () => {
  server({ appOnly: true })
  await expect(listSchedules()).rejects.toThrow("does not let a linked computer manage schedules")
  clean()
  await expect(listSchedules()).rejects.toThrow("not logged in")
})

test("findSchedule: by id, by a title's start when only one fits, else says why", () => {
  const all = [SCHED, { ...SCHED, id: "sched2", title: "Waybread count" }, { ...SCHED, id: "sched3", title: "Backup" }]
  expect(findSchedule(all, "sched2")).toMatchObject({ id: "sched2" })
  expect(findSchedule(all, "back")).toMatchObject({ id: "sched3" })
  expect(findSchedule(all, "waybread")).toContain("fits 2 schedules")
  expect(findSchedule(all, "nothing")).toContain("no schedule")
  expect(findSchedule(all, "")).toContain("name a schedule")
})
