// A prompt text's variables (harness spec, prompts/index.json): filled in, a bullet-only line
// taken out with its empty variable, and a variable with no value refused rather than sent.
import { expect, test } from "bun:test"
import { fillPrompt } from "../src/prompt/fill.ts"

test("a variable is filled; a line that is only a bullet and an empty variable disappears", () => {
  const text = "{{intro}}\n\n# Using tools\n- {{surface}} Be concise.\n- {{tool_list}}\n  - {{file_tools}}\n- Keep working.\n* {{background}}\n\n{{git}}"
  const out = fillPrompt(text, { intro: "You help.", surface: "A terminal.", tool_list: "", file_tools: "Use read.", background: "   ", git: "" })
  expect(out).toBe("You help.\n\n# Using tools\n- A terminal. Be concise.\n  - Use read.\n- Keep working.\n\n")
})

test("a variable with no value is an error, not a literal {{name}} sent to the model", () => {
  expect(() => fillPrompt("- {{plan_context}}\n{{intro}}", { intro: "x" })).toThrow("no value for {{plan_context}}")
  // A filled variable may itself contain a bullet-and-variable line: it is text, not a template.
  expect(fillPrompt("- {{a}}", { a: "- {{b}}" })).toBe("- - {{b}}")
})
