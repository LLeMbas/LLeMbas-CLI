// recall (harness spec 3.0.0, context.md): a stored result of this session shown again, in full or
// from a line on. The engine answers it from the session's results (session/results.ts); the tool
// only carries the call there, which is why its run says what it is.
import { z } from "zod"
import { described } from "../harness.ts"
import { defineTool } from "./tool.ts"

export const recallTool = defineTool({
  ...described("recall"),
  access: "recall",
  purpose: false,
  schema: z.object({ id: z.string(), offset: z.number().int().min(1).optional(), limit: z.number().int().min(1).optional() }),
  permission: (a) => ({ permission: "recall", class: "read", patterns: [a.id] }),
  async run(a) {
    // The text is the session's insertion (`context` recall); this is what a transcript shows.
    const target = a.id.trim().startsWith("#") ? a.id.trim() : `#${a.id.trim()}`
    return { output: `recall ${target}`, title: target, context: { kind: "recall", target: a.id, ...(a.offset ? { offset: a.offset } : {}), ...(a.limit ? { limit: a.limit } : {}) } }
  },
})
