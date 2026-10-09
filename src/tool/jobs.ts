// Background commands started by `bash` with background: true. Each runs in its own process group;
// all of them are killed when LLeMbas CLI exits, however it exits.
import { spawn, type ChildProcess } from "node:child_process"

export interface Job {
  id: string
  command: string
  child: ChildProcess
  output: string
  /** How much of `output` the model has already been given. */
  read: number
  exit?: number | null
  started: number
}

const MAX_BUFFER = 2_000_000
const exitListeners = new Set<(job: Job) => void>()

/** Be told when a background job ends — how a session is woken by one (after LLeMbas's
 *  jobs). Returns the way to stop listening. */
export function onJobExit(fn: (job: Job) => void): () => void {
  exitListeners.add(fn)
  return () => exitListeners.delete(fn)
}

/** What the model is told when a job it started ends: which, how, and the output it has not read. */
export function jobNote(job: Job, maxChars = 4000): string {
  const unread = job.output.slice(job.read)
  const tail = unread.length > maxChars ? `…${unread.slice(-maxChars)}` : unread
  const how = job.exit === null ? "was killed" : `exited with ${job.exit}`
  const secs = Math.round((Date.now() - job.started) / 1000)
  return `Background job ${job.id} (${job.command.split("\n")[0]!.slice(0, 120)}) ${how} after ${secs}s.${tail.trim() ? `\nOutput you had not read:\n${tail}` : " It printed nothing you had not read."}`
}
const jobs = new Map<string, Job>()
let seq = 0

export function startJob(command: string, cwd: string, env: Record<string, string | undefined>): Job {
  const child = spawn("bash", ["-c", `exec 2>&1\n${command}`], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], env })
  const job: Job = { id: `job${++seq}`, command, child, output: "", read: 0, started: Date.now() }
  child.stdout!.on("data", (d: Buffer) => {
    job.output += d.toString()
    // Keep the tail when a long-running job talks a lot; the model only ever reads what is new.
    if (job.output.length > MAX_BUFFER) {
      const cut = job.output.length - MAX_BUFFER
      job.output = job.output.slice(cut)
      job.read = Math.max(0, job.read - cut)
    }
  })
  child.on("close", (code) => {
    job.exit = code
    for (const fn of exitListeners) {
      try {
        fn(job)
      } catch {}
    }
  })
  jobs.set(job.id, job)
  // Finished jobs beyond the last 50 are forgotten (each keeps up to MAX_BUFFER of output).
  const done = [...jobs.values()].filter((j) => j.exit !== undefined)
  for (const j of done.slice(0, Math.max(0, done.length - 50))) jobs.delete(j.id)
  return job
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id)
}

export function killJob(job: Job) {
  try {
    process.kill(-job.child.pid!, "SIGTERM")
    setTimeout(() => {
      try {
        process.kill(-job.child.pid!, "SIGKILL")
      } catch {}
    }, 2000).unref()
  } catch {}
}

export function listJobs(): Job[] {
  return [...jobs.values()]
}

function killAll() {
  for (const j of jobs.values()) if (j.exit === undefined) killJob(j)
}
process.once("exit", killAll)
