// A background job that ends wakes the session that owns it (harness spec loop.json `jobs`): mid-task
// the model gets the note at its next step, under its mark; idle, the note starts a turn of its own,
// marked `machine`; a model that had finished carries on with a note that arrived meanwhile.
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../src/app.ts"
import type { AskReply, Event } from "../src/bus/index.ts"
import { paths } from "../src/config/paths.ts"
import { JOB_MARK } from "../src/session/engine.ts"
import { MARKS } from "../src/jobs/note.ts"
import { delta, fakeProvider, toolCall, type Fake } from "./fake-provider.ts"

let fake: Fake | undefined
afterEach(() => fake?.stop())

function app(url: string) {
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  f:\n    dialect: openai-chat\n    base_url: ${url}\n    models: { m: {} }\n`, { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), "model: f/m\n")
  return createApp({ cwd: mkdtempSync(join(tmpdir(), "ph-wake-")), mode: "auto", store: false, asker: { ask: async (): Promise<AskReply> => ({ kind: "once" }) } })
}

test("the command mark is the spec's", () => {
  expect(JOB_MARK).toBe(MARKS.command)
  expect(JOB_MARK).toBe("[A background job you started has finished:]")
})

test("mid-task, the note reaches the model at its next step, with its mark", async () => {
  fake = fakeProvider([
    { chunks: [toolCall(0, "t1", "bash", JSON.stringify({ command: "true", description: "check" }))] },
    { chunks: [delta({ content: "Seen it." })] },
  ])
  const a = app(fake.url)
  let noted = false
  a.bus.on((e) => {
    if (e.type === "tool_start" && !noted) {
      noted = true
      a.wake(`${MARKS.command}\njob7 (bun run build) exited with 0 after 4s.`, "⏎ job7")
    }
  })
  await a.turns.prompt("build it")
  const second = fake.requests[1].messages as { role: string; content: string }[]
  const told = second.find((m) => m.role === "user" && String(m.content).startsWith(JOB_MARK))
  expect(told?.content).toContain("job7")
})

test("a model that had finished carries on with a job that ended meanwhile", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "Started it; waiting." })] }, { chunks: [delta({ content: "It passed." })] }])
  const a = app(fake.url)
  let noted = false
  a.bus.on((e) => {
    if (e.type === "text" && !noted) {
      noted = true
      a.wake(`${MARKS.command}\njob2 (bun test) exited with 0 after 30s.`, "⏎ job2")
    }
  })
  const reason = await a.turns.prompt("run the tests in the background")
  expect(reason).toBe("stop")
  expect(fake.requests.length).toBe(2)
  expect(a.engine.takeNotes()).toEqual([])
})

test("idle, a note is a turn of its own: marked machine on the prompt event and the stored message", async () => {
  fake = fakeProvider([{ chunks: [delta({ content: "Noted." })] }])
  const a = app(fake.url)
  const events: Event[] = []
  a.bus.on((e) => events.push(e))
  a.wake(`${MARKS.command}\njob1 (make) exited with 0 after 2s.`, "⏎ job1 (make) exited with 0 after 2s.")
  while (a.turns.current) await Bun.sleep(20)
  const prompt = events.find((e) => e.type === "prompt")
  expect(prompt).toMatchObject({ type: "prompt", text: "⏎ job1 (make) exited with 0 after 2s.", machine: true })
  expect(a.engine.messages[0]).toMatchObject({ role: "user", machine: true })
  expect(fake.requests[0].messages.at(-1).content).toStartWith(JOB_MARK)
})

test("a real job: ended during the turn it goes in at the next step; ended after it, it starts a turn of its own", async () => {
  fake = fakeProvider([
    // Ends at once: the note is in the turn's next step.
    { chunks: [toolCall(0, "t1", "bash", JSON.stringify({ command: "echo built; exit 3", background: true, description: "build" }))] },
    { chunks: [delta({ content: "Seen the quick one." })] },
    // Ends after the turn: a machine turn of its own.
    { chunks: [toolCall(0, "t2", "bash", JSON.stringify({ command: "sleep 0.4; echo late", background: true, description: "later" }))] },
    { chunks: [delta({ content: "Running in the background." })] },
    { chunks: [delta({ content: "It printed late." })] },
  ])
  const a = app(fake.url)
  const events: Event[] = []
  a.bus.on((e) => events.push(e))
  await a.turns.prompt("build in the background")
  const quick = fake.requests[1].messages.filter((m: any) => m.role === "user").at(-1).content as string
  expect(quick).toStartWith(JOB_MARK)
  expect(quick).toContain("job1 (echo built; exit 3) exited with 3")
  expect(quick).toContain("built")
  await a.turns.prompt("and a slow one")
  expect(fake.requests.length).toBe(4)
  const until = Date.now() + 5000
  while (Date.now() < until && (fake.requests.length < 5 || a.turns.current)) await Bun.sleep(20)
  const note = fake.requests[4].messages.at(-1).content as string
  expect(note).toStartWith(JOB_MARK)
  expect(note).toContain("job2 (sleep 0.4; echo late) exited with 0")
  expect(note).toContain("late")
  // The prompt, the quick note, the second prompt, the late note.
  expect(fake.requests[4].messages.filter((m: any) => m.role === "user").length).toBe(4)
  expect(events.filter((e) => e.type === "prompt" && e.machine)).toHaveLength(1)
  expect(events.filter((e) => e.type === "job_note").map((e) => e.type === "job_note" && e.jobId)).toEqual(["job1", "job2"])
  expect(events.filter((e) => e.type === "job" && e.state !== "update").map((e) => e.type === "job" && `${e.job.id} ${e.state}`)).toEqual(["job1 start", "job1 end", "job2 start", "job2 end"])
  expect(a.jobs().map((j) => [j.id, j.state, j.exit])).toEqual([["job1", "error", 3], ["job2", "done", 0]])
})
