// The plan as a structure (src/plan/plan.ts, harness spec 1.1.0): what the conformance cases do
// not pin — how it is shown, the panel's digest, and that the engine keeps it with the session.
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../src/app.ts"
import type { Event } from "../src/bus/index.ts"
import { paths } from "../src/config/paths.ts"
import { apply, fromTodos, isPlan, normalise, open, progress, render, summary, type Plan } from "../src/plan/plan.ts"
import { Store } from "../src/session/store.ts"
import { delta, fakeProvider, toolCall, type Fake } from "./fake-provider.ts"

let fake: Fake | undefined
afterEach(() => fake?.stop())

const plan = normalise({
  title: "Fix the login bug",
  summary: "Two changes.",
  findings: ["Session cookie is not renewed", "Test missing"],
  objectives: ["Login works"],
  phases: [
    { title: "Code", status: "done", tasks: [{ text: "Renew the cookie", status: "done" }, { text: "Add the test", status: "dropped", note: "not needed" }] },
    { title: "Verify", status: "active", tasks: [{ text: "Run the suite", status: "doing" }, "Tag it"] },
  ],
}) as Plan

test("render: the plan as text with its ids, one mark per task, a note after a dash", () => {
  expect(render(plan)).toBe(
    ["# Fix the login bug", "Two changes.", "Findings: [f1] Session cookie is not renewed; [f2] Test missing", "Objectives: [o1] Login works (open)", "## p1 Code (done)", "[t1] [x] Renew the cookie", "[t2] [~] Add the test — not needed", "## p2 Verify (active)", "[t3] [>] Run the suite", "[t4] [ ] Tag it"].join("\n"),
  )
  // An empty summary, no findings and no objectives leave no line behind.
  expect(render(normalise({ title: "T", phases: [{ title: "P", tasks: ["a"] }] }) as Plan)).toBe("# T\n## p1 P (pending)\n[t1] [ ] a")
})

test("progress leaves dropped tasks out; the panel's digest is the active phase, the count, what is doing, next, and the last two done", () => {
  expect(progress(plan)).toEqual({ done: 1, total: 3 })
  expect(open(plan)).toBe(true)
  const s = summary(plan)
  expect(s.head).toBe("plan 1/3 · Verify")
  expect(s.lines).toEqual([
    { status: "doing", text: "Run the suite" },
    { status: "todo", text: "Tag it" },
    { status: "done", text: "Renew the cookie" },
  ])
  // One phase: the plan's title heads the panel. Everything done or dropped: nothing open.
  const one = fromTodos([{ content: "a", status: "completed" }, { content: "b", status: "cancelled" }]) as Plan
  expect(summary(one).head).toBe("plan 1/1 · Work")
  expect(open(one)).toBe(false)
  expect(summary(normalise({ title: "Big", phases: [{ title: "P", tasks: ["1", "2", "3", "4", "5", "6", "7"] }] }) as Plan).lines).toHaveLength(5)
})

test("apply never changes the plan it was given, and refuses an `after` that is no task", () => {
  const before = JSON.stringify(plan)
  const r = apply(plan, { tasks: [{ id: "t4", status: "done" }], add_tasks: [{ phase: "p2", text: "Push", after: "t3" }] })
  expect("plan" in r && r.plan.phases[1]!.tasks.map((t) => `${t.id}:${t.status}`)).toEqual(["t3:doing", "t5:todo", "t4:done"])
  expect(JSON.stringify(plan)).toBe(before)
  expect(apply(plan, { add_tasks: [{ phase: "p2", text: "x", after: "t99" }] })).toEqual({ error: 'Unknown task id "t99". Known: t1, t2, t3, t4.' })
  expect(apply(plan, { add_tasks: [{ phase: "p2", text: "  " }] })).toEqual({ error: "A new task needs its text." })
  expect(apply(plan, { objectives: [{ id: "o1", status: "closed" }] })).toEqual({ error: 'Unknown status "closed" for an objective. One of: open, done, dropped.' })
  expect(isPlan(fromTodos([]))).toBe(false)
})

test("the engine keeps the plan with the session: said on the bus, stored, back on resume, gone on /new", async () => {
  fake = fakeProvider([
    { chunks: [toolCall(0, "p1", "plan_write", JSON.stringify({ title: "Work", phases: [{ title: "Work", tasks: ["one", "two"] }] }))] },
    { chunks: [toolCall(0, "p2", "plan_update", JSON.stringify({ tasks: [{ id: "t1", status: "done" }] }))] },
    { chunks: [delta({ content: "ok" })] },
  ])
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  f:\n    dialect: openai-chat\n    base_url: ${fake.url}\n    models: { m: {} }\n`, { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), "model: f/m\ntitles: prompt\n")
  const cwd = mkdtempSync(join(tmpdir(), "ph-planstore-"))
  const store = new Store(join(cwd, "sessions.db"))
  const a = createApp({ cwd, store, snapshots: false, asker: { ask: async () => ({ kind: "once" }) } })
  const seen: (Plan | undefined)[] = []
  a.bus.on((e: Event) => e.type === "plan" && seen.push(e.plan))
  await a.engine.prompt("do it")
  expect(seen.map((p) => p?.phases[0]!.tasks.map((t) => t.status))).toEqual([["todo", "todo"], ["done", "todo"]])
  const id = a.engine.sessionId!
  expect(store.meta<Plan>(id, "plan")?.steps).toEqual(["one", "two"])
  // The plan is the session's: a new session starts without one, a resume brings it back.
  a.engine.newSession(store.createSession(cwd, "f/m").id)
  expect(a.engine.plan).toBeUndefined()
  expect(seen.at(-1)).toBeUndefined()
  a.engine.resume(id, [])
  expect(a.engine.plan?.title).toBe("Work")
  a.engine.setPlan(null)
  expect(store.meta(id, "plan")).toBeNull()
  a.engine.resume(id, [])
  expect(a.engine.plan).toBeUndefined()
})
