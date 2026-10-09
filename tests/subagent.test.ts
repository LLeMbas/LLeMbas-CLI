import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../src/app.ts"
import { Bus, type AskReply, type Event } from "../src/bus/index.ts"
import { paths } from "../src/config/paths.ts"
import { createView } from "../src/tui/state.ts"
import { delta, fakeProvider, toolCall, type Fake } from "./fake-provider.ts"

let fake: Fake | undefined
afterEach(() => fake?.stop())

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
    expect(names(child)).toEqual(["read", "glob", "grep", "list", "bash", "web_search", "web_fetch"])
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
    expect(names(child)).toEqual(["read", "grep"])
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
