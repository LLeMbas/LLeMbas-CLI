import { z } from "zod"
import { addDecision, COLUMNS, readBoard, readDecisions, renderBoard, writeBoard } from "../project/board.ts"
import { defineTool, ToolError, type ToolContext } from "./tool.ts"
import { described } from "../harness.ts"

function projectDir(ctx: ToolContext): string {
  if (!ctx.projectDir) throw new ToolError("This project has no project directory yet (it is created when the directory is trusted).")
  return ctx.projectDir
}

export const tasksTool = defineTool({
  ...described("tasks"),
  access: "tasks",
  requires: "project",
  schema: z.object({
    action: z.enum(["list", "add", "move", "remove"]),
    text: z.string().optional(),
    id: z.number().int().optional(),
    to: z.enum(COLUMNS).optional(),
  }),
  permission: (a) => ({ permission: "tasks", class: a.action === "list" ? "read" : "interact", patterns: [a.action] }),
  async run(a, ctx) {
    const dir = projectDir(ctx)
    const board = readBoard(dir)
    if (a.action === "list") return { output: renderBoard(board), title: `${board.filter((t) => t.column !== "done").length} open` }
    if (a.action === "add") {
      if (!a.text?.trim()) throw new ToolError("add needs text")
      const id = Math.max(0, ...board.map((t) => t.id)) + 1
      board.push({ id, text: a.text.trim(), column: a.to ?? "todo" })
      writeBoard(dir, board)
      return { output: `Added #${id} to ${a.to ?? "todo"}.\n\n${renderBoard(board)}`, title: `+ #${id} ${a.text.trim().slice(0, 60)}` }
    }
    const t = board.find((x) => x.id === a.id)
    if (!t) throw new ToolError(`There is no task #${a.id}. ${renderBoard(board)}`)
    if (a.action === "remove") {
      writeBoard(dir, board.filter((x) => x.id !== t.id))
      return { output: `Removed #${t.id}.`, title: `− #${t.id}` }
    }
    if (!a.to) throw new ToolError("move needs `to`: todo, doing or done")
    t.column = a.to
    writeBoard(dir, board)
    return { output: `#${t.id} → ${a.to}.`, title: `#${t.id} → ${a.to}` }
  },
})

export const decisionsTool = defineTool({
  ...described("decisions"),
  access: "decisions",
  requires: "project",
  schema: z.object({
    action: z.enum(["list", "add"]),
    title: z.string().optional(),
    decision: z.string().optional(),
    why: z.string().optional(),
  }),
  permission: (a) => ({ permission: "decisions", class: a.action === "list" ? "read" : "interact", patterns: [a.action] }),
  async run(a, ctx) {
    const dir = projectDir(ctx)
    if (a.action === "list") {
      const d = readDecisions(dir)
      return { output: d.map((x) => `${x.date} · ${x.title}\n${x.text}`).join("\n\n") || "(no decisions recorded)", title: `${d.length} decisions` }
    }
    if (!a.title?.trim() || !a.decision?.trim()) throw new ToolError("add needs title and decision")
    const d = addDecision(dir, a.title, a.decision, a.why)
    return { output: `Recorded: ${d.date} · ${d.title}`, title: d.title.slice(0, 60) }
  },
})
