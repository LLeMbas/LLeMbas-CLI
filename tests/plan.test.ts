import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../src/app.ts"
import type { Asker, AskReply } from "../src/bus/index.ts"
import { paths } from "../src/config/paths.ts"
import type { PlanReply, PlanRequest } from "../src/tool/plan_submit.ts"
import { delta, fakeProvider, toolCall, type Fake } from "./fake-provider.ts"

let fake: Fake | undefined
afterEach(() => fake?.stop())

const PLAN = { title: "Fix the average", objectives: [{ text: "Tests pass" }], phases: [{ title: "Changes", tasks: ["calc.py: divide by len(values)"] }] }
const RENDERED = "# Fix the average\nObjectives: [o1] Tests pass (open)\n## p1 Changes (pending)\n[t1] [ ] calc.py: divide by len(values)"
function app(script: Parameters<typeof fakeProvider>[0], plan?: (r: PlanRequest) => Promise<PlanReply>) {
  fake = fakeProvider(script)
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  f:\n    dialect: openai-chat\n    base_url: ${fake.url}\n    models: { m: {} }\n`, { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), "model: f/m\n")
  const cwd = mkdtempSync(join(tmpdir(), "ph-plan-"))
  Bun.spawnSync(["git", "init", "-q", cwd])
  const asker: Asker = { ask: async (): Promise<AskReply> => ({ kind: "once" }), ...(plan ? { plan } : {}) }
  return createApp({ cwd, mode: "plan", store: false, asker })
}
const writePlan = () => toolCall(0, "w1", "plan_write", JSON.stringify(PLAN))
// `path` is a former argument, ignored: the plan is the one written with plan_write.
const exitPlan = () => toolCall(0, "x1", "plan_submit", JSON.stringify({ path: ".agent/plans/old.md" }))
const names = (r: any) => r.tools.map((t: any) => t.function.name)

describe("plan mode", () => {
  test("plan_write, plan_submit, approve → edit mode in the same turn, and plan_submit is no longer offered", async () => {
    const seen: PlanRequest[] = []
    const a = app([{ chunks: [writePlan()] }, { chunks: [exitPlan()] }, { chunks: [delta({ content: "Implementing." })] }], async (r) => {
      seen.push(r)
      return { kind: "approve", mode: "edit" }
    })
    await a.engine.prompt("fix it")
    // The card gets the plan, its text with ids, and the copy kept under plans/ for the record.
    expect(seen).toHaveLength(1)
    expect(seen[0]!.text).toBe(RENDERED)
    expect(seen[0]!.plan.title).toBe("Fix the average")
    expect(seen[0]!.path).toMatch(/^\.agent\/plans\/\d{4}-\d{2}-\d{2}-fix-the-average\.md$/)
    expect(readFileSync(join(a.project.root, seen[0]!.path), "utf8")).toBe(RENDERED + "\n")
    expect(a.engine.plan?.steps).toEqual(["calc.py: divide by len(values)"])
    // The model read the plan back with its ids from plan_write.
    expect(fake!.requests[1].messages.at(-1).content).toBe(`[#0001]\n${RENDERED}`)
    expect(names(fake!.requests[0])).toContain("plan_submit")
    expect(names(fake!.requests[0])).toContain("plan_write")
    expect(fake!.requests[0].messages[0].content).toContain("Permission mode: plan")
    expect(fake!.requests[2].messages[0].content).toContain("Permission mode: edit")
    expect(names(fake!.requests[2])).not.toContain("plan_submit")
    // plan_write and plan_update are offered in every mode: the plan is kept current while implementing.
    expect(names(fake!.requests[2])).toContain("plan_update")
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

  test("plan_submit with no plan written is an error naming plan_write; edit mode does not offer it", async () => {
    const a = app([{ chunks: [exitPlan()] }, { chunks: [delta({ content: "ok" })] }], async () => ({ kind: "approve", mode: "edit" }))
    await a.engine.prompt("go")
    expect(fake!.requests[1].messages.at(-1).content).toContain("Write it with plan_write")
    expect(a.engine.mode).toBe("plan")
    a.engine.mode = "edit"
    await a.engine.prompt("again").catch(() => {})
    expect(names(fake!.requests.at(-1))).not.toContain("plan_submit")
  })
})
