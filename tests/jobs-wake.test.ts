// A background job that ends wakes the session (after LLeMbas's jobs): the exit is heard,
// the note says which job, how it ended and the output not yet read; mid-task the model gets it at
// its next step, and a model that had finished carries on with it rather than stopping.
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../src/app.ts"
import type { AskReply } from "../src/bus/index.ts"
import { paths } from "../src/config/paths.ts"
import { JOB_MARK } from "../src/session/engine.ts"
import { jobNote, onJobExit, startJob, type Job } from "../src/tool/jobs.ts"
import { delta, fakeProvider, toolCall, type Fake } from "./fake-provider.ts"

let fake: Fake | undefined
afterEach(() => fake?.stop())

function app(url: string) {
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  f:\n    dialect: openai-chat\n    base_url: ${url}\n    models: { m: {} }\n`, { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), "model: f/m\n")
  return createApp({ cwd: mkdtempSync(join(tmpdir(), "ph-wake-")), mode: "auto", store: false, asker: { ask: async (): Promise<AskReply> => ({ kind: "once" }) } })
}

test("a job's end is heard, with what it printed that nobody has read", async () => {
  const ended = new Promise<Job>((resolve) => {
    const stop = onJobExit((j) => (stop(), resolve(j)))
  })
  startJob("echo built; exit 3", tmpdir(), process.env)
  const job = await ended
  const note = jobNote(job)
  expect(note).toContain(`Background job ${job.id}`)
  expect(note).toContain("exited with 3")
  expect(note).toContain("built")
  job.read = job.output.length
  expect(jobNote(job)).toContain("printed nothing you had not read")
})

test("mid-task, the note reaches the model at its next step", async () => {
  fake = fakeProvider([
    { chunks: [toolCall(0, "t1", "bash", JSON.stringify({ command: "true", description: "check" }))] },
    { chunks: [delta({ content: "Seen it." })] },
  ])
  const a = app(fake.url)
  let noted = false
  a.bus.on((e) => {
    if (e.type === "tool_start" && !noted) {
      noted = true
      a.engine.note("Background job job7 (bun run build) exited with 0 after 4s.")
    }
  })
  await a.engine.prompt("build it")
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
      a.engine.note("Background job job2 (bun test) exited with 0 after 30s.")
    }
  })
  const reason = await a.engine.prompt("run the tests in the background")
  expect(reason).toBe("stop")
  expect(fake.requests.length).toBe(2)
  expect(a.engine.takeNotes()).toEqual([])
})
