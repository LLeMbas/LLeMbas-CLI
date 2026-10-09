import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../src/app.ts"
import type { Asker, AskReply } from "../src/bus/index.ts"
import { paths } from "../src/config/paths.ts"
import type { PlanReply } from "../src/tool/plan_exit.ts"
import { delta, fakeProvider, toolCall, type Fake } from "./fake-provider.ts"

let fake: Fake | undefined
afterEach(() => fake?.stop())

const PLAN = "# Fix the average\n\n## Goal\nTests pass.\n\n## Changes\n1. calc.py: divide by len(values)\n"
function app(script: Parameters<typeof fakeProvider>[0], plan?: (r: { path: string; text: string }) => Promise<PlanReply>) {
  fake = fakeProvider(script)
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  f:\n    dialect: openai-chat\n    base_url: ${fake.url}\n    models: { m: {} }\n`, { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), "model: f/m\n")
  const cwd = mkdtempSync(join(tmpdir(), "ph-plan-"))
  Bun.spawnSync(["git", "init", "-q", cwd])
  const asker: Asker = { ask: async (): Promise<AskReply> => ({ kind: "once" }), ...(plan ? { plan } : {}) }
  return createApp({ cwd, mode: "plan", store: false, asker })
}
const writePlan = (name = "2026-09-29-fix.md") => toolCall(0, "w1", "write", JSON.stringify({ path: `.agent/plans/${name}`, content: PLAN }))
const exitPlan = (name = "2026-09-29-fix.md") => toolCall(0, "x1", "plan_submit", JSON.stringify({ path: `.agent/plans/${name}` }))
const names = (r: any) => r.tools.map((t: any) => t.function.name)

describe("plan mode", () => {
  test("write the plan, plan_submit, approve → edit mode in the same turn, and plan_submit is no longer offered", async () => {
    const seen: string[] = []
    const a = app([{ chunks: [writePlan()] }, { chunks: [exitPlan()] }, { chunks: [delta({ content: "Implementing." })] }], async (r) => {
      seen.push(r.path, r.text)
      return { kind: "approve", mode: "edit" }
    })
    await a.engine.prompt("fix it")
    expect(seen).toEqual([".agent/plans/2026-09-29-fix.md", PLAN])
    expect(names(fake!.requests[0])).toContain("plan_submit")
    expect(fake!.requests[0].messages[0].content).toContain("Permission mode: plan")
    expect(fake!.requests[2].messages[0].content).toContain("Permission mode: edit")
    expect(names(fake!.requests[2])).not.toContain("plan_submit")
    expect(fake!.requests[2].messages.at(-1).content).toContain("The user approved the plan")
    expect(a.engine.mode).toBe("edit")
  })

  test("revise and ask back come back as instructions; nobody present means saved, stop", async () => {
    const a = app([{ chunks: [writePlan()] }, { chunks: [exitPlan()] }, { chunks: [delta({ content: "ok" })] }], async () => ({ kind: "revise", feedback: "use a helper" }))
    await a.engine.prompt("fix it")
    expect(fake!.requests[2].messages.at(-1).content).toContain("revised: use a helper")
    expect(a.engine.mode).toBe("plan")
    fake!.stop()

    const b = app([{ chunks: [writePlan()] }, { chunks: [exitPlan()] }, { chunks: [delta({ content: "Plan saved." })] }])
    await b.engine.prompt("fix it")
    expect(fake!.requests[2].messages.at(-1).content).toContain("Nobody is present to approve the plan")
    expect(b.engine.mode).toBe("plan")
  })

  test("plan_submit refuses a file outside the plans directory; edit mode does not offer it", async () => {
    const a = app([{ chunks: [toolCall(0, "x1", "plan_submit", '{"path":"README.md"}')] }, { chunks: [delta({ content: "ok" })] }], async () => ({ kind: "approve", mode: "edit" }))
    writeFileSync(join(a.project.root, "README.md"), "x")
    await a.engine.prompt("go")
    expect(fake!.requests[1].messages.at(-1).content).toContain("must be a file under")
    a.engine.mode = "edit"
    await a.engine.prompt("again").catch(() => {})
    expect(names(fake!.requests.at(-1))).not.toContain("plan_submit")
  })
})
