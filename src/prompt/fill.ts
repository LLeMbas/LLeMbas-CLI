// A prompt text's `{{variables}}` filled in (harness spec, prompts/index.json): a fact the two
// projects differ in — the opening line, where the output is shown, the plan — written into the
// shared text before it is sent. Two rules beyond a plain replace: a line that is nothing but a
// bullet and a variable (`- {{name}}`) disappears when the variable is empty, so one text serves a
// project that has the fact and one that does not; and a variable with no value is an error, since
// it would reach the model as a literal `{{name}}`.

const BULLET_ONLY = /^[ \t]*[-*][ \t]+\{\{(\w+)\}\}[ \t]*$/

export function fillPrompt(text: string, vars: Record<string, string>): string {
  const missing = new Set<string>()
  const value = (k: string): string | undefined => {
    if (!Object.hasOwn(vars, k)) {
      missing.add(k)
      return undefined
    }
    return vars[k]!
  }
  const lines = text.split("\n")
  const out: string[] = []
  for (const line of lines) {
    const bullet = BULLET_ONLY.exec(line)
    if (bullet) {
      const v = value(bullet[1]!)
      if (v === undefined || v.trim() === "") continue
    }
    out.push(line.replace(/\{\{(\w+)\}\}/g, (m, k: string) => value(k) ?? m))
  }
  if (missing.size) throw new Error(`prompt: no value for {{${[...missing].join("}}, {{")}}}`)
  return out.join("\n")
}
