// The job registry (harness spec loop.json `jobs`, src/jobs/registry.ts): every lookup is the
// owner's; ids run per session and continue from the store; a job is persisted, and one the process
// died under is lost; a note for a session nobody holds waits for its resume; a foreground command at
// its timeout becomes a job and the call returns; the caps hold; a signal's end never reads "null".
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../src/app.ts"
import { Bus, type AskReply, type Event } from "../src/bus/index.ts"
import { paths } from "../src/config/paths.ts"
import { JobRegistry } from "../src/jobs/registry.ts"
import { jobNote, MARKS } from "../src/jobs/note.ts"
import { Store } from "../src/session/store.ts"
import { bashTool, ENV } from "../src/tool/bash.ts"
import { jobListTool, jobOutputTool, jobStopTool, stateWords } from "../src/tool/job_tools.ts"
import type { ToolContext } from "../src/tool/tool.ts"
import { delta, fakeProvider, toolCall, type Fake } from "./fake-provider.ts"

let fake: Fake | undefined
afterEach(() => fake?.stop())

const dir = () => mkdtempSync(join(tmpdir(), "ph-jobs-"))
const ctx = (registry: JobRegistry, sessionId: string): ToolContext => {
  const root = dir()
  return { root, cwd: root, signal: new AbortController().signal, readFiles: new Set(), fileStamps: new Map(), bashTimeoutMs: 5000, jobs: { registry, owner: () => ({ sessionId }) } }
}
const ended = async (registry: JobRegistry, sid: string, id: string) => {
  const until = Date.now() + 5000
  while (Date.now() < until && registry.get(sid, id)?.state === "running") await Bun.sleep(20)
  return registry.get(sid, id)!
}

describe("the registry", () => {
  test("every lookup is the owner's: one session never sees another's jobs", async () => {
    const r = new JobRegistry()
    const a = r.start({ sessionId: "s1", command: "echo a", cwd: tmpdir(), env: ENV })
    expect(a.id).toBe("job1")
    expect(r.list("s2")).toEqual([])
    expect(r.get("s2", "job1")).toBeUndefined()
    expect(r.start({ sessionId: "s2", command: "echo b", cwd: tmpdir(), env: ENV }).id).toBe("job1")
    expect(r.list("s1").map((j) => j.id)).toEqual(["job1"])
    await expect(jobOutputTool.run({ id: "job1" }, ctx(r, "s3"))).rejects.toThrow("No background job job1")
    await ended(r, "s1", "job1")
    await ended(r, "s2", "job1")
  })

  test("ids continue from the store; a job running when the process died is lost, with its tail", async () => {
    const store = new Store(join(dir(), "s.db"))
    const sid = store.createSession("/p", "f/m").id
    const first = new JobRegistry()
    first.attach({ sessionId: () => sid, bus: new Bus(), wake: () => {}, store })
    const done = first.start({ sessionId: sid, command: "echo finished", cwd: tmpdir(), env: ENV })
    const long = first.start({ sessionId: sid, command: "echo partial; sleep 30", cwd: tmpdir(), env: ENV })
    await ended(first, sid, done.id)
    while (!long.output) await Bun.sleep(20)
    await Bun.sleep(50)
    // Another process, the same store.
    const second = new JobRegistry()
    second.attach({ sessionId: () => sid, bus: new Bus(), wake: () => {}, store })
    const jobs = second.list(sid)
    expect(jobs.map((j) => [j.id, j.state])).toEqual([
      ["job1", "done"],
      ["job2", "lost"],
    ])
    expect(jobs[1]!.output).toContain("partial")
    expect(second.nextId(sid)).toBe("job3")
    expect(store.jobs(sid).map((j) => j.state)).toEqual(["done", "lost"])
    expect(stateWords(jobs[1]!)).toContain("lost")
    first.stop(long)
    await ended(first, sid, long.id)
  })

  test("the cap on running commands holds per session", async () => {
    const r = new JobRegistry()
    r.attach({ sessionId: () => "s1", bus: new Bus(), wake: () => {}, runningMax: () => 1 })
    const c = ctx(r, "s1")
    const one = await bashTool.run({ command: "sleep 30", background: true }, c)
    await expect(bashTool.run({ command: "sleep 30", background: true }, c)).rejects.toThrow("already has 1 background command running (limits.jobs: 1)")
    // Another session has its own cap.
    const other = r.start({ sessionId: "s2", command: "sleep 30", cwd: tmpdir(), env: ENV })
    r.stopAll("s1")
    r.stop(other)
    await ended(r, "s1", /as (job\d+)/.exec(one.output)![1]!)
    await ended(r, "s2", other.id)
    expect(r.running("s1")).toEqual([])
  })

  test("a signal's end reads stopped (SIGTERM) in the list, the output, the stop and the note — never null", async () => {
    const r = new JobRegistry()
    const c = ctx(r, "s1")
    const started = await bashTool.run({ command: "sleep 30", background: true }, c)
    const id = /as (job\d+)/.exec(started.output)![1]!
    expect((await jobStopTool.run({ id }, c)).output).toBe(`Stopped ${id} (sleep 30).`)
    const job = await ended(r, "s1", id)
    expect(job.state).toBe("stopped")
    expect(job.exit).toBeNull()
    for (const text of [(await jobListTool.run({}, c)).output, (await jobOutputTool.run({ id }, c)).output, (await jobStopTool.run({ id }, c)).output, job.note!]) {
      expect(text).toContain("stopped (SIGTERM)")
      expect(text).not.toContain("null")
    }
    expect(jobNote({ kind: "command", id: "job1", command: "x", exit: null, seconds: 1, unread: "" }).text).toContain("stopped (SIGTERM) after 1s")
  })

  test("a foreground command at its timeout becomes a job: the call returns what it had, and a later cancel does not touch it", async () => {
    const r = new JobRegistry()
    const events: Event[] = []
    const bus = new Bus()
    bus.on((e) => events.push(e))
    r.attach({ sessionId: () => "s1", bus, wake: () => {} })
    const abort = new AbortController()
    const c = { ...ctx(r, "s1"), signal: abort.signal, callId: "c9" }
    const t0 = Date.now()
    const res = await bashTool.run({ command: "echo early; sleep 1; echo late; sleep 1", timeout: 300 }, c)
    expect(Date.now() - t0).toBeLessThan(900)
    expect(res.isError).toBe(false)
    expect(res.output).toContain("early")
    expect(res.output).toContain("[still running after 0s; moved to the background as job1 — job_output to read on]")
    expect(res.meta).toMatchObject({ job: "job1" })
    const job = r.get("s1", "job1")!
    expect(job.state).toBe("running")
    expect(job.ownerCallId).toBe("c9")
    expect(job.read).toBe(job.output.length)
    // Esc on the turn after the hand-over: the job was the model's, and goes on.
    abort.abort()
    const later = await jobOutputTool.run({ id: "job1", wait: 5 }, { ...c, signal: new AbortController().signal })
    expect(later.output).toContain("late")
    await ended(r, "s1", "job1")
    expect(r.get("s1", "job1")!.exit).toBe(0)
    expect(events.filter((e) => e.type === "job").map((e) => e.type === "job" && e.state)).toContain("start")
  })

  test("the TUI's own commands (bashTimeline false) are still killed at their timeout", async () => {
    const r = new JobRegistry()
    const c = { ...ctx(r, "s1"), bashTimeline: false }
    const res = await bashTool.run({ command: "sleep 5", timeout: 200 }, c)
    expect(res.output).toContain("timed out after 0s")
    expect(res.isError).toBe(true)
    expect(r.list("s1")).toEqual([])
  })

  test("finished jobs beyond the cap are forgotten, oldest first; the store follows", async () => {
    const store = new Store(join(dir(), "s.db"))
    const sid = store.createSession("/p", "f/m").id
    const r = new JobRegistry()
    r.limits.finishedKept = 2
    r.attach({ sessionId: () => sid, bus: new Bus(), wake: () => {}, store })
    for (let i = 0; i < 4; i++) await ended(r, sid, r.start({ sessionId: sid, command: `echo ${i}`, cwd: tmpdir(), env: ENV }).id)
    expect(r.list(sid).map((j) => j.id)).toEqual(["job3", "job4"])
    expect(store.jobs(sid).map((j) => j.id)).toEqual(["job3", "job4"])
  })
})

describe("in an app", () => {
  function app(script: Parameters<typeof fakeProvider>[0], store?: Store) {
    fake = fakeProvider(script)
    mkdirSync(paths.config, { recursive: true })
    writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  f:\n    type: webui\n    url: ${fake.url}\n    models: { f/m: {} }\n`, { mode: 0o600 })
    writeFileSync(join(paths.config, "config.yaml"), "model: f/m\ntitles: prompt\n")
    return createApp({ cwd: dir(), mode: "auto", store: store ?? false, snapshots: false, asker: { ask: async (): Promise<AskReply> => ({ kind: "once" }) } })
  }

  test("a job of a session nobody holds keeps its note until the session is resumed", async () => {
    const store = new Store(join(dir(), "s.db"))
    const a = app(
      [
        // It ends once the session is no longer open (the file below), however slow the turn was.
        { chunks: [toolCall(0, "t1", "bash", JSON.stringify({ command: "until [ -e go ]; do sleep 0.05; done; echo late", background: true, description: "later" }))] },
        { chunks: [delta({ content: "Running." })] },
        { chunks: [delta({ content: "Back, and it finished." })] },
      ],
      store,
    )
    const first = a.engine.sessionId!
    await a.turns.prompt("start it")
    a.newSession()
    writeFileSync(join(a.project.root, "go"), "")
    const job = await ended(a.registry, first, "job1")
    expect(job.note).toContain("late")
    expect(a.registry.get(first, "job1")!.note).toStartWith(MARKS.command)
    expect(store.jobs(first)[0]!.json).toContain("late")
    expect(fake!.requests.length).toBe(2)
    // Resumed: the note is a turn of its own on that session.
    a.resume(first)
    const until = Date.now() + 5000
    while (Date.now() < until && (fake!.requests.length < 3 || a.turns.current)) await Bun.sleep(20)
    expect(fake!.requests[2].messages.at(-1).content).toStartWith(MARKS.command)
    expect(a.registry.get(first, "job1")!.note).toBeUndefined()
    expect(store.messages(first).at(-2)).toMatchObject({ role: "user", machine: true })
  })

  test("the job tools see the open session's jobs, and /new starts a fresh sequence; the old session's run on", async () => {
    const store = new Store(join(dir(), "s.db"))
    const a = app(
      [
        { chunks: [toolCall(0, "t1", "bash", JSON.stringify({ command: "sleep 30", background: true, description: "server" }))] },
        { chunks: [delta({ content: "Running." })] },
        { chunks: [toolCall(0, "t2", "job_list", "{}")] },
        { chunks: [delta({ content: "Nothing here." })] },
      ],
      store,
    )
    const first = a.engine.sessionId!
    await a.turns.prompt("start it")
    expect(a.jobs().map((j) => j.id)).toEqual(["job1"])
    a.newSession()
    expect(a.jobs()).toEqual([])
    await a.turns.prompt("list")
    expect(fake!.requests[3].messages.at(-1).content).toBe("[#0001]\nNo background jobs.")
    expect(a.registry.running(first)).toHaveLength(1)
    // Deleting a session stops its jobs.
    expect(a.registry.stopAll(first)).toBe(1)
    await ended(a.registry, first, "job1")
    expect(a.registry.running(first)).toEqual([])
  })

  test("limits.jobs and limits.subagent_steps are settings with the spec's defaults", async () => {
    const a = app([])
    expect(a.settings.get("limits.jobs").def).toMatchObject({ key: "limits.jobs", fallback: "8" })
    expect(a.settings.get("limits.subagent_steps").def).toMatchObject({ key: "limits.subagent_steps", fallback: "50" })
    expect(a.registry.runningMax(a.jobsSessionId())).toBe(8)
    a.settings.set("limits.jobs", 2)
    expect(a.registry.runningMax(a.jobsSessionId())).toBe(2)
  })
})
