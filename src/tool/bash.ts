import { spawn } from "node:child_process"
import { z } from "zod"
import { absPath, defineTool, showPath, ToolError, truncate } from "./tool.ts"
import { duration } from "../duration.ts"
import { described } from "../harness.ts"
import { commandLine } from "../jobs/note.ts"

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
export const ENV = {
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

/** How long a background start waits for a first line before returning. */
const FIRST_OUTPUT_MS = 100
/** Output a foreground command keeps; past it the oldest goes, as a job's buffer does. */
const MAX_BUFFER = 2_000_000

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
    const line = a.description ?? commandLine(a.command, 80)
    if (a.background) {
      if (!ctx.jobs) throw new ToolError("Background commands are not available here.")
      const { sessionId, job: owner } = ctx.jobs.owner()
      let job
      try {
        job = ctx.jobs.registry.start({ sessionId, command: a.command, cwd, env: ENV, ownerCallId: ctx.callId, ownerJobId: owner?.id, description: a.description })
      } catch (e) {
        throw new ToolError((e as Error).message)
      }
      // Whatever it says in its first moment goes with the answer — a port in use, a missing
      // program — without waiting for a command that starts quietly.
      const until = Date.now() + FIRST_OUTPUT_MS
      while (Date.now() < until && job.state === "running" && !job.output) await Bun.sleep(10)
      const early = ctx.jobs.registry.takeUnread(job)
      const ended = job.state !== "running" ? ` It has already ${job.exit === null ? "stopped (SIGTERM)" : `exited with ${job.exit}`}.` : ""
      return {
        output: `Started in the background as ${job.id}.${ended}${early ? `\nFirst output:\n${truncate(early, 4000)}` : ""}\nRead more with job_output, stop it with job_stop.`,
        title: `${line} · background ${job.id}`,
        meta: { job: job.id },
      }
    }
    const timeout = a.timeout ?? ctx.bashTimeoutMs
    const started = Date.now()
    // Own process group, so a cancel takes the whole tree down.
    const child = spawn("bash", ["-c", `exec 2>&1\n${a.command}`], {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: ENV,
    })
    let out = ""
    const onData = (d: Buffer) => {
      out += d.toString()
      if (out.length > MAX_BUFFER) out = out.slice(out.length - MAX_BUFFER)
    }
    child.stdout!.on("data", onData)
    let killed = ""
    const kill = (why: string) => {
      killed = why
      try {
        process.kill(-child.pid!, "SIGTERM")
        setTimeout(() => {
          try {
            process.kill(-child.pid!, "SIGKILL")
          } catch {}
        }, 2000).unref()
      } catch {}
    }
    // At the timeout the command is not killed: it goes on as a background job, and the call
    // returns what it had printed with the job id (the timeline). Only when there is a session to
    // own the job; the TUI's own `!` commands (bashTimeline: false) are killed as before.
    const timeline = ctx.bashTimeline !== false && ctx.jobs !== undefined
    const onAbort = () => kill("cancelled")
    ctx.signal.addEventListener("abort", onAbort, { once: true })
    // The person asked for it in the background now (ctrl+b): the same hand-over, before the timeout.
    let onBackground: (() => void) | undefined
    const outcome = await new Promise<{ kind: "exit"; code: number | null } | { kind: "timeout"; why: "timeout" | "user" }>((res) => {
      let exited = false
      let settled = false
      const settle = (v: { kind: "exit"; code: number | null } | { kind: "timeout"; why: "timeout" | "user" }) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        res(v)
      }
      if (timeline && ctx.backgroundNow) {
        onBackground = () => settle({ kind: "timeout", why: "user" })
        ctx.backgroundNow.addEventListener("abort", onBackground, { once: true })
      }
      // `close` means every pipe is drained; after `exit` a grandchild may hold them open for ever,
      // so a short drain is all it gets.
      child.on("close", (code) => exited && settle({ kind: "exit", code: child.signalCode ? null : code }))
      child.on("exit", (code, signal) => {
        exited = true
        setTimeout(() => settle({ kind: "exit", code: signal ? null : code }), 300).unref()
      })
      child.on("error", () => settle({ kind: "exit", code: null }))
      const timer = setTimeout(() => {
        if (timeline) settle({ kind: "timeout", why: "timeout" })
        else kill(`timed out after ${duration(timeout, true)}`)
      }, timeout)
    })
    // Whatever happens to the parent's turn from here is not this process's business: a cancel
    // after the hand-over must not kill a job the model was told about.
    ctx.signal.removeEventListener("abort", onAbort)
    if (onBackground) ctx.backgroundNow!.removeEventListener("abort", onBackground)
    if (outcome.kind === "timeout") {
      // From here the registry follows the process; this call stops listening.
      child.stdout!.off("data", onData)
      const { sessionId, job: owner } = ctx.jobs!.owner()
      const job = ctx.jobs!.registry.adopt({ sessionId, command: a.command, cwd, child, output: out, read: out.length, started, ownerCallId: ctx.callId, ownerJobId: owner?.id, description: a.description })
      const status =
        outcome.why === "user"
          ? `the user moved it to the background after ${duration(Date.now() - started, true)}, as ${job.id} — job_output to read on`
          : `still running after ${duration(timeout, true)}; moved to the background as ${job.id} — job_output to read on`
      return {
        output: `${truncate(out.trimEnd()) || "(no output yet)"}\n\n[${status}]`,
        title: `${line} · background ${job.id}`,
        isError: false,
        meta: { job: job.id, cwd: showPath(cwd, ctx) },
      }
    }
    const code = outcome.code
    const status = killed ? killed : code === null ? "stopped (SIGTERM)" : `exit ${code}`
    return {
      output: `${truncate(out.trimEnd()) || "(no output)"}\n\n[${status}]`,
      title: `${line} · ${status}`,
      isError: killed !== "" || code !== 0,
      meta: { exit: code, cwd: showPath(cwd, ctx) },
    }
  },
})
