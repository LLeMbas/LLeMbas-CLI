import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../src/app.ts"
import { Bus, type Asker, type AskReply, type Event } from "../src/bus/index.ts"
import { paths } from "../src/config/paths.ts"
import { createView } from "../src/tui/state.ts"
import { MARKS } from "../src/jobs/note.ts"
import { delta, fakeProvider, toolCall, type Fake } from "./fake-provider.ts"

let fake: Fake | undefined
let other: Fake | undefined
afterEach(() => (fake?.stop(), other?.stop(), (other = undefined)))

/** Two scripted servers: the parent's model on `f`, the child's on `g` (task's `model: "g/m"`) —
 *  a shared script would hand a reply to whichever engine asked first. */
function pair(parent: Parameters<typeof fakeProvider>[0], child: Parameters<typeof fakeProvider>[0], o: { oneAtATime?: boolean; config?: string; asker?: Asker } = {}) {
  fake = fakeProvider(parent)
  other = fakeProvider(child)
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(
    join(paths.config, "connections.yaml"),
    `connections:\n  f:\n    dialect: openai-chat\n    base_url: ${fake.url}\n    models: { m: {} }\n  g:\n    dialect: openai-chat\n    base_url: ${other.url}\n${o.oneAtATime ? "    one_model_at_a_time: true\n" : ""}    models: { m: {}, n: {} }\n`,
    { mode: 0o600 },
  )
  writeFileSync(join(paths.config, "config.yaml"), `model: f/m\n${o.config ?? ""}`)
  const cwd = mkdtempSync(join(tmpdir(), "ph-sub-"))
  writeFileSync(join(cwd, "calc.py"), "def average(v):\n    return sum(v) / (len(v) - 1)\n")
  const events: Event[] = []
  const app = createApp({ cwd, mode: "edit", store: false, snapshots: false, asker: o.asker ?? { ask: async (): Promise<AskReply> => ({ kind: "once" }) } })
  app.bus.on((e) => events.push(e))
  return { app, events, cwd }
}
const settled = async (a: ReturnType<typeof createApp>, n: number) => {
  const until = Date.now() + 8000
  while (Date.now() < until && (fake!.requests.length < n || a.turns.current)) await Bun.sleep(20)
}

function app(script: Parameters<typeof fakeProvider>[0]) {
  fake = fakeProvider(script)
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  f:\n    dialect: openai-chat\n    base_url: ${fake.url}\n    models: { m: {} }\n`, { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), "model: f/m\n")
  const cwd = mkdtempSync(join(tmpdir(), "ph-sub-"))
  writeFileSync(join(cwd, "calc.py"), "def average(v):\n    return sum(v) / (len(v) - 1)\n")
  return createApp({ cwd, mode: "edit", store: false, asker: { ask: async (): Promise<AskReply> => ({ kind: "once" }) } })
}
const names = (r: any) => (r.tools ?? []).map((t: any) => t.function.name)

describe("subagents", () => {
  test("explore: its own prompt and read-only tools; only its report returns; its tool lines are announced", async () => {
    const a = app([
      { chunks: [toolCall(0, "t1", "task", JSON.stringify({ description: "find the bug", prompt: "Find why average is wrong in calc.py" }))] },
      { chunks: [toolCall(0, "r1", "read", '{"path":"calc.py"}')] },
      { chunks: [delta({ content: "calc.py:2 divides by len(v) - 1; should be len(v)." })] },
      { chunks: [delta({ content: "The subagent found it." })] },
    ])
    const events: Event[] = []
    a.bus.on((e) => events.push(e))
    await a.engine.prompt("why is average wrong?")
    // the parent offers task; the child does not, nor writing
    expect(names(fake!.requests[0])).toContain("task")
    expect(fake!.requests[0].tools.find((t: any) => t.function.name === "task").function.description).toContain("explore — read-only research")
    const child = fake!.requests[1]
    expect(child.messages[0].content).toContain('You are the "explore" subagent')
    expect(child.messages[0].content).not.toContain("Permission mode: plan")
    expect(child.messages.at(-1).content).toBe("Find why average is wrong in calc.py")
    // its own job tools for commands it starts, and report for a word to the main agent
    expect(names(child)).toEqual(["read", "glob", "grep", "list", "bash", "job_output", "job_list", "job_stop", "web_search", "web_fetch", "report"])
    // the preamble is the spec's text; a subagent is told nothing of plan_write or ask_user
    expect(child.messages[0].content).toContain("Your final reply is your report to the main agent")
    expect(child.messages[0].content).toContain("the report tool sends the main agent a message")
    expect(child.messages[0].content).not.toContain("plan_write")
    expect(child.messages[0].content).not.toContain("ask_user")
    expect(child.messages[0].content).not.toContain("## Skills")
    // the parent gets the report, not the reading
    const result = fake!.requests[3].messages.at(-1).content as string
    expect(result).toStartWith("calc.py:2 divides by len(v) - 1")
    expect(result).toContain("[explore subagent · 2 steps · 1 tool call]")
    expect(fake!.requests[3].messages.some((m: any) => m.role === "tool" && m.content.includes("return sum(v)"))).toBe(false)
    expect(events.find((e) => e.type === "sub_tool")).toMatchObject({ type: "sub_tool", callId: "t1", name: "read" })
  })

  test("a custom agent's tools and mode apply; an unknown agent is refused", async () => {
    // agents are read when the app starts, so the file comes first
    mkdirSync(join(paths.config, "agents"), { recursive: true })
    writeFileSync(join(paths.config, "agents", "reviewer.md"), "---\ndescription: reviews code\nmode: plan\ntools: [read, grep]\n---\nReview for bugs only.\n")
    const b = app([
      { chunks: [toolCall(0, "t1", "task", JSON.stringify({ description: "review", prompt: "review calc.py", agent: "reviewer" })), toolCall(1, "t2", "task", JSON.stringify({ description: "x", prompt: "y", agent: "nope" }))] },
      { chunks: [delta({ content: "Looks wrong at line 2." })] },
      { chunks: [delta({ content: "done" })] },
    ])
    await b.engine.prompt("review")
    const child = fake!.requests.find((r: any) => r.messages[0].content.includes('"reviewer" subagent'))
    expect(names(child)).toEqual(["read", "grep", "report"])
    expect(child.messages[0].content).toContain("Review for bugs only.")
    expect(child.messages[0].content).toContain("you cannot change anything")
    const results = fake!.requests.at(-1).messages.filter((m: any) => m.role === "tool").map((m: any) => m.content as string)
    expect(results.some((r: string) => r.includes('There is no agent "nope"'))).toBe(true)
  })

  test("asks from two subagents at once wait their turn instead of replacing each other", async () => {
    const view = createView(new Bus())
    const req = (n: string) => ({ tool: "bash", args: {}, request: { permission: "bash", class: "execute" as const, patterns: [n], command: n }, decision: { action: "ask" as const, reason: n, always: [] } })
    const first = view.asker.ask(req("one"))
    const second = view.asker.ask(req("two"))
    await Bun.sleep(10)
    expect(view.state.pending?.request.command).toBe("one")
    view.state.pending!.resolve({ kind: "once" })
    await first
    await Bun.sleep(10)
    expect(view.state.pending?.request.command).toBe("two")
    view.state.pending!.resolve({ kind: "deny" })
    expect(await second).toEqual({ kind: "deny" })
  })
})

describe("worktrees", () => {
  test("worktree: true — the subagent works on its own branch; your files are untouched; the branch carries its commit", async () => {
    const { git } = await import("../src/git/run.ts")
    const { readFileSync, existsSync } = await import("node:fs")
    const a = app([
      { chunks: [toolCall(0, "t1", "task", JSON.stringify({ description: "fix average", prompt: "Fix calc.py", agent: "general", worktree: true }))] },
      { chunks: [toolCall(0, "r1", "read", '{"path":"calc.py"}')] },
      { chunks: [toolCall(0, "w1", "write", JSON.stringify({ path: "calc.py", content: "def average(v):\n    return sum(v) / len(v)\n" }))] },
      { chunks: [delta({ content: "Fixed the divisor." })] },
      { chunks: [delta({ content: "Done on a branch." })] },
    ])
    const root = a.project.root
    for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "t@e"], ["config", "user.name", "T"], ["config", "commit.gpgsign", "false"], ["add", "calc.py"], ["commit", "-q", "-m", "init"]]) git(root, args)
    // the app found no git when it started; look again
    ;(a.project as any).gitRoot = root
    await a.engine.prompt("fix it in a worktree")
    const child = fake!.requests[1].messages[0].content as string
    expect(child).toContain("You are working in a separate checkout")
    expect(child).toMatch(/Project root: .*worktrees/)
    expect(readFileSync(join(root, "calc.py"), "utf8")).toContain("len(v) - 1")
    const result = fake!.requests[4].messages.at(-1).content as string
    const branch = /branch (lembas\/general-fix-average-[a-z0-9]+)/.exec(result)?.[1]
    expect(branch).toBeTruthy()
    expect(result).toContain("1 commit")
    expect(git(root, ["show", `${branch}:calc.py`]).out).toContain("sum(v) / len(v)")
    expect(git(root, ["log", "-1", "--format=%s", branch!]).out).toBe("general: fix average")
    expect(git(root, ["worktree", "list"]).out.split("\n")).toHaveLength(1)
    expect(existsSync(join(root, ".git"))).toBe(true)
  })

  test("a subagent that changes nothing leaves no branch", async () => {
    const { git } = await import("../src/git/run.ts")
    const a = app([
      { chunks: [toolCall(0, "t1", "task", JSON.stringify({ description: "look", prompt: "Look at calc.py", agent: "general", worktree: true }))] },
      { chunks: [delta({ content: "Nothing to change." })] },
      { chunks: [delta({ content: "ok" })] },
    ])
    const root = a.project.root
    for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "t@e"], ["config", "user.name", "T"], ["config", "commit.gpgsign", "false"], ["add", "calc.py"], ["commit", "-q", "-m", "init"]]) git(root, args)
    ;(a.project as any).gitRoot = root
    await a.engine.prompt("look")
    expect(fake!.requests[2].messages.at(-1).content).toContain("It changed nothing, so its branch was removed.")
    expect(git(root, ["branch", "--list", "lembas/*"]).out).toBe("")
  })
})

test("a worktree subagent cannot touch the main checkout, even unrestricted", async () => {
  const { git } = await import("../src/git/run.ts")
  const { readFileSync } = await import("node:fs")
  const a = app([])
  const root = a.project.root
  const target = join(root, "calc.py")
  fake!.stop()
  fake = fakeProvider([
    { chunks: [toolCall(0, "t1", "task", JSON.stringify({ description: "sneak", prompt: "x", agent: "general", worktree: true }))] },
    { chunks: [toolCall(0, "r1", "read", JSON.stringify({ path: target }))] },
    { chunks: [toolCall(0, "w1", "write", JSON.stringify({ path: target, content: "hacked\n" }))] },
    { chunks: [delta({ content: "tried" })] },
    { chunks: [delta({ content: "ok" })] },
  ])
  writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  f:\n    dialect: openai-chat\n    base_url: ${fake.url}\n    models: { m: {} }\n`, { mode: 0o600 })
  for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "t@e"], ["config", "user.name", "T"], ["config", "commit.gpgsign", "false"], ["add", "calc.py"], ["commit", "-q", "-m", "init"]]) git(root, args)
  const b = createApp({ cwd: root, mode: "auto", store: false, asker: { ask: async (): Promise<AskReply> => ({ kind: "once" }) } })
  await b.engine.prompt("go")
  expect(readFileSync(target, "utf8")).toContain("len(v) - 1")
  const denied = fake!.requests[3].messages.at(-1).content as string
  expect(denied).toMatch(/outside the project|denied/)
  expect(git(root, ["branch", "--list", "lembas/*"]).out).toBe("")
})

describe("background subagents (spec 2.0.0)", () => {
  test("task background: true returns at once; the report arrives as a marked note, a turn of its own", async () => {
    const { app: a, events } = pair(
      [
        { chunks: [toolCall(0, "t1", "task", JSON.stringify({ description: "find the bug", prompt: "Find why average is wrong", model: "g/m", background: true }))] },
        { chunks: [delta({ content: "Started it; carrying on." })] },
        { chunks: [delta({ content: "Got the report." })] },
      ],
      [{ chunks: [toolCall(0, "r1", "read", '{"path":"calc.py"}')] }, { chunks: [delta({ content: "calc.py:2 divides by len(v) - 1." })] }],
    )
    await a.turns.prompt("look into it in the background")
    const started = fake!.requests[1].messages.at(-1).content as string
    expect(started).toStartWith("Started subagent explore as job1 (find the bug).")
    await settled(a, 3)
    const note = fake!.requests[2].messages.at(-1).content as string
    expect(note).toStartWith(MARKS.subagent)
    expect(note).toContain("job1 (explore: find the bug) finished after")
    expect(note).toContain("calc.py:2 divides by len(v) - 1.")
    expect(note).toContain("[explore subagent · 2 steps · 1 tool call]")
    expect(events.find((e) => e.type === "sub_tool")).toMatchObject({ type: "sub_tool", callId: "t1", jobId: "job1", name: "read" })
    expect(events.filter((e) => e.type === "job" && e.state !== "update").map((e) => e.type === "job" && `${e.job.kind} ${e.state}`)).toEqual(["subagent start", "subagent end"])
    const job = a.jobs()[0]!
    expect(job).toMatchObject({ id: "job1", kind: "subagent", state: "done", agent: "explore", model: "g/m", steps: 2, tools: 1 })
    // Its transcript, for job_output and a panel: the tool line and what it wrote.
    expect(job.output).toContain("[read]")
    expect(job.output).toContain("calc.py:2 divides")
    expect(job.subagent?.engine.messages.at(-1)).toMatchObject({ role: "assistant" })
  })

  test("job_send: to a running subagent at its next step under the to_subagent mark; to a finished one as a new prompt under the same id", async () => {
    const { app: a, events } = pair(
      [
        // general, not explore: in plan mode `sleep` is refused at once, and the child would be at its next step before the message.
        { chunks: [toolCall(0, "t1", "task", JSON.stringify({ description: "wait and look", prompt: "Wait, then look", model: "g/m", agent: "general", background: true }))] },
        { chunks: [toolCall(0, "s1", "job_send", JSON.stringify({ id: "job1", text: "Also check X" }))] },
        { chunks: [delta({ content: "Told it." })] },
        { chunks: [toolCall(0, "s2", "job_send", JSON.stringify({ id: "job1", text: "And now Y" }))] },
        { chunks: [delta({ content: "Asked for more." })] },
        { chunks: [delta({ content: "All done." })] },
      ],
      [
        { chunks: [toolCall(0, "b1", "bash", JSON.stringify({ command: "sleep 1", description: "wait" }))] },
        { chunks: [delta({ content: "First report." })] },
        { chunks: [delta({ content: "Second report." })] },
      ],
    )
    await a.turns.prompt("go")
    expect(fake!.requests[2].messages.at(-1).content).toContain("Sent to job1")
    await settled(a, 6)
    const child = other!.requests
    const steered = child[1].messages.find((m: any) => m.role === "user" && String(m.content).startsWith(MARKS.to_subagent))
    expect(steered?.content).toContain("Also check X")
    expect(child[2].messages.at(-1).content).toBe("And now Y")
    expect(fake!.requests[3].messages.at(-1).content).toContain("First report.")
    expect(fake!.requests[4].messages.at(-1).content).toContain("is running again with your message")
    expect(fake!.requests[5].messages.at(-1).content).toContain("Second report.")
    expect(events.filter((e) => e.type === "job" && e.state !== "update").map((e) => e.type === "job" && e.state)).toEqual(["start", "end", "start", "end"])
    expect(a.jobs()).toHaveLength(1)
  })

  test("report: a subagent's message reaches the main agent at its next step, marked; the final reply still comes", async () => {
    const { app: a, events } = pair(
      [{ chunks: [toolCall(0, "t1", "task", JSON.stringify({ description: "find loaders", prompt: "Find the loaders", model: "g/m" }))] }, { chunks: [delta({ content: "Thanks." })] }],
      [{ chunks: [toolCall(0, "p1", "report", JSON.stringify({ text: "There are two loaders; which one?" }))] }, { chunks: [delta({ content: "Final: the YAML one." })] }],
    )
    await a.turns.prompt("go")
    const msgs = fake!.requests[1].messages
    const note = msgs.find((m: any) => m.role === "user" && String(m.content).startsWith(MARKS.message))
    expect(note?.content).toContain("job1 (explore: find loaders):\nThere are two loaders; which one?")
    // The note goes in after the step's tool results, as a steer does.
    expect(msgs.at(-2)).toMatchObject({ role: "tool" })
    expect(msgs.at(-2).content).toContain("Final: the YAML one.")
    expect(other!.requests[1].messages.at(-1).content).toContain("Sent to the main agent")
    expect(events.find((e) => e.type === "job_note")).toMatchObject({ type: "job_note", jobId: "job1" })
    // The main agent itself has no report tool.
    expect(names(fake!.requests[0])).not.toContain("report")
  })

  test("an approval from a subagent says which one asked (Asker source)", async () => {
    const seen: unknown[] = []
    const asker: Asker = {
      ask: async (req) => {
        seen.push(req.source)
        return { kind: "once" }
      },
    }
    const { app: a } = pair(
      [{ chunks: [toolCall(0, "t1", "task", JSON.stringify({ description: "run it", prompt: "Run ls", model: "g/m", agent: "general" }))] }, { chunks: [delta({ content: "ok" })] }],
      [{ chunks: [toolCall(0, "b1", "bash", JSON.stringify({ command: "true", description: "nothing" }))] }, { chunks: [delta({ content: "ran" })] }],
      { asker },
    )
    await a.turns.prompt("go")
    expect(seen).toEqual([{ jobId: "job1", agent: "general", description: "run it" }])
  })

  test("capacity: a second subagent is refused beside one already running on a one-model-at-a-time server", async () => {
    const { app: a } = pair(
      [
        {
          chunks: [
            toolCall(0, "t1", "task", JSON.stringify({ description: "first", prompt: "wait", model: "g/m", background: true })),
            toolCall(1, "t2", "task", JSON.stringify({ description: "second", prompt: "wait too", model: "g/n", background: true })),
          ],
        },
        { chunks: [delta({ content: "ok" })] },
        { chunks: [delta({ content: "done" })] },
      ],
      [{ chunks: [delta({ content: "slow" })], gapMs: 400 }],
      { oneAtATime: true },
    )
    await a.turns.prompt("go")
    const results = fake!.requests[1].messages.filter((m: any) => m.role === "tool").map((m: any) => m.content as string)
    expect(results[0]).toStartWith("Started subagent explore as job1")
    expect(results[1]).toContain("holds one model at a time, and a subagent is already running on g/m there")
    expect(other!.requests.map((r: any) => r.model)).toEqual(["m"])
    await settled(a, 3)
  })

  test("a broken agent file is said at start, and the agent is still offered with its body", () => {
    mkdirSync(join(paths.config, "agents"), { recursive: true })
    writeFileSync(join(paths.config, "agents", "broken.md"), "---\ndescription: [unclosed\nmode: plan\n---\nDo the thing.\n")
    const { app: a } = pair([], [])
    expect(a.loaded.warnings.some((w) => w.includes("broken.md") && w.includes("frontmatter not read"))).toBe(true)
    const broken = a.agents.find((x) => x.name === "broken")!
    expect(broken.instructions).toBe("Do the thing.")
    expect(broken.mode).toBeUndefined()
  })
})

test("a cancelled worktree subagent keeps its branch, and the result names it", async () => {
  const { git } = await import("../src/git/run.ts")
  const { app: a, events } = pair(
    [{ chunks: [toolCall(0, "t1", "task", JSON.stringify({ description: "fix average", prompt: "Fix calc.py", agent: "general", worktree: true, model: "g/m" }))] }],
    [
      { chunks: [toolCall(0, "r1", "read", '{"path":"calc.py"}')] },
      { chunks: [toolCall(0, "w1", "write", JSON.stringify({ path: "calc.py", content: "def average(v):\n    return sum(v) / len(v)\n" }))] },
      { chunks: [delta({ content: "slow" })], gapMs: 3000 },
    ],
  )
  const root = a.project.root
  for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "t@e"], ["config", "user.name", "T"], ["config", "commit.gpgsign", "false"], ["add", "calc.py"], ["commit", "-q", "-m", "init"]]) git(root, args)
  ;(a.project as any).gitRoot = root
  const turn = a.turns.prompt("fix it in a worktree")
  const until = Date.now() + 8000
  while (Date.now() < until && !events.some((e) => e.type === "sub_tool" && e.name === "write")) await Bun.sleep(20)
  const write = events.find((e) => e.type === "sub_tool" && e.name === "write")
  expect(write && write.type === "sub_tool" ? write.title : "").not.toMatch(/denied|refused|outside|not read/i)
  await Bun.sleep(100)
  a.cancel()
  expect(await turn).toBe("cancelled")
  const result = a.engine.messages.find((m) => m.role === "tool")!
  expect(result.role === "tool" && result.content).toContain("ended: cancelled")
  const branch = /branch (lembas\/general-fix-average-[a-z0-9]+)/.exec(result.role === "tool" ? result.content : "")?.[1]
  expect(branch).toBeTruthy()
  expect(git(root, ["log", "-1", "--format=%s", branch!]).out).toBe("general: fix average (stopped)")
  expect(git(root, ["show", `${branch}:calc.py`]).out).toContain("sum(v) / len(v)")
  expect(a.jobs()[0]).toMatchObject({ kind: "subagent", state: "stopped" })
})
