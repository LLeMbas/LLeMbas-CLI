// Display per harness spec 3.7.0 (harness/display.md): one title for a call wherever it is said,
// the real count of running subagents, numbers in the terminal's locale. The spec's own cases are
// in harness/conformance/display.json (tests/conformance.test.ts).
import { expect, test } from "bun:test"
import { Bus } from "../src/bus/index.ts"
import { callTitle, localeNumber, plainNumber, resultFacts, terminalLocale } from "../src/session/display.ts"
import { endOf, ProgressTracker, progressLine, progressText, type Progress } from "../src/session/progress.ts"
import { permissionParams } from "../src/acp/agent.ts"

const phases = (bus: Bus) => {
  const seen: (Progress | null)[] = []
  bus.on((e) => e.type === "phase" && seen.push(e.progress as Progress | null))
  return seen
}

test("the progress line's `what` is the call's title: the event's, else made from the arguments", () => {
  const bus = new Bus()
  const seen = phases(bus)
  const t = new ProgressTracker(bus)
  bus.emit({ type: "tool_start", id: "a", name: "grep", args: { pattern: "TODO", path: "src" } })
  expect(seen.at(-1)).toMatchObject({ phase: "running_tool", tool: "grep", what: "TODO" })
  bus.emit({ type: "tool_end", id: "a", name: "grep", result: { output: "" }, ms: 1 })
  bus.emit({ type: "tool_start", id: "b", name: "bash", args: { command: "bun test", description: "Run the tests" }, title: "bun test" })
  expect(seen.at(-1)).toMatchObject({ phase: "running_tool", tool: "bash", what: "bun test" })
  expect(callTitle({ command: "bun test", description: "Run the tests" })).toBe("bun test")
  t.dispose()
})

test("waiting_for_subagents counts the subagents that are running, not always one", async () => {
  const bus = new Bus()
  const seen = phases(bus)
  const t = new ProgressTracker(bus)
  const job = (id: string, state: string) => ({ id, kind: "subagent", state, description: id, started: 0, unread: 0 }) as never
  bus.emit({ type: "tool_start", id: "t1", name: "task", args: { description: "one", prompt: "p" } })
  expect(seen.at(-1)).toMatchObject({ phase: "waiting_for_subagents", running: 1 })
  const since = seen.at(-1)!.since
  // Two more calls in the same step: three foreground subagents.
  bus.emit({ type: "tool_start", id: "t2", name: "task", args: { description: "two", prompt: "p" } })
  bus.emit({ type: "tool_start", id: "t3", name: "task", args: { description: "three", prompt: "p" } })
  await Bun.sleep(300) // a change of the count is data: paced, and `since` kept
  expect(seen.at(-1)).toMatchObject({ phase: "waiting_for_subagents", running: 3, since })
  // The session's subagent jobs count too — one more than the calls of this step.
  for (const id of ["job1", "job2", "job3", "job4"]) bus.emit({ type: "job", state: "start", job: job(id, "running") })
  await Bun.sleep(300)
  expect(seen.at(-1)).toMatchObject({ running: 4 })
  bus.emit({ type: "job", state: "end", job: job("job4", "done") })
  bus.emit({ type: "job", state: "end", job: job("job3", "done") })
  bus.emit({ type: "tool_end", id: "t3", name: "task", result: { output: "" }, ms: 1 })
  await Bun.sleep(300)
  expect(seen.at(-1)).toMatchObject({ phase: "waiting_for_subagents", running: 2 })
  // A command in the background is not a subagent.
  bus.emit({ type: "job", state: "start", job: { ...(job("job9", "running") as object), kind: "command" } as never })
  await Bun.sleep(300)
  expect(seen.at(-1)).toMatchObject({ running: 2 })
  expect(progressText(seen.at(-1)!)).toBe("Waiting for subagents: 2 running")
  t.dispose()
})

test("numbers in the terminal's locale; durations and the plain format untouched", () => {
  expect(terminalLocale({ LANG: "sk_SK.UTF-8" })).toBe("sk-SK")
  expect(terminalLocale({ LANG: "en_US.UTF-8", LC_NUMERIC: "de_DE.UTF-8" })).toBe("de-DE")
  expect(terminalLocale({ LANG: "en_US.UTF-8", LC_NUMERIC: "de_DE.UTF-8", LC_ALL: "fr_FR@euro" })).toBe("fr-FR")
  expect(terminalLocale({ LANG: "C.UTF-8" })).toBeUndefined()
  expect(terminalLocale({ LC_ALL: "POSIX" })).toBeUndefined()
  expect(terminalLocale({})).toBeUndefined()
  expect(terminalLocale({ LANG: "not a locale!" })).toBeUndefined()
  const de = localeNumber("de-DE")
  const en = localeNumber("en-US")
  expect([de(12480), de(12.46, 1), de(7)]).toEqual(["12.480", "12,5", "7"])
  expect([en(12480), en(12.46, 1), en(1234567)]).toEqual(["12,480", "12.5", "1,234,567"])
  expect([plainNumber(12480), plainNumber(12.46, 1)]).toEqual(["12480", "12.5"])
  expect(localeNumber(undefined)(12480)).toBe("12480")
  expect(localeNumber("xx-not-a-locale-")(12480)).toBe("12480")
  const reading: Progress = { phase: "reading_prompt", since: 0, done: 90000, total: 140000 }
  expect(progressText(reading, 0, de)).toBe("Reading the prompt: 90.000 / 140.000 tokens (64%)")
  expect(progressText(reading, 0)).toBe("Reading the prompt: 90000 / 140000 tokens (64%)")
  // The clock is not a locale number.
  expect(progressLine({ phase: "writing", since: 0, rate: 1234.56 }, 65_000, de)).toBe("Writing: 1.234,6 tok/s · 1m 05s")
})

test("what a finished call adds after its title", () => {
  const diff = "--- a.txt\n+++ a.txt\n@@ -1,2 +1,3 @@\n one\n+two\n three\n"
  expect(resultFacts("edit", "a.txt", { title: "a.txt +1 −0", meta: { diff } })).toEqual(["+1 −0"])
  expect(resultFacts("shell", "bun test", { title: "bun test · exit 0", meta: { exit: 0 } })).toEqual([])
  expect(resultFacts("shell", "bun test", { title: "bun test · exit 3", meta: { exit: 3 } })).toEqual(["exit 3"])
  // Stopped by a signal: no exit code, so what the tool says.
  expect(resultFacts("shell", "sleep 9", { title: "sleep 9 · stopped (SIGTERM)", meta: { exit: null } })).toEqual(["stopped (SIGTERM)"])
  expect(resultFacts("search", "TODO", { title: "/TODO/ · 1234 matches", meta: { hits: 1234 } }, localeNumber("en-US"))).toEqual(["1,234 hits"])
  expect(resultFacts("read", "src/a.ts", { title: "src/a.ts · 1–200 of 950" })).toEqual(["1–200 of 950"])
  expect(resultFacts("tool", "theme", { title: "theme = moria (global)" })).toEqual(["= moria (global)"])
  expect(resultFacts("tool", "job3", { title: "job3 · stopped" })).toEqual(["stopped"])
  expect(resultFacts("read", "notes", { title: "notes" })).toEqual([])
  expect(resultFacts("tool", undefined, {})).toEqual([])
})

test("over the link an approval card keeps the whole command as its title and names the tool; how a turn ended, as the spec's progress", () => {
  const p = permissionParams("s1", { tool: "bash", args: { command: "rm -rf build\necho done", description: "Clean" }, request: { command: "rm -rf build\necho done", patterns: [] }, decision: { reason: "asks", always: [] } } as never)
  // A card is read before it is answered: the whole command, not the call's short title.
  expect(p.toolCall.title).toBe("rm -rf build\necho done")
  expect(p._meta.lembas.tool).toBe("bash")
  // No command: the tool's name, as before — and the name is in _meta.lembas either way.
  const q = permissionParams("s1", { tool: "edit", args: { path: "a.txt", old: "a", new: "b" }, request: { patterns: ["a.txt"] }, decision: { reason: "asks", always: [] } } as never)
  expect([q.toolCall.title, q._meta.lembas.tool]).toEqual(["edit", "edit"])
  expect(endOf("stop")).toBeUndefined()
  expect(endOf("cancelled")).toEqual({ phase: "stopped", reason: "person" })
  expect(endOf("steps")).toEqual({ phase: "stopped", reason: "steps" })
  expect(endOf("budget")).toEqual({ phase: "stopped", reason: "budget" })
  expect(endOf("error", "401 Unauthorized\nrun lembas login")).toEqual({ phase: "failed", reason: "401 Unauthorized" })
})
