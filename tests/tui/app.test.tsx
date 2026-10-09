import { afterEach, expect, test } from "bun:test"
import { delta, toolCall, usage } from "../fake-provider.ts"
import { tui } from "./harness.tsx"

let t: Awaited<ReturnType<typeof tui>> | undefined
afterEach(() => t?.stop())

test("/model opens the picker; ↓ + enter switches", async () => {
  t = await tui([])
  await t.input.typeText("/model")
  t.input.pressEnter()
  expect(await t.until("↑↓ move")).toBe(true)
  t.input.pressArrow("down")
  await t.settle()
  t.input.pressEnter()
  await t.settle()
  expect(t.app.engine.model.ref).toBe("fake/other")
  expect(t.frame()).toContain("model: fake/other")
})

test("a prompt runs; a bash call asks; y allows it; the answer renders as markdown", async () => {
  t = await tui([
    { chunks: [delta({ content: "Checking." }), toolCall(0, "c1", "bash", '{"command":"echo hi > out.txt","description":"Write out.txt"}'), usage(9000, 40)] },
    { chunks: [delta({ content: "## Done\n\nWrote **out.txt**." }), usage(12000, 60)] },
  ])
  await t.input.typeText("make a file")
  t.input.pressEnter()
  expect(await t.until("Allow once")).toBe(true)
  expect(t.frame()).toContain("echo hi > out.txt")
  await t.input.typeText("y")
  expect(await t.until("Wrote out.txt.")).toBe(true)
  const f = t.frame()
  expect(f).toContain("❯ Ask") // the y that answered did not also land in the prompt
  expect(f).toContain("┃ make a file")
  expect(f).toContain("┊ 💻 bash   Write out.txt · exit 0")
  expect(f).not.toContain("## Done") // heading marker concealed
  expect(f).toContain("ctx 12k/33k 37%")
  expect(await Bun.file(`${t.cwd}/out.txt`).text()).toBe("hi\n")
})

test("shift+tab cycles manual → edit → plan → manual; the status bar follows", async () => {
  t = await tui([])
  expect(t.frame()).toContain(" manual · fake/coder · low")
  for (const want of ["edit", "plan", "manual"] as const) {
    t.input.pressTab({ shift: true })
    await t.settle()
    expect(t.app.engine.mode).toBe(want)
    expect(t.frame()).toContain(` ${want} · fake/coder`)
  }
})

test("deny with a reason sends the reason to the model", async () => {
  t = await tui([
    { chunks: [toolCall(0, "c1", "bash", '{"command":"rm hello.txt"}')] },
    { chunks: [delta({ content: "Leaving it." })] },
  ])
  await t.input.typeText("delete it")
  t.input.pressEnter()
  expect(await t.until("Allow once")).toBe(true)
  await t.input.typeText("r")
  await t.settle()
  await t.input.typeText("keep the file")
  t.input.pressEnter()
  expect(await t.until("Leaving it.")).toBe(true)
  expect(t.fake.requests[1].messages.at(-1).content).toContain("keep the file")
  expect(t.frame()).toContain("⛔")
})

test("e edits the command before allowing it: the edited line runs, and the model is told", async () => {
  t = await tui([
    { chunks: [toolCall(0, "c1", "bash", '{"command":"echo hi > out.txt"}')] },
    { chunks: [delta({ content: "Noted." })] },
  ])
  await t.input.typeText("make a file")
  t.input.pressEnter()
  expect(await t.until("Edit, then allow")).toBe(true)
  await t.input.typeText("e")
  expect(await t.until("run › echo hi > out.txt")).toBe(true)
  await t.input.typeText(" && echo edited >> out.txt")
  t.input.pressEnter()
  expect(await t.until("Noted.")).toBe(true)
  expect(await Bun.file(`${t.cwd}/out.txt`).text()).toBe("hi\nedited\n")
  expect(t.fake.requests[1].messages.at(-1).content).toContain("The user changed the command before allowing it. What ran: echo hi > out.txt && echo edited >> out.txt")
})

test("↑ recalls the previous prompt", async () => {
  t = await tui([{ chunks: [delta({ content: "one" })] }])
  await t.input.typeText("first prompt")
  t.input.pressEnter()
  expect(await t.until("one")).toBe(true)
  t.input.pressArrow("up")
  await t.settle()
  expect(t.frame()).toContain("❯ first prompt")
})

test("/compact replaces the conversation with a summary", async () => {
  t = await tui([
    { chunks: [delta({ content: "The answer is 42." })] },
    { chunks: [delta({ content: "## What we are doing\nFinding the answer. It is 42." })] },
  ])
  await t.input.typeText("what is the answer")
  t.input.pressEnter()
  expect(await t.until("The answer is 42.")).toBe(true)
  await t.input.typeText("/compact")
  t.input.pressEnter()
  expect(await t.until("compacted")).toBe(true)
  expect(t.fake.requests[1].messages[0].content).toContain("## Transcript")
  expect(t.app.engine.messages[0]).toMatchObject({ role: "user" })
  expect(JSON.stringify(t.app.engine.messages[0])).toContain("It is 42.")
})

test("/undo restores the files and puts the prompt back; /redo re-applies; /diff shows the change", async () => {
  t = await tui([
    { chunks: [toolCall(0, "c1", "read", '{"path":"hello.txt"}')] },
    { chunks: [toolCall(0, "c2", "edit", JSON.stringify({ path: "hello.txt", old: "world", new: "there" }))] },
    { chunks: [delta({ content: "Changed it." })] },
  ])
  t.app.engine.mode = "edit"
  await t.input.typeText("change the greeting")
  t.input.pressEnter()
  expect(await t.until("Changed it.")).toBe(true)
  expect(await Bun.file(`${t.cwd}/hello.txt`).text()).toBe("hello there\n")
  await t.input.typeText("/diff")
  t.input.pressEnter()
  expect(await t.until("changes in this session")).toBe(true)
  await t.input.typeText("/undo")
  t.input.pressEnter()
  expect(await t.until("undone — restored 1 file: hello.txt")).toBe(true)
  expect(await Bun.file(`${t.cwd}/hello.txt`).text()).toBe("hello world\n")
  expect(t.frame()).toContain("❯ change the greeting")
  expect(t.frame()).not.toContain("Changed it.")
  expect(t.app.engine.messages).toHaveLength(0)
  // clear the restored prompt, then redo
  for (let i = 0; i < 20; i++) t.input.pressBackspace()
  await t.input.typeText("/redo")
  t.input.pressEnter()
  expect(await t.until("redone")).toBe(true)
  expect(await Bun.file(`${t.cwd}/hello.txt`).text()).toBe("hello there\n")
  expect(t.frame()).toContain("Changed it.")
})

test("/commit drafts a message from the session's files, and commits only those on confirm", async () => {
  t = await tui([
    { chunks: [toolCall(0, "c1", "write", JSON.stringify({ path: "notes.md", content: "# notes\n" }))] },
    { chunks: [delta({ content: "Wrote notes." })] },
    { chunks: [delta({ content: "```\nAdd notes file\n```" })] },
  ])
  const git = (...a: string[]) => Bun.spawnSync(["git", "-C", t!.cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a])
  git("add", "hello.txt")
  git("commit", "-q", "-m", "Initial")
  Bun.write(`${t.cwd}/unrelated.txt`, "not mine\n")
  t.app.engine.mode = "edit"
  await t.input.typeText("write notes")
  t.input.pressEnter()
  expect(await t.until("Wrote notes.")).toBe(true)
  await t.input.typeText("/commit")
  t.input.pressEnter()
  expect(await t.until("Commit 1 file?")).toBe(true)
  expect(t.frame()).toContain("Add notes file")
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "t"
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "t@t"
  t.input.pressEnter()
  expect(await t.until("committed")).toBe(true)
  const log = git("log", "--format=%s", "--name-only", "-1").stdout.toString()
  expect(log).toContain("Add notes file")
  expect(log).toContain("notes.md")
  expect(log).not.toContain("unrelated.txt")
})

test("the question card: pick by number, multiple with space, ask back — and the model gets it all", async () => {
  t = await tui([
    {
      chunks: [
        toolCall(
          0,
          "q1",
          "ask_user",
          JSON.stringify({
            why: "Before I start.",
            questions: [
              { header: "DB", question: "Which database?", options: [{ label: "SQLite" }, { label: "PostgreSQL", recommended: true, description: "the server one" }] },
              { header: "Layers", question: "Which layers?", multiple: true, options: ["API", "CLI", "Web"] },
              { header: "Deploy", question: "Where?", options: ["Docker", "Bare"] },
            ],
          }),
        ),
      ],
    },
    { chunks: [delta({ content: "Docker adds a minute. Asking again." })] },
  ])
  await t.input.typeText("plan it")
  t.input.pressEnter()
  expect(await t.until("Which database?")).toBe(true)
  const f = t.frame()
  expect(f).toContain("Before I start.")
  expect(f.indexOf("PostgreSQL (Recommended)")).toBeLessThan(f.indexOf("SQLite")) // recommended first
  expect(f).toContain("Something else…")
  expect(f).toContain("Ask back…")
  await t.input.typeText("1")
  expect(await t.until("Which layers?")).toBe(true)
  t.input.pressKey(" ")
  t.input.pressArrow("down")
  await t.settle()
  t.input.pressKey(" ")
  t.input.pressEnter()
  expect(await t.until("Where?")).toBe(true)
  for (let i = 0; i < 3; i++) t.input.pressArrow("down")
  await t.settle()
  t.input.pressEnter()
  await t.settle()
  await t.input.typeText("what does docker cost?")
  t.input.pressEnter()
  expect(await t.until("Asking again.")).toBe(true)
  const result = t.fake.requests[1].messages.at(-1).content as string
  expect(result).toContain("→ PostgreSQL (the one you recommended)")
  expect(result).toContain("→ API, CLI")
  expect(result).toContain('↩ counter-question: "what does docker cost?"')
})

test("esc dismisses the questions; the todo panel shows open work", async () => {
  t = await tui([
    { chunks: [toolCall(0, "t1", "todo", JSON.stringify({ todos: [{ content: "read the code", status: "completed" }, { content: "fix the bug", status: "in_progress" }, { content: "run tests", status: "pending" }] })), toolCall(1, "q1", "ask_user", '{"question":"Go on?","options":["yes","no"]}')] },
    { chunks: [delta({ content: "Carrying on." })] },
  ])
  await t.input.typeText("go")
  t.input.pressEnter()
  expect(await t.until("Go on?")).toBe(true)
  expect(t.frame()).toContain("todo 1/3")
  expect(t.frame()).toContain("▸ fix the bug")
  t.input.pressEscape()
  expect(await t.until("Carrying on.")).toBe(true)
  expect(t.fake.requests[1].messages.at(-1).content).toContain("dismissed")
})

test("@ lists files; tab takes one; the model receives the file", async () => {
  t = await tui([{ chunks: [delta({ content: "It says hello world." })] }])
  await t.input.typeText("what does @hel")
  expect(await t.until("hello.txt")).toBe(true)
  t.input.pressTab()
  await t.settle()
  expect(t.frame()).toContain("❯ what does @hello.txt")
  await t.input.typeText("say?")
  t.input.pressEnter()
  expect(await t.until("It says hello world.")).toBe(true)
  const user = t.fake.requests[0].messages.at(-1).content as string
  expect(user).toContain("what does @hello.txt say?")
  expect(user).toContain('<file path="hello.txt">\n1: hello world\n</file>')
  expect(t.frame()).toContain("attached hello.txt")
  expect(t.frame()).not.toContain("<file path")
})

test("/ fuzzy-lists commands; a custom command sends its expanded body", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs")
  const { join } = await import("node:path")
  const { paths } = await import("../../src/config/paths.ts")
  mkdirSync(join(paths.config, "commands"), { recursive: true })
  writeFileSync(join(paths.config, "commands", "explain.md"), "---\ndescription: explain a file\n---\nExplain $1 in one line.\n")
  t = await tui([{ chunks: [delta({ content: "A greeting." })] }])
  await t.input.typeText("/und")
  expect(await t.until("/undo")).toBe(true)
  for (let i = 0; i < 4; i++) t.input.pressBackspace()
  await t.input.typeText("/expl")
  expect(await t.until("explain a file")).toBe(true)
  t.input.pressTab()
  await t.input.typeText("hello.txt")
  t.input.pressEnter()
  expect(await t.until("A greeting.")).toBe(true)
  expect(t.fake.requests[0].messages.at(-1).content).toContain("Explain hello.txt in one line.")
  expect(t.frame()).toContain("┃ /explain hello.txt")
})

test("!command runs at once and its output goes with the next prompt", async () => {
  t = await tui([{ chunks: [delta({ content: "Seen it." })] }])
  await t.input.typeText("!echo from-the-shell")
  t.input.pressEnter()
  expect(await t.until("goes to the model with your next message")).toBe(true)
  expect(t.frame()).toContain("! echo from-the-shell")
  await t.input.typeText("did you see that?")
  t.input.pressEnter()
  expect(await t.until("Seen it.")).toBe(true)
  const user = t.fake.requests[0].messages.at(-1).content as string
  expect(user).toContain('<shell command="echo from-the-shell">')
  expect(user).toContain("from-the-shell")
})

test("thinking stops the clock when the model starts a call, even if the call then waits for approval", async () => {
  t = await tui([
    { chunks: [delta({ reasoning_content: "I should write a file." }), toolCall(0, "c1", "bash", '{"command":"echo x > y.txt"}')] },
    { chunks: [delta({ content: "done" })] },
  ])
  await t.input.typeText("go")
  t.input.pressEnter()
  expect(await t.until("Allow once")).toBe(true)
  await Bun.sleep(1200)
  await t.settle()
  expect(t.frame()).toMatch(/Thought for 0\.\ds · ~\d+ tokens?/)
  await t.input.typeText("n")
  expect(await t.until("done")).toBe(true)
})

test("pasting an image's path (quoted, as a file manager does) inserts an @reference", async () => {
  t = await tui([])
  await Bun.write(`${t.cwd}/my shot.png`, "x")
  await t.input.pasteBracketedText(`'${t.cwd}/my shot.png'`)
  await t.settle()
  expect(t.frame()).toContain(`@${t.cwd}/my\\ shot.png`)
})

test("the plan card: the plan shown as markdown; a approves and the status bar says edit", async () => {
  t = await tui([
    { chunks: [toolCall(0, "w1", "write", JSON.stringify({ path: ".agent/plans/2026-09-29-x.md", content: "# The plan\n\n## Changes\n- **one** thing\n" }))] },
    { chunks: [toolCall(0, "x1", "plan_submit", '{"path":".agent/plans/2026-09-29-x.md"}')] },
    { chunks: [delta({ content: "Implementing now." })] },
  ])
  await t.input.typeText("/plan tidy up")
  t.input.pressEnter()
  expect(await t.until("Approve — edit mode")).toBe(true)
  expect(await t.until("one thing")).toBe(true) // markdown is parsed off-thread; it draws a moment later
  const f = t.frame()
  expect(f).toContain("plan · .agent/plans/2026-09-29-x.md")
  const card = f.slice(f.indexOf("╭─ plan ·"))
  expect(card).toContain("The plan")
  expect(card).toContain("one thing")
  expect(card).not.toContain("**one**") // rendered, not raw
  expect(f).toContain(" plan · fake/coder")
  await t.input.typeText("a")
  expect(await t.until("Implementing now.")).toBe(true)
  expect(t.frame()).toContain(" edit · fake/coder")
})

test("thinking is one line — its text is not shown; the provider's count of it is; ctrl+r opens it", async () => {
  t = await tui([
    {
      chunks: [
        delta({ reasoning_content: "First I weigh the options.\nThen the SECRET-INNER-STEP." }),
        delta({ content: "The answer." }),
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 60, completion_tokens_details: { reasoning_tokens: 1234 } } },
      ],
    },
  ])
  await t.input.typeText("go")
  t.input.pressEnter()
  expect(await t.until("The answer.")).toBe(true)
  expect(await t.until("· 1,234 tokens")).toBe(true)
  expect(t.frame()).toMatch(/Thought for \d+\.\ds · 1,234 tokens/)
  expect(t.frame()).not.toContain("SECRET-INNER-STEP")
  t.input.pressKey("r", { ctrl: true })
  expect(await t.until("SECRET-INNER-STEP")).toBe(true)
})

test("while it thinks: the thought says only Thinking…; the line at the bottom has the verb, the task's time and tokens", async () => {
  t = await tui([{ gapMs: 1500, chunks: [delta({ reasoning_content: "Weighing it up: HIDDEN-WHILE-THINKING and more words here." }), delta({ content: "Done thinking." })] }])
  await t.input.typeText("go")
  t.input.pressEnter()
  expect(await t.until("~15 tokens")).toBe(true)
  const frame = t.frame()
  expect(frame).toMatch(/^\s*Thinking\.{1,3}\s*$/m)
  expect(frame).toMatch(/(pondering|contemplating|musing|cogitating|ruminating|deliberating|mulling|reflecting|reasoning|analyzing|synthesizing|formulating)… \d+s · ~15 tokens · esc to stop/)
  expect(frame).not.toContain("HIDDEN-WHILE-THINKING")
  expect(await t.until("Done thinking.")).toBe(true)
  expect(t.frame()).toMatch(/Thought for \d\.\ds · ~15 tokens/)
})

test("the line at the bottom counts the whole task: the clock and the tokens go on across steps", async () => {
  t = await tui([
    { chunks: [toolCall(0, "c1", "list", "{}"), { choices: [], usage: { prompt_tokens: 10, completion_tokens: 40 } }] },
    { gapMs: 1200, chunks: [delta({ content: "Half" }), delta({ content: " way." }), { choices: [], usage: { prompt_tokens: 20, completion_tokens: 25 } }] },
  ])
  await t.input.typeText("go")
  t.input.pressEnter()
  // The first step's 40 tokens, then the second's reply growing on top of them.
  expect(await t.until("Half")).toBe(true)
  // The spinner line redraws on its own tick, slower than the reply's text: on a slow machine the
  // frame that first shows "Half" can still carry the line from before. The 1.2 s gap holds this
  // state, so wait for the line within it rather than reading the first frame.
  const counted = /writing… \d+s · ~4\d tokens · esc to stop/
  for (let i = 0; i < 20 && !counted.test(t.frame()); i++) await Bun.sleep(50), await t.settle()
  expect(t.frame()).toMatch(counted)
  expect(await t.until("way.")).toBe(true)
  for (let i = 0; i < 60 && t.frame().includes("esc to stop"); i++) await Bun.sleep(100), await t.settle()
  expect(t.frame()).not.toContain("esc to stop")
  expect(t.view.taskTokens()).toEqual({ n: 65, estimated: false })
})

test("many reasoning blocks do not pile up resize listeners (Node's leak warning printed over the screen)", async () => {
  const turn = (n: number) => ({ chunks: [delta({ reasoning_content: `thinking ${n}` }), delta({ content: `answer ${n}` })] })
  t = await tui(Array.from({ length: 15 }, (_, i) => turn(i)))
  const before = t.setup.renderer.listenerCount("resize")
  for (let i = 0; i < 15; i++) {
    await t.input.typeText(`q${i}`)
    t.input.pressEnter()
    expect(await t.until(`answer ${i}`)).toBe(true)
  }
  expect(t.setup.renderer.listenerCount("resize")).toBeLessThanOrEqual(before + 1)
}, 60_000)

test("/review sends the session's diff with the review brief in plan mode, then the mode is back", async () => {
  t = await tui([
    { chunks: [toolCall(0, "c1", "read", '{"path":"hello.txt"}')] },
    { chunks: [toolCall(0, "c2", "edit", JSON.stringify({ path: "hello.txt", old: "world", new: "there" }))] },
    { chunks: [delta({ content: "Changed." })] },
    { chunks: [delta({ content: "No findings." })] },
  ])
  t.app.engine.mode = "edit"
  await t.input.typeText("change it")
  t.input.pressEnter()
  expect(await t.until("Changed.")).toBe(true)
  await t.input.typeText("/review")
  t.input.pressEnter()
  expect(await t.until("No findings.")).toBe(true)
  const req = t.fake.requests.at(-1)
  expect(req.messages[0].content).toContain("Permission mode: plan")
  const user = req.messages.at(-1).content as string
  expect(user).toContain("Findings first, ordered by severity")
  expect(user).toContain("+hello there")
  expect(t.frame()).toContain("┃ /review")
  expect(t.app.engine.mode).toBe("edit")
})

test("/decide records a decision; /tasks shows the board", async () => {
  t = await tui([])
  const { mkdirSync } = await import("node:fs")
  mkdirSync(`${t.cwd}/.agent`)
  await t.input.typeText("/decide Storage: SQLite, one file")
  t.input.pressEnter()
  expect(await t.until("recorded:")).toBe(true)
  expect(await Bun.file(`${t.cwd}/.agent/decisions.md`).text()).toContain("**Decision:** SQLite, one file")
  await t.input.typeText("/tasks")
  t.input.pressEnter()
  expect(await t.until("the board is empty")).toBe(true)
})

test("a skill is a /command: listed in the palette, and it sends the skill with the instruction", async () => {
  const { mkdirSync, writeFileSync, rmSync } = await import("node:fs")
  const { join } = await import("node:path")
  const { paths } = await import("../../src/config/paths.ts")
  const dir = join(paths.config, "skills", "tidy-imports")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "SKILL.md"), "---\nname: tidy-imports\ndescription: Use when imports need sorting.\n---\n\nSort imports alphabetically.\n")
  t = await tui([{ chunks: [delta({ content: "Sorted." })] }])
  await t.input.typeText("/tidy")
  expect(await t.until("Use when imports need sorting.")).toBe(true)
  t.input.pressTab()
  await t.input.typeText("in app.ts")
  t.input.pressEnter()
  expect(await t.until("Sorted.")).toBe(true)
  const sent = t.fake.requests[0].messages.at(-1).content
  expect(sent).toContain('invoked the "tidy-imports" skill')
  expect(sent).toContain("Sort imports alphabetically.")
  expect(sent).toContain("The user's instruction with it: in app.ts")
  // the skills list was in the system prompt the session started with
  expect(t.fake.requests[0].messages[0].content).toContain("- tidy-imports: Use when imports need sorting.")
  rmSync(join(paths.config, "skills"), { recursive: true, force: true })
})

test("/personality picks one and remembers it; /memory lists entries, and forgets or changes one", async () => {
  const { readFileSync, rmSync, existsSync } = await import("node:fs")
  const { join } = await import("node:path")
  const { paths } = await import("../../src/config/paths.ts")
  t = await tui([])
  await t.input.typeText("/personality pirate")
  t.input.pressEnter()
  expect(await t.until("personality: one of none, concise")).toBe(true)
  await t.input.typeText("/personality formal")
  t.input.pressEnter()
  expect(await t.until("personality: formal")).toBe(true)
  expect(readFileSync(join(paths.config, "config.yaml"), "utf8")).toContain("personality: formal")
  await t.input.typeText("/memory")
  t.input.pressEnter()
  expect(await t.until("nothing remembered yet")).toBe(true)
  t.app.memory.apply("user", [{ action: "add", content: "The user is called Ana." }, { action: "add", content: "Ana likes tabs." }])
  await t.input.typeText("/memory")
  t.input.pressEnter()
  expect(await t.until("[user] The user is called Ana.")).toBe(true)
  await t.input.typeText("tabs")
  await t.settle()
  t.input.pressEnter()
  expect(await t.until("Forget it")).toBe(true)
  t.input.pressEnter()
  expect(await t.until("user: forgotten")).toBe(true)
  expect(t.app.memory.entries("user")).toEqual(["The user is called Ana."])
  if (existsSync(join(paths.config, "config.yaml"))) rmSync(join(paths.config, "config.yaml"))
  rmSync(t.app.memory.file("user"), { force: true })
}, 30_000)

test("MCP: a server's prompt is a /server:prompt command; /mcp lists the server; its tool line fits at 80 columns", async () => {
  const { join } = await import("node:path")
  const server = join(import.meta.dir, "..", "fixtures", "mcp", "server.ts")
  t = await tui(
    [
      { chunks: [toolCall(0, "c1", "mcp__fix__echo", '{"text":"hi"}')] },
      { chunks: [delta({ content: "Greeted." })] },
    ],
    { width: 80, height: 24 },
    `mode: unrestricted\nmcp:\n  fix:\n    command: ["${process.execPath}", "${server}"]\n`,
  )
  await t.app.mcpReady
  await t.input.typeText("/fix:gr")
  expect(await t.until("Greet someone")).toBe(true)
  t.input.pressTab()
  await t.input.typeText("Jaro")
  t.input.pressEnter()
  expect(await t.until("Greeted.")).toBe(true)
  expect(t.fake.requests[0].messages.at(-1).content).toContain("Say hello to Jaro.")
  expect(t.frame()).toContain("🔌")
  for (const line of t.frame().split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80)
  await t.input.typeText("/mcp")
  t.input.pressEnter()
  expect(await t.until("● fix  local")).toBe(true)
}, 20_000)

test("MCP: a server's prompt cannot attach a file by naming it with @", async () => {
  const { join } = await import("node:path")
  const { mkdtempSync, writeFileSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const server = join(import.meta.dir, "..", "fixtures", "mcp", "server.ts")
  const secret = join(mkdtempSync(join(tmpdir(), "ph-secret-")), "id_key")
  writeFileSync(secret, "PRIVATE-KEY-MATERIAL")
  t = await tui([{ chunks: [delta({ content: "Looked." })] }], { width: 100, height: 30 }, `mcp:\n  fix:\n    command: ["${process.execPath}", "${server}"]\n`)
  await t.app.mcpReady
  await t.input.typeText(`/fix:peek ${secret}`)
  t.input.pressEnter()
  expect(await t.until("Looked.")).toBe(true)
  const sent = JSON.stringify(t.fake.requests[0].messages.at(-1))
  expect(sent).toContain("Look at @")
  expect(sent).not.toContain("PRIVATE-KEY-MATERIAL")
}, 20_000)

test("voice: ctrl+t records, silence ends it, what was said lands in the prompt; /speak and /voice", async () => {
  const { join } = await import("node:path")
  const stt = Bun.serve({ port: 0, fetch: () => Response.json({ text: "Fix the failing test." }) })
  const mic = join(import.meta.dir, "..", "fixtures", "voice", "mic.ts")
  try {
    t = await tui([], { width: 100, height: 30 }, `voice:\n  stt: { base_url: "http://127.0.0.1:${stt.port}/v1" }\n  tts: { base_url: "http://127.0.0.1:${stt.port}/v1" }\n  recorder_command: ["${process.execPath}", "${mic}", "1"]\n  silence_seconds: 0.4\n`)
    expect(t.frame()).toContain("🎤 Ctrl+T")
    t.input.pressKey("t", { ctrl: true })
    expect(await t.until("● REC")).toBe(true)
    expect(await t.until("❯ Fix the failing test.", 8000)).toBe(true)
    expect(t.fake.requests).toHaveLength(0) // drafted, not sent
    for (let i = 0; i < 25; i++) t.input.pressBackspace()
    await t.input.typeText("/speak")
    t.input.pressEnter()
    expect(await t.until("replies are spoken")).toBe(true)
    expect(await t.until("🔊 on")).toBe(true)
    await t.input.typeText("/voice")
    t.input.pressEnter()
    expect(await t.until("input:  openai · http://127.0.0.1")).toBe(true)
  } finally {
    stt.stop(true)
  }
}, 20_000)

test("/release: the plan, then the dialog; Release commits and tags, pushing nothing; /changelog sends the commits", async () => {
  const { writeFileSync } = await import("node:fs")
  const { join } = await import("node:path")
  const { git } = await import("../../src/git/run.ts")
  t = await tui([{ chunks: [delta({ content: "Updated the changelog." })] }])
  const d = t.cwd
  writeFileSync(join(d, "package.json"), '{ "name": "demo", "version": "0.1.0" }\n')
  writeFileSync(join(d, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n### Added\n- Things.\n")
  for (const a of [["config", "user.email", "t@e"], ["config", "user.name", "T"], ["config", "commit.gpgsign", "false"], ["config", "tag.gpgsign", "false"], ["add", "package.json", "CHANGELOG.md", "hello.txt"], ["commit", "-q", "-m", "Add the demo"]]) git(d, a)
  ;(t.app.project as any).gitRoot = d
  await t.input.typeText("/changelog")
  t.input.pressEnter()
  expect(await t.until("Updated the changelog.")).toBe(true)
  expect(t.fake.requests[0].messages.at(-1).content).toContain("- Add the demo")
  await t.input.typeText("/release minor")
  t.input.pressEnter()
  expect(await t.until("Release v0.2.0?")).toBe(true)
  expect(t.frame()).toContain("package.json: 0.1.0 → 0.2.0")
  t.input.pressEnter()
  expect(await t.until("nothing pushed")).toBe(true)
  expect(git(d, ["tag", "-l", "--format=%(contents)", "v0.2.0"]).out).toBe("demo 0.2.0\n\n### Added\n- Things.")
})

test("asking about an edit shows the change itself, not only the file", async () => {
  t = await tui([
    { chunks: [toolCall(0, "r1", "read", '{"path":"hello.txt"}')] },
    { chunks: [toolCall(0, "e1", "edit", JSON.stringify({ path: "hello.txt", old: "hello world", new: "hello lembas" }))] },
    { chunks: [delta({ content: "Changed." })] },
  ])
  await t.input.typeText("change it")
  t.input.pressEnter()
  expect(await t.until("Allow once")).toBe(true)
  const f = t.frame()
  expect(f).toContain("hello.txt +1 −1")
  expect(f).toMatch(/-\s*hello world/)
  expect(f).toMatch(/\+\s*hello lembas/)
  expect(await Bun.file(`${t.cwd}/hello.txt`).text()).toBe("hello world\n") // nothing written while asking
  await t.input.typeText("y")
  expect(await t.until("Changed.")).toBe(true)
  expect(await Bun.file(`${t.cwd}/hello.txt`).text()).toBe("hello lembas\n")
})

test("a change that cannot apply says so while asking", async () => {
  t = await tui([
    { chunks: [toolCall(0, "r1", "read", '{"path":"hello.txt"}')] },
    { chunks: [toolCall(0, "e1", "edit", JSON.stringify({ path: "hello.txt", old: "not there", new: "x" }))] },
    { chunks: [delta({ content: "ok" })] },
  ])
  await t.input.typeText("change it")
  t.input.pressEnter()
  expect(await t.until("Allow once")).toBe(true)
  expect(t.frame()).toContain("this will fail:")
})

test("/copy copies the last reply and says how", async () => {
  t = await tui([{ chunks: [delta({ content: "## Plan\n\nUse **ws**." })] }])
  await t.input.typeText("go")
  t.input.pressEnter()
  expect(await t.until("Use ws.")).toBe(true)
  await t.input.typeText("/copy")
  t.input.pressEnter()
  expect(await t.until("copied 20 characters")).toBe(true)
})

test("dragging over a reply copies what it selects", async () => {
  t = await tui([{ chunks: [delta({ content: "SELECTME please copy this line" })] }])
  await t.input.typeText("go")
  t.input.pressEnter()
  expect(await t.until("SELECTME")).toBe(true)
  const rows = t.frame().split("\n")
  const y = rows.findIndex((l) => l.includes("SELECTME"))
  const x = rows[y]!.indexOf("SELECTME")
  await t.setup.mockMouse.drag(x, y, x + 8, y) // both ends are in: 9 cells, "SELECTME "
  expect(await t.until("copied 9 characters")).toBe(true)
  // In the status bar, not the conversation; and gone again by itself.
  expect(t.frame().split("\n").filter((l) => l.trim()).at(-1)).toContain("copied 9 characters")
  expect(t.view.state.items.some((i) => JSON.stringify(i).includes("copied 9"))).toBe(false)
})

test("copying while the model thinks does not split the thinking block", async () => {
  t = await tui([
    { chunks: [delta({ content: "FIRST answer" })] },
    { chunks: [delta({ reasoning_content: "weighing it" }), ...Array.from({ length: 40 }, () => delta({ reasoning_content: " more" })), delta({ content: "SECOND answer" })], gapMs: 30 },
  ])
  await t.input.typeText("one")
  t.input.pressEnter()
  expect(await t.until("FIRST answer")).toBe(true)
  await t.input.typeText("two")
  t.input.pressEnter()
  // While the thought streams: copy the first answer.
  const end = Date.now() + 3000
  while (!t.view.state.items.some((i) => i.kind === "reasoning" && i.streaming) && Date.now() < end) await t.settle(20)
  await t.input.typeText("/copy 1")
  t.input.pressEnter()
  expect(await t.until("copied 12 characters")).toBe(true)
  expect(await t.until("SECOND answer")).toBe(true)
  expect(t.view.state.items.filter((i) => i.kind === "reasoning")).toHaveLength(1)
  expect(t.view.state.items.some((i) => JSON.stringify(i).includes("copied"))).toBe(false)
})

test("/icons plain swaps every picture for a one-column symbol, and is saved", async () => {
  t = await tui([{ chunks: [toolCall(0, "r1", "read", '{"path":"hello.txt"}')] }, { chunks: [delta({ content: "ok" })] }])
  await t.input.typeText("/icons plain")
  t.input.pressEnter()
  expect(await t.until("icons: plain")).toBe(true)
  await t.input.typeText("go")
  t.input.pressEnter()
  expect(await t.until("┊ » read")).toBe(true)
  expect(t.frame()).not.toContain("📖")
  const { readFileSync } = await import("node:fs")
  const { join } = await import("node:path")
  const { paths } = await import("../../src/config/paths.ts")
  expect(readFileSync(join(paths.config, "config.yaml"), "utf8")).toContain("icons: plain")
})

test("the frame rate follows every capability answer, not just the first", async () => {
  const { frameRateFor } = await import("../../src/tui/index.tsx")
  const r = { targetFps: 30, maxFps: 60 }
  frameRateFor(r, { sync: false }) // an early answer, before the one about mode 2026
  expect(r).toEqual({ targetFps: 12, maxFps: 12 })
  frameRateFor(r, { sync: true }) // kitty, WezTerm, foot… once their answer arrives
  expect(r).toEqual({ targetFps: 30, maxFps: 60 })
})

test("/terminal says what was found out about the terminal", async () => {
  t = await tui([])
  await t.input.typeText("/terminal")
  t.input.pressEnter()
  // The test renderer asks nothing of a terminal; the frame rate and mouse are said regardless.
  expect(await t.until("frame rate:")).toBe(true)
})

test("/checkpoint saves the files; /checkpoints goes back to one and tells the model", async () => {
  t = await tui([])
  await t.input.typeText("/checkpoint before the rewrite")
  t.input.pressEnter()
  expect(await t.until("checkpoint saved: before the rewrite")).toBe(true)
  await Bun.write(`${t.cwd}/hello.txt`, "rewritten\n")
  await t.input.typeText("/checkpoints")
  t.input.pressEnter()
  expect(await t.until("Checkpoints")).toBe(true)
  t.input.pressEnter()
  expect(await t.until("1 file differ")).toBe(true)
  expect(t.frame()).toContain("Go back to it")
  t.input.pressEnter()
  expect(await t.until('back at "before the rewrite" — restored 1 file')).toBe(true)
  expect(await Bun.file(`${t.cwd}/hello.txt`).text()).toBe("hello world\n")
  expect(t.app.engine.pendingContext.at(-1)).toContain('restored the files to the checkpoint "before the rewrite"')
  expect(t.app.snapshots!.checkpoints().map((c) => c.label)).toEqual(['before going back to "before the rewrite"', "before the rewrite"])
})

test("/branch makes and switches; the status bar shows the branch; the list marks the current one", async () => {
  t = await tui([])
  const sh = (...a: string[]) => Bun.spawnSync(["git", "-C", t!.cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a])
  sh("add", "hello.txt")
  sh("commit", "-q", "-m", "first")
  await t.input.typeText("/branch feature/greeting")
  t.input.pressEnter()
  expect(await t.until("made feature/greeting from")).toBe(true)
  expect(await t.until("@feature/greeting")).toBe(true)
  expect(t.app.engine.pendingContext.at(-1)).toContain("switched the repository to the branch feature/greeting")
  await t.input.typeText("/branch")
  t.input.pressEnter()
  expect(await t.until("Branches")).toBe(true)
  expect(t.frame()).toContain("New branch…")
  expect(t.frame()).toMatch(/feature\/greeting/)
})

test("a long edit's diff shows short in the transcript — and parses — then whole with ctrl+o", async () => {
  t = await tui([
    { chunks: [toolCall(0, "w1", "write", JSON.stringify({ path: "long.txt", content: Array.from({ length: 50 }, (_, i) => `row ${i + 1}`).join("\n") + "\n" }))] },
    { chunks: [delta({ content: "Wrote it." })] },
  ], { width: 100, height: 60 })
  t.app.engine.mode = "edit"
  await t.input.typeText("write long.txt")
  t.input.pressEnter()
  expect(await t.until("Wrote it.")).toBe(true)
  expect(t.frame()).not.toContain("Error parsing diff")
  expect(t.frame()).toContain("row 1")
  expect(t.frame()).toMatch(/… \d+ more lines \(ctrl\+o\)/)
  expect(t.frame()).not.toContain("row 50")
  t.input.pressKey("o", { ctrl: true })
  expect(await t.until("row 50")).toBe(true)
  expect(t.frame()).not.toContain("more lines (ctrl+o)")
  expect(t.frame()).not.toContain("Error parsing diff")
})

for (const size of [{ width: 100, height: 30 }, { width: 80, height: 24 }])
  test(`a long command to approve stays on screen at ${size.width}x${size.height}: its purpose, a few rows, the choices; ctrl+o shows the rest`, async () => {
    const command = Array.from({ length: 60 }, (_, i) => `echo step-${i + 1}`).join("\n")
    t = await tui([{ chunks: [toolCall(0, "c1", "bash", JSON.stringify({ command, description: "Print every step so we can see where the build stops" }))] }, { chunks: [delta({ content: "done" })] }], size)
    await t.input.typeText("go")
    t.input.pressEnter()
    expect(await t.until("Allow once")).toBe(true)
    const rows = t.frame().split("\n")
    expect(rows.filter((l) => l.trim()).at(-1)).toContain("fake/coder") // the status bar is still the last row
    expect(t.frame()).toContain("Print every step so we can see where the build stops")
    expect(t.frame()).toContain("echo step-1")
    expect(t.frame()).not.toContain("echo step-60")
    expect(t.frame()).toMatch(/… \d+ more lines — ctrl\+o shows all/)
    t.input.pressKey("o", { ctrl: true })
    await t.settle()
    for (let i = 0; i < 12; i++) t.input.pressKey("\u001b[6~") // PageDown
    const end = await t.until("echo step-60", 3000)
    if (!end) console.error(t.frame())
    expect(end).toBe(true)
    expect(t.frame()).toContain("Allow once")
    expect(t.frame().split("\n").filter((l) => l.trim()).at(-1)).toContain("fake/coder")
    await t.input.typeText("y")
    expect(await t.until("done")).toBe(true)
  }, 20_000)

test("/settings: pick a setting, a value and where it holds; the status bar follows; global is written", async () => {
  t = await tui([])
  await t.input.typeText("/settings")
  t.input.pressEnter()
  expect(await t.until("Settings")).toBe(true)
  await t.input.typeText("titles")
  await t.settle()
  t.input.pressEnter()
  expect(await t.until("titles — now model")).toBe(true)
  t.input.pressArrow("down")
  await t.settle()
  t.input.pressEnter()
  expect(await t.until("— where?")).toBe(true)
  t.input.pressArrow("down")
  await t.settle()
  t.input.pressEnter()
  expect(await t.until("titles = prompt in the global config")).toBe(true)
  expect(await Bun.file(`${process.env.LEMBAS_HOME}/.config/lembas/config.yaml`).text()).toContain("titles: prompt")
  // A number is typed: the first row takes what was typed.
  await t.input.typeText("/settings limits.steps")
  t.input.pressEnter()
  expect(await t.until("limits.steps — now")).toBe(true)
  await t.input.typeText("40")
  await t.settle()
  expect(t.frame()).toContain('set to "40"')
  t.input.pressEnter()
  expect(await t.until("— where?")).toBe(true)
  t.input.pressEnter()
  expect(await t.until("limits.steps = 40 for this session")).toBe(true)
  expect(t.app.engine.o.maxSteps).toBe(40)
}, 30_000)

test("the agent changes the effort when asked: the approval says so, and the status bar shows it", async () => {
  t = await tui([
    { chunks: [toolCall(0, "c1", "settings", '{"action":"set","key":"effort","value":"high","purpose":"You asked me to think harder"}')] },
    { chunks: [delta({ content: "Thinking harder now." })] },
  ])
  await t.input.typeText("think harder from now on")
  t.input.pressEnter()
  expect(await t.until("Allow once")).toBe(true)
  expect(t.frame()).toContain("You asked me to think harder")
  await t.input.typeText("y")
  expect(await t.until("Thinking harder now.")).toBe(true)
  expect(t.app.engine.effort).toBe("high")
  expect(t.frame()).toContain("fake/coder · high")
})

test("enter while it works: the message waits above the box, then goes in at the next step, shown where it went", async () => {
  t = await tui([
    { gapMs: 400, chunks: [delta({ content: "Looking." }), toolCall(0, "c1", "list", "{}")] },
    { chunks: [delta({ content: "Noted the change." }, "stop")] },
  ])
  await t.input.typeText("go")
  t.input.pressEnter()
  expect(await t.until("Looking.")).toBe(true)
  await t.input.typeText("use b instead")
  t.input.pressEnter()
  expect(await t.until("↳ queued use b instead · at the next step")).toBe(true)
  expect(await t.until("Noted the change.")).toBe(true)
  await t.settle()
  const f = t.frame()
  expect(f).toContain("↳ sent while it worked")
  expect(f).not.toContain("↳ queued")
  expect(f.indexOf("use b instead")).toBeLessThan(f.indexOf("Noted the change."))
  expect(JSON.stringify(t.fake.requests[1].messages.at(-1))).toContain("use b instead")
})

test("a command refused while it works keeps its text in the box", async () => {
  t = await tui([{ gapMs: 400, chunks: [delta({ content: "Slow" }), delta({ content: " reply." }, "stop")] }])
  await t.input.typeText("go")
  t.input.pressEnter()
  expect(await t.until("Slow")).toBe(true)
  await t.input.typeText("/undo")
  t.input.pressEnter()
  expect(await t.until("wait for the reply to finish")).toBe(true)
  expect(t.frame()).toMatch(/❯\s*\/undo/)
})

test("esc mid-reply, then ctrl+g: it continues, and the model sees what it had already written", async () => {
  t = await tui([
    { gapMs: 300, chunks: [delta({ content: "Step one is done. " }), delta({ content: "Step two" }), delta({ content: " is next." }, "stop")] },
    { chunks: [delta({ content: "Step two is done too." }, "stop")] },
  ])
  await t.input.typeText("do the steps")
  t.input.pressEnter()
  expect(await t.until("Step one is done.")).toBe(true)
  t.input.pressEscape()
  expect(await t.until("cancelled")).toBe(true)
  await t.settle()
  t.input.pressKey("g", { ctrl: true })
  expect(await t.until("↻ continue")).toBe(true)
  expect(await t.until("Step two is done too.")).toBe(true)
  const sent = t.fake.requests[1].messages as { role: string; content: unknown }[]
  // What it had said before the stop, then the request to carry on.
  expect(sent.at(-2)).toMatchObject({ role: "assistant" })
  expect(JSON.stringify(sent.at(-2)!.content)).toContain("Step one is done.")
  expect(JSON.stringify(sent.at(-1)!.content)).toContain("Continue from where you stopped")
})

test("/continue with nothing to continue, and while it works, says so", async () => {
  t = await tui([{ gapMs: 300, chunks: [delta({ content: "Working" }), delta({ content: " on it." }, "stop")] }])
  await t.input.typeText("/continue")
  t.input.pressEnter()
  expect(await t.until("nothing to continue yet")).toBe(true)
  await t.input.typeText("go")
  t.input.pressEnter()
  expect(await t.until("Working")).toBe(true)
  t.input.pressKey("g", { ctrl: true })
  expect(await t.until("it is still working")).toBe(true)
})

test("/agents lists the subagents; /agents new writes a starter; /agents <name> <task> hands it to the model", async () => {
  t = await tui([{ chunks: [delta({ content: "Handing it over." }, "stop")] }])
  await t.input.typeText("/agents")
  t.input.pressEnter()
  expect(await t.until("explore (builtin)")).toBe(true)
  expect(t.frame()).toContain("general (builtin)")
  const name = `scout${Date.now() % 100000}`
  await t.input.typeText(`/agents new ${name}`)
  t.input.pressEnter()
  expect(await t.until(`${name}.md`)).toBe(true)
  const file = Bun.file(`${process.env.LEMBAS_HOME}/.config/lembas/agents/${name}.md`)
  expect(await file.text()).toContain(`You are the ${name} subagent`)
  await t.input.typeText("/agents explore where is the config loaded")
  t.input.pressEnter()
  expect(await t.until("Handing it over.")).toBe(true)
  expect(JSON.stringify(t.fake.requests[0].messages.at(-1))).toContain('agent: \\"explore\\"')
})

test("while the server reads a long prompt: the line at the bottom says how far it is, then the reply takes over", async () => {
  const pp = (processed: number, ms: number) => ({ choices: [{ index: 0, delta: { role: "assistant", content: null }, finish_reason: null }], prompt_progress: { total: 140000, cache: 10000, processed, time_ms: ms } })
  t = await tui([{ gapMs: 500, chunks: [pp(0, 0), pp(80000, 160000), delta({ content: "Read it all." }, "stop")] }])
  await t.input.typeText("go")
  t.input.pressEnter()
  expect(await t.until("reading the prompt 64% · 90k of 140k · ~1m 40s left")).toBe(true)
  expect(await t.until("Read it all.")).toBe(true)
  await t.settle()
  expect(t.frame()).not.toContain("reading the prompt")
})

test("a mouse wheel that arrives as a burst of ↑ scrolls the transcript; one ↑ still walks history", async () => {
  t = await tui([{ chunks: [delta({ content: Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n\n") }, "stop")] }], { width: 80, height: 24 })
  await t.input.typeText("first prompt")
  t.input.pressEnter()
  expect(await t.until("line 59")).toBe(true)
  await t.settle()
  const before = t.frame()
  // What a terminal not passing the mouse on sends for one notch: three ↑ at once.
  for (let i = 0; i < 3; i++) t.input.pressKey("ARROW_UP")
  await t.settle()
  const after = t.frame()
  expect(after).not.toBe(before)
  expect(after).not.toContain("❯ first prompt")
  // One ↑ on its own: the last prompt comes back, as before.
  await Bun.sleep(40)
  t.input.pressKey("ARROW_UP")
  await t.settle()
  expect(t.frame()).toContain("❯ first prompt")
})

test("↑ in an empty box walks the messages waiting to go in, newest first; ↓ walks back", async () => {
  t = await tui([{ gapMs: 600, chunks: [delta({ content: "Working" }), delta({ content: " on" }), delta({ content: " it." }, "stop")] }, { chunks: [delta({ content: "ok" }, "stop")] }])
  await t.input.typeText("go")
  t.input.pressEnter()
  expect(await t.until("Working")).toBe(true)
  for (const m of ["fix alpha", "fix beta"]) {
    await t.input.typeText(m)
    t.input.pressEnter()
  }
  expect(await t.until("↳ queued fix beta")).toBe(true)
  const press = async (k: "ARROW_UP" | "ARROW_DOWN") => {
    await Bun.sleep(30)
    t!.input.pressKey(k)
    await t!.settle()
  }
  await press("ARROW_UP")
  expect(t.frame()).toContain("❯ fix beta")
  expect(t.frame()).not.toContain("↳ queued fix beta")
  expect(t.app.engine.queued).toBe(1)
  await press("ARROW_UP")
  expect(t.frame()).toContain("❯ fix alpha")
  expect(t.frame()).toContain("↳ queued fix beta")
  await press("ARROW_DOWN")
  expect(t.frame()).toContain("❯ fix beta")
  await press("ARROW_DOWN")
  expect(t.app.engine.queued).toBe(2)
  expect(t.frame()).toContain("↳ queued fix alpha")
  expect(t.frame()).toContain("↳ queued fix beta")
})

test("ctrl+↑ scrolls the transcript three lines; pgup half a screen", async () => {
  t = await tui([{ chunks: [delta({ content: Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n\n") }, "stop")] }], { width: 80, height: 24 })
  await t.input.typeText("go")
  t.input.pressEnter()
  expect(await t.until("line 59")).toBe(true)
  await t.settle()
  const top = () => t!.frame().split("\n").find((l) => /line \d+/.test(l))
  const first = top()
  t.input.pressKey("ARROW_UP", { ctrl: true })
  await t.settle()
  expect(top()).not.toBe(first)
  expect(t.frame()).not.toContain("❯ go")
})

test("/sessions says how to delete, and ctrl+d deletes the session under the cursor", async () => {
  t = await tui([], { width: 100, height: 30 }, "", { store: true })
  const store = t.app.store!
  const root = t.app.project.root
  const said = store.createSession(root, "fake/coder")
  store.append(said.id, { role: "user", parts: [{ type: "text", text: "an old question" }] })
  store.setTitle(said.id, "An old question")
  // An empty one is not offered at all.
  store.createSession(root, "fake/coder")
  await t.input.typeText("/sessions")
  t.input.pressEnter()
  expect(await t.until("enter resume · ctrl+d delete")).toBe(true)
  expect(t.frame()).toContain("An old question")
  expect(t.frame().match(/ses_/g)).toBeNull()
  t.input.pressKey("d", { ctrl: true })
  expect(await t.until("Delete “An old question”?")).toBe(true)
  t.input.pressEnter()
  expect(await t.until("no other sessions in this project")).toBe(true)
  expect(store.session(said.id)).toBeUndefined()
})
