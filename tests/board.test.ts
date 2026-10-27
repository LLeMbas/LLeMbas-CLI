import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../src/app.ts"
import type { AskReply } from "../src/bus/index.ts"
import { paths } from "../src/config/paths.ts"
import { addDecision, boardSummary, readBoard, readDecisions, writeBoard } from "../src/project/board.ts"
import { setTrust } from "../src/project/root.ts"
import { delta, fakeProvider, toolCall, type Fake } from "./fake-provider.ts"

let fake: Fake | undefined
afterEach(() => fake?.stop())

describe("the project board", () => {
  test("markdown both ways; ids kept; a hand-written board is read too", () => {
    const dir = mkdtempSync(join(tmpdir(), "ph-board-"))
    writeFileSync(join(dir, "tasks.md"), "# Tasks\n\n## Todo\n\n- [ ] write docs\n- [ ] add tests (#7)\n\n## Doing\n\n- [ ] importer (#3)\n\n## Done\n\n- [x] setup (#1)\n")
    const b = readBoard(dir)
    expect(b.map((t) => [t.id, t.column])).toEqual([[1, "todo"], [7, "todo"], [3, "doing"], [1, "done"]].map(([i, c]) => [i, c]) as never)
    writeBoard(dir, b)
    expect(readFileSync(join(dir, "tasks.md"), "utf8")).toContain("- [ ] importer (#3)")
    expect(boardSummary(dir)).toBe("- #3 [doing] importer\n- #1 [todo] write docs\n- #7 [todo] add tests")
    addDecision(dir, "Storage", "SQLite, one file per project", "no server to run")
    expect(readDecisions(dir)).toEqual([{ date: expect.any(String), title: "Storage", text: "**Decision:** SQLite, one file per project\n\n**Why:** no server to run" }] as never)
  })

  test("the tasks tool edits .agent/tasks.md; open items reach the system prompt of the next session, not this one's", async () => {
    fake = fakeProvider([
      { chunks: [toolCall(0, "t1", "tasks", '{"action":"add","text":"migrate the importer"}'), toolCall(1, "t2", "tasks", '{"action":"add","text":"write docs","to":"doing"}')] },
      { chunks: [toolCall(0, "t3", "decisions", '{"action":"add","title":"Importer","decision":"streamed, not buffered","why":"files are large"}')] },
      { chunks: [delta({ content: "noted" })] },
      { chunks: [delta({ content: "next" })] },
    ])
    mkdirSync(paths.config, { recursive: true })
    writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  f:\n    type: webui\n    url: ${fake.url}\n    models: { f/m: {} }\n`, { mode: 0o600 })
    writeFileSync(join(paths.config, "config.yaml"), "model: f/m\n")
    const cwd = mkdtempSync(join(tmpdir(), "ph-board-"))
    mkdirSync(join(cwd, ".agent"))
    setTrust(cwd, "trusted")
    const app = createApp({ cwd, mode: "edit", store: false, asker: { ask: async (): Promise<AskReply> => ({ kind: "once" }) } })
    await app.engine.prompt("remember these")
    expect(readFileSync(join(cwd, ".agent/tasks.md"), "utf8")).toContain("- [ ] migrate the importer (#1)")
    expect(readFileSync(join(cwd, ".agent/decisions.md"), "utf8")).toContain("· Importer")
    // The session's system prompt does not change under it (the server's prompt cache depends on it).
    const before = fake.requests[0].messages[0].content as string
    await app.engine.prompt("what next?")
    expect(fake.requests.at(-1).messages[0].content).toBe(before)
    app.newSession()
    await app.engine.prompt("and now?")
    const system = fake.requests.at(-1).messages[0].content as string
    expect(system).toContain("<project_tasks>\n- #2 [doing] write docs\n- #1 [todo] migrate the importer\n</project_tasks>")
  })
})
