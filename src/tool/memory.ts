// The memory tool, after Hermes Agent's (tools/memory_tool.py, MIT, © Nous Research): one tool,
// a single change or a batch applied together, checked against the size limit as a whole.
import { z } from "zod"
import { MemoryStore, type Op } from "../memory/store.ts"
import { defineTool, ToolError } from "./tool.ts"
import { described } from "../harness.ts"
import { CLI_VARS } from "./spec-vars.ts"

const OpSchema = z.object({
  action: z.enum(["add", "replace", "remove"]),
  content: z.string().optional(),
  new_text: z.string().optional(),
  old_text: z.string().optional(),
})

export const memoryTool = defineTool({
  ...described("memory", CLI_VARS.memory),
  access: "memory",
  schema: z.object({
    target: z.enum(["memory", "user", "project"]),
    action: z.enum(["add", "replace", "remove"]).optional(),
    content: z.string().optional(),
    new_text: z.string().optional(),
    old_text: z.string().optional(),
    operations: z.array(OpSchema).optional(),
  }),
  permission: (a) => ({ permission: "memory", class: "interact", patterns: [a.target] }),
  async run(a, ctx) {
    if (a.target === "project" && !ctx.projectMemory) throw new ToolError("This project has no project memory: it is not trusted, or has no .agent directory. Use 'memory' for facts that hold everywhere.")
    const store = a.target === "project" ? ctx.projectMemory! : (ctx.memory ?? new MemoryStore())
    const ops: Op[] = a.operations?.length ? a.operations : a.action ? [{ action: a.action, content: a.content, new_text: a.new_text, old_text: a.old_text }] : []
    if (!ops.length) throw new ToolError("Nothing to do: give action (with content and/or old_text), or operations.")
    const r = store.apply(a.target === "project" ? "memory" : a.target, ops)
    const label = a.target === "user" ? "user profile" : a.target === "project" ? "project memory" : "memory"
    if (!r.ok) {
      const list = r.entries ? `\n\nCurrent entries (${r.usage}):\n${r.entries.map((e, i) => `${i + 1}. ${e}`).join("\n") || "(none)"}` : `\n\n${label}: ${r.usage}`
      return { output: r.message + list, title: `${label}: refused`, isError: true }
    }
    return { output: `${r.message} ${label}: ${r.usage}. Saved — this update is complete; do not repeat it.`, title: `${label} ${ops.map((o) => (o.action === "add" ? "+" : o.action === "remove" ? "−" : "~")).join("")} · ${r.usage.split(" — ")[0]}` }
  },
})
