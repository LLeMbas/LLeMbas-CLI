// Every conformance case of the harness spec (harness/conformance/), through LLeMbas CLI. LLeMbas
// runs the same files through its own implementation; a case that fails on one side only is a
// difference between the two harnesses, which the spec exists to prevent.
import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { AREAS } from "./conformance.ts"

const dir = join(import.meta.dir, "..", "harness", "conformance")
for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
  const area = f.replace(/\.json$/, "")
  const doc = JSON.parse(readFileSync(join(dir, f), "utf8")) as { cases: Record<string, unknown>[] }
  test(`conformance: ${area} (${doc.cases.length} cases)`, () => {
    expect(AREAS[area]).toBeDefined()
    for (const c of doc.cases) {
      const { expect: want, ...input } = c
      expect(want, `${area}: ${JSON.stringify(input)} has no expect — bun run harness record`).toBeDefined()
      expect({ input, got: AREAS[area]!(input) }).toEqual({ input, got: want })
    }
  })
}
