// Teams (harness spec 3.2.0, team.md) through the whole app: the lead adds a member that runs on the
// subagent machinery, its tools that change things answer the manager's refusal before anything is
// asked, the member's final reply comes back as a marked report that wakes the idle lead, and the
// size setting is said in a note. The rules themselves are conformance/team.json's.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp, type App } from "../src/app.ts"
import type { AskReply } from "../src/bus/index.ts"
import { paths } from "../src/config/paths.ts"
import { LOOP } from "../src/harness.ts"
import { teamLabel, teamText } from "../src/session/commands.ts"
import { delta, fakeProvider, toolCall, type Fake, type Scripted } from "./fake-provider.ts"

let fake: Fake | undefined
let app: App | undefined
afterEach(async () => {
  await app?.close()
  app = undefined
  fake?.stop()
})

const T = LOOP.team
const yes = { ask: async (): Promise<AskReply> => ({ kind: "once" }) }
const say = (text: string): Scripted => ({ chunks: [delta({ content: text }, "stop")] })
const call = (id: string, name: string, args: unknown): Scripted => ({ chunks: [toolCall(0, id, name, JSON.stringify(args)), delta({}, "tool_calls")] })
const system = (body: any): string => body.messages[0].content
const isMember = (body: any, name: string) => new RegExp(`You are "${name}" \\(s\\d+\\), a subagent`).test(system(body))
const lastUser = (body: any): string => {
  const u = [...body.messages].reverse().find((m: any) => m.role === "user")
  return typeof u.content === "string" ? u.content : u.content.map((p: any) => p.text ?? "").join("")
}
// A result as the model reads it, less its id line (context.md §1).
const toolResults = (body: any): string[] => body.messages.filter((m: any) => m.role === "tool").map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)).replace(/^\[#\d+\]\n/, ""))

function setup(answer: (body: any, n: number) => Scripted | undefined, config = "", spec = "{ context: 32768, parallel: 2 }") {
  fake = fakeProvider(answer)
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  fake:\n    type: webui\n    url: ${fake.url}\n    models:\n      fake/m: ${spec}\n`, { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), `model: fake/m\n${config}`)
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lembas-team-")))
  Bun.spawnSync(["git", "init", "-q", dir])
  return dir
}

async function until(what: () => boolean, ms = 10000) {
  const end = Date.now() + ms
  while (!what()) {
    if (Date.now() > end) throw new Error("timed out")
    await Bun.sleep(20)
  }
}

describe("a team at work (team.md)", () => {
  test("the lead adds a member, is refused work, and is woken by the member's report", async () => {
    let lead = 0
    const dir = setup((body) => {
      if (isMember(body, "parser")) return say("The parser is done: src/parse.ts.")
      const n = lead++
      if (n === 0) return call("a1", "team_add", { name: "parser", role: "the parser", task: "Write the parser; report the file.", goal: "a calculator" })
      if (n === 1) return call("w1", "write", { path: "x.txt", content: "x" })
      return say(n === 2 ? "parser is on it." : "All done.")
    })
    app = createApp({ cwd: dir, mode: "edit", asker: yes, store: false })
    await app.engine.prompt("build a calculator")
    // The lead's report arrives — at a step boundary, or as a turn of its own when it was idle.
    await until(() => fake!.requests.some((r) => !isMember(r, "parser") && r.messages.some((m: any) => m.role === "user" && JSON.stringify(m.content).includes("[Team report from parser to lead:]"))))
    await until(() => !app!.engine.busy && app!.team.team.get("lead")!.state === "idle")

    const first = fake!.requests[0]
    expect(first.tools.map((t: any) => t.function.name)).toEqual(expect.arrayContaining(["team_add", "team_send", "team_read", "team_stop"]))
    expect(system(first)).toContain("team_add")
    // The size is said once, in the note on the first message.
    expect(lastUser(first)).toContain(LOOP.context.note.team.replace("{{min}}", "1").replace("{{max}}", "4"))

    const leads = fake!.requests.filter((r) => !isMember(r, "parser"))
    const results = toolResults(leads[leads.length - 1])
    expect(results[0]).toContain("Added parser (the parser)")
    expect(results[1]).toContain(T.texts.manager)

    // The member: its own prompt, its brief as its first message, and the team tools a member has.
    const member = fake!.requests.find((r) => isMember(r, "parser"))!
    expect(system(member)).toContain("The team's goal: a calculator")
    expect(system(member)).toContain('you report to "lead"')
    expect(lastUser(member)).toContain("Write the parser; report the file.")
    const memberTools = member.tools.map((t: any) => t.function.name)
    expect(memberTools).toEqual(expect.arrayContaining(["team_send", "team_read"]))
    expect(memberTools).not.toContain("team_add")
    expect(memberTools).not.toContain("task")

    // The room has the report; the lead manages the finished member; nothing was written.
    const t = app.team.team
    expect(t.room.map((m) => ({ from: m.from, to: m.to, report: m.report }))).toEqual([{ from: "parser", to: ["lead"], report: true }])
    expect(t.get("parser")!.state).toBe("finished")
    expect(t.isManager("lead")).toBe(true)
    expect(teamLabel(t)).toBe("agents 2/4")
    expect(teamText(app, "")).toContain("- parser (s1) — the parser · finished")
    expect(await Bun.file(join(dir, "x.txt")).exists()).toBe(false)
    // A member is not a job to the model.
    expect(app.jobs().every((j) => j.team === "parser")).toBe(true)
  })

  test("max 1: the tools are listed but answer one_agent, and task too; the note says to work alone", async () => {
    let n = 0
    const dir = setup(() => (n++ === 0 ? call("a1", "team_add", { name: "x", role: "r", task: "t", goal: "g" }) : n === 2 ? call("t1", "task", { description: "d", prompt: "p" }) : say("alone")), "agents: { min: 1, max: 1 }\n")
    app = createApp({ cwd: dir, mode: "edit", asker: yes, store: false })
    await app.engine.prompt("go")
    expect(lastUser(fake!.requests[0])).toContain(LOOP.context.note.team_one)
    const results = toolResults(fake!.requests[2])
    expect(results).toEqual([T.unavailable.one_agent, T.unavailable.one_agent])
  })

  test("min 2: the lead is a manager from the start, and the note asks for members", async () => {
    let n = 0
    const dir = setup(() => (n++ === 0 ? call("e1", "bash", { command: "touch made.txt" }) : say("ok")), "agents: { min: 2, max: 4 }\n")
    app = createApp({ cwd: dir, mode: "auto", asker: yes, store: false })
    await app.engine.prompt("go")
    expect(lastUser(fake!.requests[0])).toContain(LOOP.context.note.team_lead.replace("{{members}}", "1"))
    expect(toolResults(fake!.requests[1])).toEqual([T.texts.manager])
    expect(await Bun.file(join(dir, "made.txt")).exists()).toBe(false)
  })

  test("a model that serves one request at a time offers no team: no team tools, /team says why", async () => {
    const dir = setup(() => say("ok"), "", "{ context: 32768, parallel: 1 }")
    app = createApp({ cwd: dir, mode: "edit", asker: yes, store: false })
    await app.engine.prompt("go")
    expect(fake!.requests[0].tools.map((t: any) => t.function.name).filter((n: string) => n.startsWith("team_"))).toEqual([])
    expect(lastUser(fake!.requests[0])).not.toContain("The team may have")
    expect(teamText(app, "")).toContain("serves one request at a time")
  })

  test("the size is refused outside its bounds, whole, and a change is said in the next note", async () => {
    let n = 0
    const dir = setup(() => say(`ok ${n++}`))
    app = createApp({ cwd: dir, mode: "edit", asker: yes, store: false })
    await app.engine.prompt("one")
    expect(teamText(app, "size 3 2")).toContain("1 ≤ Min ≤ Max ≤ 32")
    expect(teamText(app, "size 1 40")).toContain("1 ≤ Min ≤ Max ≤ 32")
    expect([app.team.team.min, app.team.team.max]).toEqual([1, 4])
    expect(teamText(app, "size 2 6")).toContain("Min 2, Max 6")
    expect(app.settings.get("agents.max").value).toBe(6)
    await app.engine.prompt("two")
    expect(lastUser(fake!.requests[1])).toContain("The team may have 2 to 6 agents, you included.")
    await app.engine.prompt("three")
    expect(lastUser(fake!.requests[2])).toBe("three")
  })
})
