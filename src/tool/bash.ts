import { spawn } from "node:child_process"
import { z } from "zod"
import { getJob, killJob, listJobs, startJob } from "./jobs.ts"
import { absPath, defineTool, showPath, ToolError, truncate } from "./tool.ts"
import { duration } from "../duration.ts"
import { described } from "../harness.ts"

// git run by the model reads a repository's own config, which can name programs to run (an external
// diff, an fsmonitor, a pager) — and "git diff", "git show", "git status" are allowed unasked. These
// override that for every git started here; an embedded bare repository is not discovered either.
const GIT_SAFE: [string, string][] = [
  ["core.fsmonitor", "false"],
  ["diff.external", ""],
  ["core.pager", "cat"],
  ["safe.bareRepository", "explicit"],
]
// Local mode starts the TUI with TMPDIR inside the project, for this program's own files; the
// commands keep the TMPDIR they had (LEMBAS_OUTER_TMPDIR, empty when there was none).
const { LEMBAS_OUTER_TMPDIR: outerTmp, ...startEnv } = process.env
if (outerTmp !== undefined) {
  if (outerTmp) startEnv.TMPDIR = outerTmp
  else delete startEnv.TMPDIR
}
const ENV = {
  ...startEnv,
  // A command can tell it runs under the agent.
  LEMBAS: "1",
  GIT_PAGER: "cat",
  PAGER: "cat",
  GIT_EDITOR: "true",
  EDITOR: "true",
  GIT_CONFIG_COUNT: String(GIT_SAFE.length),
  ...Object.fromEntries(GIT_SAFE.flatMap(([k, v], i) => [[`GIT_CONFIG_KEY_${i}`, k], [`GIT_CONFIG_VALUE_${i}`, v]])),
}

export const bashTool = defineTool({
  ...described("bash"),
  purpose: "description",
  access: "bash",
  schema: z.object({
    command: z.string(),
    description: z.string().optional(),
    cwd: z.string().optional(),
    timeout: z.number().int().positive().max(600_000).optional(),
    background: z.boolean().optional(),
  }),
  permission: (a, ctx) => {
    const cwd = absPath(a.cwd ?? ".", ctx)
    return { permission: "bash", class: "execute", patterns: [a.command], command: a.command, paths: [cwd] }
  },
  async run(a, ctx) {
    const cwd = absPath(a.cwd ?? ".", ctx)
    if (a.background) {
      const job = startJob(a.command, cwd, ENV)
      await Bun.sleep(300)
      const early = job.output
      job.read = early.length
      return {
        output: `Started in the background as ${job.id} (pid ${job.child.pid}).${job.exit !== undefined ? ` It has already exited with ${job.exit}.` : ""}${early ? `\nFirst output:\n${truncate(early, 4000)}` : ""}\nRead more with bash_output, stop it with bash_kill.`,
        title: `${a.description ?? a.command.split("\n")[0]!.slice(0, 80)} · background ${job.id}`,
        meta: { job: job.id },
      }
    }
    const timeout = a.timeout ?? ctx.bashTimeoutMs
    // Own process group, so a timeout or cancel takes the whole tree down.
    const child = spawn("bash", ["-c", `exec 2>&1\n${a.command}`], {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: ENV,
    })
    let out = ""
    child.stdout!.on("data", (d: Buffer) => {
      if (out.length < 2_000_000) out += d.toString()
    })
    let killed = ""
    const kill = (why: string) => {
      killed = why
      try {
        process.kill(-child.pid!, "SIGTERM")
        setTimeout(() => {
          try {
            process.kill(-child.pid!, "SIGKILL")
          } catch {}
        }, 2000)
      } catch {}
    }
    const timer = setTimeout(() => kill(`timed out after ${duration(timeout, true)}`), timeout)
    const onAbort = () => kill("cancelled")
    ctx.signal.addEventListener("abort", onAbort, { once: true })
    const code: number | null = await new Promise((res) => child.on("close", (c) => res(c)))
    clearTimeout(timer)
    ctx.signal.removeEventListener("abort", onAbort)
    const status = killed ? killed : `exit ${code ?? "?"}`
    return {
      output: `${truncate(out.trimEnd()) || "(no output)"}\n\n[${status}]`,
      title: `${a.description ?? a.command.split("\n")[0]!.slice(0, 80)} · ${status}`,
      isError: killed !== "" || code !== 0,
      meta: { exit: code, cwd: showPath(cwd, ctx) },
    }
  },
})

export const bashOutputTool = defineTool({
  ...described("bash_output"),
  purpose: false,
  access: "bash_output",
  schema: z.object({ id: z.string(), wait: z.number().min(0).max(60).optional() }),
  permission: () => ({ permission: "bash_output", class: "read", patterns: ["*"] }),
  async run(a, ctx) {
    const job = getJob(a.id)
    if (!job) throw new ToolError(`No background job ${a.id}.`)
    const until = Date.now() + (a.wait ?? 0) * 1000
    while (Date.now() < until && job.exit === undefined && job.output.length === job.read && !ctx.signal.aborted) await Bun.sleep(200)
    const fresh = job.output.slice(job.read)
    job.read = job.output.length
    const state = job.exit === undefined ? "still running" : `exited with ${job.exit}`
    return { output: `${truncate(fresh.trimEnd()) || "(no new output)"}\n\n[${job.id} ${state}]`, title: `${job.id} · ${state}` }
  },
})

export const bashKillTool = defineTool({
  ...described("bash_kill"),
  purpose: false,
  access: "bash_kill",
  schema: z.object({ id: z.string() }),
  permission: () => ({ permission: "bash_kill", class: "execute", patterns: ["*"] }),
  async run(a) {
    const job = getJob(a.id)
    if (!job) throw new ToolError(`No background job ${a.id}.`)
    if (job.exit !== undefined) return { output: `${job.id} had already exited with ${job.exit}.`, title: `${job.id} · already exited` }
    killJob(job)
    return { output: `Stopped ${job.id} (${job.command.split("\n")[0]}).`, title: `${job.id} · stopped` }
  },
})

export const bashListTool = defineTool({
  ...described("bash_list"),
  purpose: false,
  access: "bash_output",
  schema: z.object({}),
  permission: () => ({ permission: "bash_output", class: "read", patterns: ["*"] }),
  async run() {
    const jobs = listJobs()
    if (!jobs.length) return { output: "No background jobs.", title: "0 jobs" }
    const now = Date.now()
    const lines = jobs.map((j) => {
      const state = j.exit === undefined ? "running" : `exited with ${j.exit}`
      const unread = j.output.length > j.read ? " · new output" : ""
      return `${j.id} · ${state} · ${duration(now - j.started, true)}${unread} · ${j.command.split("\n")[0]!.slice(0, 120)}`
    })
    return { output: lines.join("\n"), title: `${jobs.length} jobs` }
  },
})
