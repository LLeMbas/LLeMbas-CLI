// A working todo list for multi-step tasks. The whole list is sent each time (OpenCode's
// todowrite): simpler for small models than Hermes' merge-by-id, and nothing can drift.
import { z } from "zod"
import { defineTool } from "./tool.ts"
import { described } from "../harness.ts"

export const TODO_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const
export type Todo = { content: string; status: (typeof TODO_STATUSES)[number] }

const MARK: Record<Todo["status"], string> = { pending: "[ ]", in_progress: "[>]", completed: "[x]", cancelled: "[~]" }

export function renderTodos(items: Todo[]): string {
  return items.map((t) => `${MARK[t.status]} ${t.content}`).join("\n") || "(empty)"
}

export const todoTool = defineTool({
  ...described("todo"),
  purpose: false,
  access: "todo",
  schema: z.object({
    todos: z
      .array(
        z.preprocess(
          (t) => (typeof t === "string" ? { content: t, status: "pending" } : t),
          z.object({ content: z.string().min(1), status: z.enum(TODO_STATUSES).default("pending") }),
        ),
      )
      .max(30),
  }),
  permission: () => ({ permission: "todo", class: "interact", patterns: ["*"] }),
  async run(a, ctx) {
    const items = a.todos as Todo[]
    if (ctx.todos) {
      ctx.todos.items = items
      ctx.todos.changed?.(items)
    }
    const done = items.filter((t) => t.status === "completed").length
    return { output: renderTodos(items), title: `${done}/${items.length} done` }
  },
})
