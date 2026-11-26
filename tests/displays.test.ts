import { expect, test } from "bun:test"
import {
  buildLiveSnapshot,
  cycleTab,
  effectiveTab,
  extractBash,
  extractChanges,
  extractFiles,
  initialNav,
  resetFollow,
  resolveIndex,
  stepEntry,
} from "../src/tui/displays.ts"
import type { Item, Pending, ViewState } from "../src/tui/state.ts"

function baseState(overrides: Partial<ViewState> = {}): ViewState {
  return {
    items: [],
    phase: "idle",
    busySince: 0,
    showReasoning: false,
    expandTools: false,
    queued: { texts: [], mode: "steer" },
    jobs: [],
    ...overrides,
  }
}

test("extractFiles, extractChanges, and extractBash derive entries cleanly from items and pending diffs", () => {
  const diff = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,2 @@\n-old\n+new\n+more\n"
  const pendingDiff = "--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1,1 +1,1 @@\n-x\n+y\n"
  const items: Item[] = [
    { kind: "tool", id: "t1", name: "read", args: { path: "src/a.ts" }, status: "done", output: "1: old\n", facts: ["1 line"], ms: 12 },
    { kind: "tool", id: "t2", name: "edit", args: { path: "src/a.ts" }, status: "done", diff, ms: 40 },
    { kind: "tool", id: "t3", name: "bash", args: { command: "bun test\n" }, status: "running", title: "bun test" },
  ]
  const pending: Pending = {
    tool: "edit",
    args: { path: "src/b.ts" },
    request: { permission: "edit", class: "write", patterns: ["src/b.ts"] },
    decision: { action: "ask", reason: "edit needs approval", always: [] },
    preview: { diff: pendingDiff },
    resolve: () => {},
  }

  const files = extractFiles(items)
  expect(files.length).toBe(1)
  expect(files[0]!.title).toBe("src/a.ts")
  expect(files[0]!.body).toContain("1: old")

  const changes = extractChanges(items, pending)
  expect(changes.length).toBe(2)
  expect(changes[0]!.status).toBe("done")
  expect(changes[0]!.added).toBe(2)
  expect(changes[0]!.removed).toBe(1)
  expect(changes[1]!.status).toBe("proposed")
  expect(changes[1]!.title).toBe("src/b.ts")
  expect(changes[1]!.subtitle).toContain("WAITING FOR APPROVAL")

  const bash = extractBash(items)
  expect(bash.length).toBe(1)
  expect(bash[0]!.status).toBe("running")
  expect(bash[0]!.output).toContain("running")
})

test("buildLiveSnapshot surfaces active tools, live thinking, plan, jobs, and waiting state", () => {
  const state = baseState({
    phase: "tools",
    items: [
      { kind: "reasoning", id: "r1", text: "Checking imports\nEditing parser.ts next", streaming: true, started: 1000 },
      { kind: "tool", id: "t1", name: "read", args: { path: "src/parser.ts" }, status: "done", output: "line1\nline2", ms: 20 },
      {
        kind: "tool",
        id: "t2",
        name: "task",
        args: { description: "inspect tests" },
        status: "running",
        title: "inspect tests",
        children: [{ name: "grep", title: "parseExpr" }],
      },
    ],
    jobs: [{ id: "job1", kind: "command", description: "run suite", state: "running", started: 1000, unread: 0 }],
  })

  const snap = buildLiveSnapshot(state, 4000)
  expect(snap.thinkingStreaming).toBe(true)
  expect(snap.thinkingTail).toContain("Editing parser.ts next")
  expect(snap.activeTools.length).toBe(1)
  expect(snap.activeTools[0]!.children?.[0]?.name).toBe("grep")
  expect(snap.recentTools.length).toBe(1)
  expect(snap.recentTools[0]!.name).toBe("read")
  expect(snap.jobs.length).toBe(1)
  expect(snap.jobs[0]!.detail).toContain("running")
})

test("DisplayNav auto-jumps to changes on proposed diff, respects pinning, and resets on new prompt", () => {
  let nav = initialNav()
  expect(effectiveTab(nav, false)).toBe("live")
  expect(effectiveTab(nav, true)).toBe("changes")

  // Alt+Down cycles live -> files and pins.
  nav = cycleTab(nav, 1)
  expect(nav.tab).toBe("files")
  expect(nav.pinned).toBe(true)
  // Pinned stays on files even if proposed diff appears.
  expect(effectiveTab(nav, true)).toBe("files")

  // Stepping entries back and forward.
  expect(resolveIndex(nav, "files", 3)).toBe(2)
  nav = stepEntry(nav, "files", -1, 3)
  expect(resolveIndex(nav, "files", 3)).toBe(1)
  nav = stepEntry(nav, "files", 1, 3)
  expect(resolveIndex(nav, "files", 3)).toBe(2)

  // New prompt resets follow back to live.
  nav = resetFollow(nav)
  expect(nav.tab).toBe("live")
  expect(nav.pinned).toBe(false)
  expect(effectiveTab(nav, true)).toBe("changes")
})
