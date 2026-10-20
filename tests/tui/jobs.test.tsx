// Background jobs in the TUI (harness spec 2.0.0, loop.json `jobs`): the status bar's count, the
// /jobs picker — rows that fit the terminal at 80×24 and 120×40, filtering, redrawing on events —
// a command's live output, entering a subagent and messaging it, the quit prompt with jobs running,
// and ctrl+b moving the foreground command to the background. All inside the real Root.
import { afterEach, expect, test } from "bun:test"
import { Bus } from "../../src/bus/index.ts"
import type { App } from "../../src/app.ts"
import type { Job, SubagentHandle } from "../../src/jobs/registry.ts"
import { fitColumns, jobRow } from "../../src/tui/commands.ts"
import { jobsWord } from "../../src/tui/components/status.tsx"
import { delta, toolCall } from "../fake-provider.ts"
import { tui } from "./harness.tsx"

let t: Awaited<ReturnType<typeof tui>> | undefined
afterEach(() => {
  if (!t) return
  // Quietly: a stop's note would wake a session whose fake endpoint is gone.
  t.app.registry.stopAll(t.app.jobsSessionId(), true)
  t.stop()
  t = undefined
})

// Bun's per-test timeout is 5 s here (bunfig's `[test] timeout` is not read by bun 1.4.2): a test
// that renders a few screens and waits for a process needs longer, and says so.
const SLOW = 15_000
/** What the model says when a job's end note wakes the session. */
const noted = () => ({ chunks: [delta({ content: "Noted." })] })

const widest = (frame: string) => Math.max(...frame.split("\n").map((l) => Bun.stringWidth(l)))
const lineWith = (frame: string, text: string) => frame.split("\n").find((l) => l.includes(text)) ?? ""

function command(app: App, command: string, description?: string): Job {
  return app.registry.start({ sessionId: app.jobsSessionId(), command, cwd: process.cwd(), env: process.env, description })
}

/** A subagent job with a stub handle: what the TUI sends to it is recorded, nothing runs. */
function subagent(app: App, description = "find the bug") {
  const bus = new Bus()
  const sent: string[] = []
  const restarted: string[] = []
  const handle: SubagentHandle = { bus, engine: { messages: [] } as never, send: (x) => void sent.push(x), restart: async (x) => void restarted.push(x), cancel: () => {} }
  const job = app.registry.startSubagent({ sessionId: app.jobsSessionId(), agent: "explore", model: "fake/coder", description, handle })
  return { job, bus, sent, restarted }
}

const untilJob = async (job: Job, state: string, ms = 5000) => {
  const end = Date.now() + ms
  while (Date.now() < end && job.state !== state) await Bun.sleep(20)
  return job.state
}

test("a row is exactly as wide as asked, whichever icon set; the description gives", () => {
  const info = { id: "job12", kind: "command" as const, state: "running" as const, description: "a long build of everything that takes a while to finish and then some more words", started: Date.now() - 72_000, unread: 0 }
  for (const icon of ["💻", "$"]) {
    const row = jobRow(info, 70, icon)
    expect(Bun.stringWidth(row)).toBe(70)
    expect(row).toContain("job12 ")
    expect(row).toContain("…")
    expect(row).toContain(" running 1m 12s  ")
  }
  // A subagent row names its agent; a finished one its state; unread output is marked.
  const sub = jobRow({ id: "job3", kind: "subagent", state: "done", agent: "explore", description: "find it", started: 0, ended: 4000, unread: 12 }, 60, "🤖")
  expect(Bun.stringWidth(sub)).toBe(60)
  expect(sub).toContain("explore: find it")
  expect(sub).toMatch(/done {8}4s !$/)
  expect(fitColumns("héllo wörld", 6)).toBe("héllo…")
  expect(fitColumns("short", 10)).toBe("short")
  // The status bar's word.
  expect(jobsWord([])).toBe("")
  expect(jobsWord([{ state: "running", unread: 0 }])).toBe("1 job")
  expect(jobsWord([{ state: "running", unread: 0 }, { state: "running", unread: 5 }])).toBe("2 jobs!")
  expect(jobsWord([{ state: "done", unread: 0, unseen: true }])).toBe("0 jobs!")
  expect(jobsWord([{ state: "done", unread: 0 }])).toBe("")
})

for (const size of [
  { width: 80, height: 24 },
  { width: 120, height: 40 },
]) {
  test(`${size.width}×${size.height}: the status bar counts jobs; /jobs lists them within the terminal; filter; esc; the unseen marker clears`, async () => {
    t = await tui([noted()], size)
    const job = command(t.app, "sleep 30", "a long build of everything that takes a while to finish and then some more words to cut")
    expect(await t.until("1 job ·")).toBe(true)
    await t.input.typeText("/jobs")
    t.input.pressEnter()
    expect(await t.until("enter open · k stop")).toBe(true)
    const f = t.frame()
    expect(widest(f)).toBeLessThanOrEqual(size.width)
    const row = lineWith(f, "job1")
    expect(row).toContain("running")
    expect(row).toContain("…")
    // The row ends inside the box: its right border is the last thing on the line.
    expect(row.trimEnd().endsWith("│")).toBe(true)
    // Type to filter: nothing matches "zzz"; the row is back once that is gone.
    await t.input.typeText("zzz")
    expect(await t.until("nothing matches")).toBe(true)
    for (let i = 0; i < 3; i++) t.input.pressBackspace()
    expect(await t.until("job1")).toBe(true)
    t.input.pressEscape()
    await t.settle()
    expect(t.frame()).not.toContain("enter open · k stop")
    // Stopped: the end is news until the list is looked at.
    t.app.registry.stop(job)
    expect(await untilJob(job, "stopped")).toBe("stopped")
    expect(await t.until("0 jobs! ·")).toBe(true)
    await t.input.typeText("/jobs")
    t.input.pressEnter()
    expect(await t.until("stopped")).toBe(true)
    t.input.pressEscape()
    await t.settle()
    expect(t.frame()).not.toContain("jobs!")
  }, SLOW)
}

test("the picker redraws itself on job events while open, and the cursor stays", async () => {
  t = await tui([])
  command(t.app, "sleep 30", "first")
  command(t.app, "sleep 30", "second")
  await t.input.typeText("/jobs")
  t.input.pressEnter()
  expect(await t.until("enter open")).toBe(true)
  t.input.pressArrow("down")
  await t.settle()
  command(t.app, "sleep 30", "third one")
  expect(await t.until("third one", 2000)).toBe(true)
  // The second row is still the current one: enter opens job2.
  t.input.pressEnter()
  expect(await t.until("job2 · running")).toBe(true)
  t.input.pressEscape()
  await t.settle()
}, SLOW)

test("a command job opens on its live output; k stops it; esc goes back", async () => {
  t = await tui([noted()])
  const job = command(t.app, "echo hello-from-job; sleep 30", "say hello, then wait")
  await t.input.typeText("/jobs job1")
  t.input.pressEnter()
  expect(await t.until("job1 · running")).toBe(true)
  expect(await t.until("hello-from-job")).toBe(true)
  const f = t.frame()
  expect(f).toContain("k stop")
  expect(f).toContain("say hello, then wait · $ echo hello-from-job; sleep 30")
  expect(widest(f)).toBeLessThanOrEqual(100)
  t.input.pressKey("k")
  expect(await untilJob(job, "stopped")).toBe("stopped")
  expect(await t.until("stopped ·")).toBe(true)
  expect(t.frame()).not.toContain("k stop")
  t.input.pressEscape()
  await t.settle()
  expect(t.frame()).not.toContain("esc back")
  // The end note woke the session: the stop is a fact the model is told.
  expect(await t.until("Noted.")).toBe(true)
  expect(t.frame()).toContain("⏎ job1 (echo hello-from-job; sleep 30) stopped (SIGTERM) after")
}, SLOW)

test("entering a subagent: its header and transcript; what is typed goes to it; esc comes back; a finished one is started again", async () => {
  t = await tui([{ chunks: [delta({ content: "Noted the report." })] }, noted()])
  const { job, bus, sent, restarted } = subagent(t.app)
  expect(await t.until("1 job ·")).toBe(true)
  await t.input.typeText("/jobs")
  t.input.pressEnter()
  expect(await t.until("explore: find the bug")).toBe(true)
  t.input.pressEnter()
  expect(await t.until("subagent explore · job1 · running")).toBe(true)
  expect(t.frame()).toContain("type to message")
  bus.emit({ type: "step", n: 1 })
  bus.emit({ type: "text", text: "I am reading calc.py now." })
  expect(await t.until("I am reading calc.py now.")).toBe(true)
  await t.input.typeText("also check the tests")
  t.input.pressEnter()
  expect(await t.until("sent to job1")).toBe(true)
  expect(sent).toEqual(["also check the tests"])
  // Esc leaves the subagent, nothing else: the main model was idle and stays so.
  t.input.pressEscape()
  expect(await t.until("shift+tab mode · /help")).toBe(true)
  expect(t.frame()).not.toContain("subagent explore")
  // It ends: the note wakes the session (a machine turn), and the status bar says so.
  t.app.registry.finishSubagent(job, { reason: "stop", report: "The bug is on line 2." })
  expect(await t.until("Noted the report.")).toBe(true)
  expect(t.frame()).toContain("⏎ job1 (explore: find the bug) finished after")
  // Entered again once finished: typing starts it again with the message, under the same id.
  await t.input.typeText("/jobs job1")
  t.input.pressEnter()
  expect(await t.until("subagent explore · job1 · done")).toBe(true)
  await t.input.typeText("and the other file?")
  t.input.pressEnter()
  expect(await t.until("running again with your message")).toBe(true)
  expect(restarted).toEqual(["and the other file?"])
  expect(job.state).toBe("running")
  expect(t.frame()).toContain("and the other file?")
  t.input.pressEscape()
  await t.settle()
  t.app.registry.finishSubagent(job, { reason: "stop", report: "Nothing more." })
  expect(await t.until("Noted.")).toBe(true)
}, SLOW)

test("an approval from a subagent says which one asked", async () => {
  t = await tui([])
  const reply = t.view.asker.ask({
    tool: "bash",
    args: { command: "rm -r build" },
    request: { permission: "bash", class: "execute", patterns: ["rm -r build"], command: "rm -r build" },
    decision: { action: "ask", reason: "a command", always: [] },
    source: { jobId: "job7", agent: "explore", description: "clean up" },
  })
  expect(await t.until("explore (job7): bash")).toBe(true)
  await t.input.typeText("n")
  expect(await reply).toEqual({ kind: "deny" })
})

test("quitting with a job running asks first: n keeps going, y stops the job and quits", async () => {
  t = await tui([noted()])
  const job = command(t.app, "sleep 30", "server")
  await t.input.typeText("/quit")
  t.input.pressEnter()
  expect(await t.until("1 job running — stop it and quit?")).toBe(true)
  t.input.pressKey("n")
  await t.settle()
  expect(t.quits()).toBe(0)
  expect(t.frame()).not.toContain("stop it and quit")
  expect(job.state).toBe("running")
  // Ctrl+D on the empty box goes the same way (ctrl+c twice too: the smoke test drives that in a PTY).
  t.input.pressKey("d", { ctrl: true })
  expect(await t.until("stop it and quit?")).toBe(true)
  t.input.pressKey("y")
  await t.settle()
  expect(t.quits()).toBe(1)
  expect(await untilJob(job, "stopped")).toBe("stopped")
}, SLOW)

test("ctrl+d on an empty box quits at once when nothing runs", async () => {
  t = await tui([])
  t.input.pressKey("d", { ctrl: true })
  await t.settle()
  expect(t.quits()).toBe(1)
})

test("ctrl+b moves the foreground command to the background: the call returns, the job runs on, the task line follows it", async () => {
  t = await tui([
    { chunks: [toolCall(0, "c1", "bash", '{"command":"echo early; sleep 20; echo late","description":"wait a while"}')] },
    { chunks: [delta({ content: "Moved on." })] },
  ])
  await t.input.typeText("wait")
  t.input.pressEnter()
  expect(await t.until("Allow once")).toBe(true)
  await t.input.typeText("y")
  expect(await t.until("wait a while …")).toBe(true)
  await Bun.sleep(300)
  t.input.pressKey("b", { ctrl: true })
  expect(await t.until("Moved on.")).toBe(true)
  const result = t.fake.requests[1].messages.at(-1).content as string
  expect(result).toContain("early")
  expect(result).toContain("the user moved it to the background after")
  expect(result).toContain("as job1")
  const jobs = t.app.jobs()
  expect(jobs.map((j) => [j.id, j.kind, j.state])).toEqual([["job1", "command", "running"]])
  expect(await t.until("1 job ·")).toBe(true)
  expect(t.frame()).toContain("→ job1 (wait a while) running…")
  // Esc now stops nothing: the command is a job, not the turn's.
  t.input.pressEscape()
  await t.settle()
  expect(jobs[0]!.state).toBe("running")
}, SLOW)

test("ctrl+b with nothing in the foreground says so", async () => {
  t = await tui([])
  t.input.pressKey("b", { ctrl: true })
  expect(await t.until("no command is running in the foreground")).toBe(true)
})
