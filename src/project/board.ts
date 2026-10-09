// The project's own records, in .agent/: a task board (tasks.md) and a decision log
// (decisions.md). Plain markdown on purpose — they belong to the project, are read by people and
// committed with it; LLeMbas CLI only edits them.
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs"
import { assertProjectFile } from "./safe.ts"
import { dirname } from "node:path"
import { join } from "node:path"

export const COLUMNS = ["todo", "doing", "done"] as const
export type Column = (typeof COLUMNS)[number]
export interface Task {
  id: number
  text: string
  column: Column
}

const HEAD: Record<Column, string> = { todo: "Todo", doing: "Doing", done: "Done" }

export function readBoard(dir: string): Task[] {
  const file = join(dir, "tasks.md")
  if (!existsSync(file)) return []
  const out: Task[] = []
  let col: Column = "todo"
  let next = 1
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const h = /^##\s+(todo|doing|done)\s*$/i.exec(line)
    if (h) {
      col = h[1]!.toLowerCase() as Column
      continue
    }
    const m = /^\s*-\s+\[[ xX]\]\s+(.*?)\s*(?:\(#(\d+)\))?\s*$/.exec(line)
    if (m) {
      const id = m[2] ? Number(m[2]) : next
      next = Math.max(next, id + 1)
      out.push({ id, text: m[1]!, column: col })
    }
  }
  return out
}

export function writeBoard(dir: string, tasks: Task[]) {
  mkdirSync(dir, { recursive: true })
  const parts = ["# Tasks", ""]
  for (const c of COLUMNS) {
    parts.push(`## ${HEAD[c]}`, "")
    for (const t of tasks.filter((x) => x.column === c)) parts.push(`- [${c === "done" ? "x" : " "}] ${t.text} (#${t.id})`)
    parts.push("")
  }
  assertProjectFile(join(dir, "tasks.md"), dirname(dir))
  writeFileSync(join(dir, "tasks.md"), parts.join("\n"))
}

export function renderBoard(tasks: Task[]): string {
  if (!tasks.length) return "(the board is empty)"
  return COLUMNS.map((c) => {
    const rows = tasks.filter((t) => t.column === c)
    return `${HEAD[c]} (${rows.length})\n${rows.map((t) => `  #${t.id} ${t.text}`).join("\n") || "  —"}`
  }).join("\n")
}

/** For the system prompt: what is in progress and what is waiting — never the done pile. */
export function boardSummary(dir: string): string | undefined {
  const t = readBoard(dir).filter((x) => x.column !== "done")
  if (!t.length) return undefined
  const lines = [...t.filter((x) => x.column === "doing"), ...t.filter((x) => x.column === "todo")].slice(0, 15).map((x) => `- #${x.id} [${x.column}] ${x.text}`)
  return lines.join("\n")
}

export interface Decision {
  date: string
  title: string
  text: string
}

export function readDecisions(dir: string): Decision[] {
  const file = join(dir, "decisions.md")
  if (!existsSync(file)) return []
  return readFileSync(file, "utf8")
    .split(/^## /m)
    .slice(1)
    .map((block) => {
      const [head = "", ...rest] = block.split("\n")
      const m = /^(\d{4}-\d{2}-\d{2})\s*·\s*(.*)$/.exec(head.trim())
      return { date: m?.[1] ?? "", title: (m?.[2] ?? head).trim(), text: rest.join("\n").trim() }
    })
}

export function addDecision(dir: string, title: string, decision: string, why?: string): Decision {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, "decisions.md")
  const date = new Date().toISOString().slice(0, 10)
  const body = `**Decision:** ${decision.trim()}${why?.trim() ? `\n\n**Why:** ${why.trim()}` : ""}`
  assertProjectFile(file, dirname(dir))
  if (!existsSync(file)) writeFileSync(file, "# Decisions\n\nWhat was decided, when, and why — newest last.\n")
  appendFileSync(file, `\n## ${date} · ${title.trim()}\n\n${body}\n`)
  return { date, title: title.trim(), text: body }
}
