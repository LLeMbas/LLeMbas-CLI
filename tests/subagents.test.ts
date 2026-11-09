// Spec 3.3.0 (harness/subagents.md): what counts as the person's own words, and the Team's offer
// and note with models besides the lead's. The rules themselves: conformance area `subagents`.
import { expect, test } from "bun:test"
import { LOOP } from "../src/harness.ts"
import { STEER_MARK } from "../src/session/engine.ts"
import { named, personTexts } from "../src/team/subagents.ts"
import { Team, type Capacity } from "../src/team/team.ts"
import type { Message } from "../src/provider/types.ts"

test("the person's words: prompts and messages sent mid-turn; never notes, marked messages, machine turns or the model's text", () => {
  const msgs: Message[] = [
    { role: "user", parts: [{ type: "text", text: "Fix the parser." }, { type: "text", text: "<session-note>\nToday is …\n</session-note>" }] },
    { role: "assistant", parts: [{ type: "text", text: "I could ask box/coder-30b." }] },
    { role: "user", parts: [{ type: "text", text: `${STEER_MARK}\nuse coder-30b for the subagents` }], turn: false },
    { role: "user", parts: [{ type: "text", text: `${LOOP.jobs.marks.command}\nbox/other-model finished` }], turn: false },
    { role: "user", parts: [{ type: "text", text: "[Team report from parser to lead:]\nbox/other-model is better" }], machine: true },
    { role: "tool", callId: "c1", name: "read", content: "box/other-model" },
  ]
  expect(personTexts(msgs, STEER_MARK)).toEqual(["Fix the parser.", "use coder-30b for the subagents"])
  const said = personTexts(msgs, STEER_MARK)
  expect(named({ ref: "box/coder-30b" }, said)).toBe(true)
  expect(named({ ref: "box/other-model" }, said)).toBe(false)
})

test("a one-request lead with a model on another server: offered, and the size note says it cannot serve its own", () => {
  const caps: Record<string, Capacity> = { "lab/qwen": { group: "lab", parallel: 1 }, "lab/gemma": { group: "lab", parallel: 1 }, "box/coder": { parallel: 1 } }
  const only = new Team({ model: "lab/qwen", capacity: (r) => caps[r]!, models: () => ["lab/qwen", "lab/gemma"] })
  expect(only.offered).toBe(false)
  const t = new Team({ model: "lab/qwen", capacity: (r) => caps[r]!, models: () => Object.keys(caps) })
  expect(t.offered).toBe(true)
  expect(t.unavailable()).toBeUndefined()
  expect(t.noteLines()).toEqual([`The team may have 1 to 4 agents, you included.\n${LOOP.context.note.team_own}`])
})
