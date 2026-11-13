// report_write (harness reports.md, spec 3.8.0): a scheduled run files its report. On a device the
// report is kept with the turn and travels back in the turn's answer (acp.md *Scheduled work*):
// the server stores it, notifies, and lists it. Offered only in a session a schedule opened for
// its run (`requires: scheduled`), and it answers the spec's unavailable text in a turn of that
// session that is not the schedule's.
import { z } from "zod"
import { reportResult } from "../acp/scheduled.ts"
import { described } from "../harness.ts"
import { defineTool } from "./tool.ts"

export const reportWriteTool = defineTool({
  ...described("report_write"),
  purpose: false,
  access: "report_write",
  requires: "scheduled",
  schema: z.object({
    title: z.string().min(1).max(160),
    body: z.string().min(1),
    summary: z.string().min(1).max(400),
    importance: z.enum(["normal", "high"]).optional(),
  }),
  // It writes nothing here and reaches nobody but the schedule's owner: allowed without asking.
  permission: () => ({ permission: "report_write", class: "interact", patterns: ["*"] }),
  async run(a, ctx) {
    // The engine answers `unavailable` where the turn is not a run; this is the run.
    const calls = ctx.report!.file({ title: a.title.trim(), body: a.body, summary: a.summary.trim(), importance: a.importance ?? "normal" })
    return { output: reportResult(calls), title: `${a.title.trim()}${calls > 1 ? " · replaces the first" : ""}` }
  },
})
