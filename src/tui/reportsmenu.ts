// The /reports menu (harness reports.md): what the schedules filed, unread first. Enter opens a
// report's own menu — read it here, reply, mark it read, delete it; in the list ctrl+r marks the
// highlighted one read and ctrl+d deletes it (asked once). On the shared menu.
import { deleteReport, getReport, listReports, markRead, metaOf, replyPrompt, sorted, type Report } from "../lembas/reports.ts"
import { clean } from "../mcp/clean.ts"
import type { CommandCtx } from "./commands.ts"

const fail = (c: CommandCtx, e: unknown) => c.view.info(`/reports: ${(e as Error).message}`, "warn")

/** The list. `all`: already read from the server (after a change, the list as it now is). */
export async function openReports(c: CommandCtx, select?: string, all?: Report[]): Promise<void> {
  let reports: Report[]
  try {
    reports = sorted(all ?? (await listReports()))
  } catch (e) {
    return fail(c, e)
  }
  const unread = reports.filter((r) => r.unread).length
  c.openDialog({
    title: `Reports — ${unread} unread of ${reports.length}`,
    options: reports.map((r) => ({
      label: clean(r.title),
      value: r.id,
      description: metaOf(r),
      mark: r.unread ? (r.importance === "high" ? "attention" : "on") : "off",
      section: r.unread ? "Unread" : "Read",
      detail: clean(r.summary ?? ""),
    })),
    empty: "No reports. A schedule files one when its notify-when says so — every run, when something you named holds, or never (/schedule).",
    filter: reports.length > 8,
    width: 88,
    ...(select ? { select } : {}),
    hint: "↑↓ move · enter open · ctrl+r mark read · ctrl+d delete · esc close",
    keys: [
      {
        when: (k) => k.ctrl === true && k.name === "r",
        keep: true,
        run: (id) =>
          void markRead(id)
            .then(() => openReports(c, id, reports.map((r) => (r.id === id ? { ...r, unread: false } : r))))
            .catch((e) => fail(c, e)),
      },
      { when: (k) => k.ctrl === true && k.name === "d", run: (id) => confirmDelete(c, reports.find((r) => r.id === id)!, reports) },
    ],
    onSelect: (id) => openReport(c, reports.find((r) => r.id === id)!, reports),
  })
}

/** One report: what can be done with it. */
function openReport(c: CommandCtx, r: Report, all: Report[]) {
  c.openDialog({
    title: clean(r.title),
    body: [metaOf(r), clean(r.summary ?? "")].filter(Boolean),
    options: [
      { label: "Read it here", value: "read", description: "shown in the transcript, and marked read" },
      { label: "Reply…", value: "reply", description: "continue it in this session: the report, then your words" },
      ...(r.unread ? [{ label: "Mark as read", value: "mark" }] : []),
      { label: "Delete", value: "delete", description: "asks first" },
    ],
    filter: false,
    onBack: () => void openReports(c, r.id, all),
    onSelect: (v) => {
      if (v === "read") return void readReport(c, r.id)
      if (v === "delete") return confirmDelete(c, r, all)
      if (v === "mark")
        return void markRead(r.id)
          .then(() => openReports(c, r.id, all.map((x) => (x.id === r.id ? { ...x, unread: false } : x))))
          .catch((e) => fail(c, e))
      // Reply: the person's words, typed here; then the report and the words go to this session.
      c.openDialog({
        title: `Reply to: ${clean(r.title)}`,
        options: [],
        empty: "Type your reply and press enter. The report and your words are sent to this session's agent, which carries on from there.",
        custom: { label: "send", onSubmit: (words) => void reply(c, r.id, words) },
        onBack: () => openReport(c, r, all),
        onSelect: () => {},
      })
    },
  })
}

function confirmDelete(c: CommandCtx, r: Report, all: Report[]) {
  c.openDialog({
    title: `Delete the report "${clean(r.title)}"?`,
    body: ["It is deleted on the server, for every app."],
    options: [
      { label: "Delete it", value: "yes" },
      { label: "Keep it", value: "no", current: true },
    ],
    select: "no",
    filter: false,
    onBack: () => void openReports(c, r.id, all),
    onSelect: (v) => {
      if (v !== "yes") return void openReports(c, r.id, all)
      void deleteReport(r.id)
        .then(() => (c.view.info(`deleted the report "${clean(r.title)}"`), openReports(c, undefined, all.filter((x) => x.id !== r.id))))
        .catch((e) => fail(c, e))
    },
  })
}

/** Read one here: its Markdown in the transcript (a page as its note), and marked read. */
export async function readReport(c: CommandCtx, id: string): Promise<void> {
  try {
    const r = await getReport(id)
    c.view.report(clean(r.title), metaOf(r), clean(r.body ?? r.summary ?? "", true))
    if (r.unread) await markRead(r.id)
  } catch (e) {
    fail(c, e)
  }
}

async function reply(c: CommandCtx, id: string, words: string): Promise<void> {
  if (!words.trim()) return
  try {
    const r = await getReport(id)
    if (!c.sendAs) return c.view.info("a reply needs a session to send it to", "warn")
    c.sendAs(replyPrompt(r, words), `↩ ${clean(r.title)}: ${words.trim()}`, { attachFrom: words })
    if (r.unread) await markRead(r.id)
  } catch (e) {
    fail(c, e)
  }
}
