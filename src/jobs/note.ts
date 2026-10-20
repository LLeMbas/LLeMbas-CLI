// What a session is told about its background work (harness spec loop.json `jobs.marks`,
// conformance/jobs.json): a finished command, a finished subagent, a message from a subagent, or
// one to a subagent. Every note begins with its mark, said rather than hidden — Hermes found that
// a model refuses an unmarked mid-turn message as an injection. Pure: the registry composes the
// case from a job's record and hands the text on; LLeMbas's services/jobs.py says the same words.
import { LOOP } from "../harness.ts"
import { duration } from "../duration.ts"

export const MARKS = LOOP.jobs.marks

export type NoteCase =
  | { kind: "command"; id: string; command: string; exit: number | null; seconds: number; unread: string }
  | {
      kind: "subagent"
      id: string
      agent: string
      description: string
      report: string
      steps: number
      tools: number
      reason: string
      error?: string
      seconds: number
      worktree?: string
    }
  | { kind: "message"; id: string; agent: string; description: string; text: string }
  | { kind: "to_subagent"; text: string }

/** A command's first line, as the notes and lists name it. */
export function commandLine(command: string, max = 120): string {
  return command.split("\n")[0]!.slice(0, max)
}

/** How a finished command ended, in words: the exit code, or the signal that stopped it. */
export function exitWords(exit: number | null | undefined): string {
  return exit === null ? "stopped (SIGTERM)" : `exited with ${exit ?? "?"}`
}

const ENDED: Record<string, string> = {
  stop: "finished",
  stopped: "was stopped",
  steps: "stopped at its step limit",
  budget: "stopped at its budget",
  error: "failed",
}

/** The tail line under a subagent's report: steps, tool calls, and how it ended when not of its
 *  own accord. The task tool's result carries the same line. */
export function subagentTail(agent: string, steps: number, tools: number, reason: string, error?: string): string {
  const ended = reason === "stop" ? "" : reason === "error" ? ` · ended: error${error ? ` — ${error}` : ""}` : ` · ended: ${reason}`
  return `[${agent} subagent · ${steps} step${steps === 1 ? "" : "s"} · ${tools} tool call${tools === 1 ? "" : "s"}${ended}]`
}

export function jobNote(c: NoteCase): { text: string } {
  switch (c.kind) {
    case "command": {
      const how = `${c.id} (${commandLine(c.command)}) ${exitWords(c.exit)} after ${duration(c.seconds * 1000, true)}.`
      const unread = c.unread.trim() ? `\nOutput you had not read:\n${c.unread.replace(/\n$/, "")}` : " It printed nothing you had not read."
      return { text: `${MARKS.command}\n${how}${unread}` }
    }
    case "subagent": {
      const head = `${c.id} (${c.agent}: ${c.description}) ${ENDED[c.reason] ?? `ended: ${c.reason}`} after ${duration(c.seconds * 1000, true)}.`
      const report = c.report.trim() || "(the subagent returned no report)"
      const tail = subagentTail(c.agent, c.steps, c.tools, c.reason, c.error)
      return { text: `${MARKS.subagent}\n${head}\n${report}\n\n${tail}${c.worktree ? `\n[worktree] ${c.worktree}` : ""}` }
    }
    case "message":
      return { text: `${MARKS.message}\n${c.id} (${c.agent}: ${c.description}):\n${c.text}` }
    case "to_subagent":
      return { text: `${MARKS.to_subagent}\n${c.text}` }
  }
}

/** A note's mark and what follows it, for a front end that shows the message without the mark;
 *  `mark` undefined when the text begins with none. */
export function stripMark(text: string): { mark?: string; body: string } {
  for (const mark of Object.values(MARKS)) if (text.startsWith(mark)) return { mark, body: text.slice(mark.length).replace(/^\n/, "") }
  return { body: text }
}

/** How a machine turn is shown in a transcript: `⏎` and the note's first line after its mark. */
export function shownLine(text: string): string {
  const { body } = stripMark(text)
  return `⏎ ${body.split("\n").find((l) => l.trim()) ?? ""}`.trimEnd()
}
