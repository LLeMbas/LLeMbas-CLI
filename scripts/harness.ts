// The harness spec's conformance cases (harness/conformance/*.json), shared with LLeMbas.
//   bun run harness record        fill in the `expect` of every case that has none, from LLeMbas CLI
//   bun run harness record --all  record every case again, and say which ones changed
// Recording is how a new case gets its answer; a changed answer is a change of behaviour, which
// the spec's version and both projects must then follow.
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { AREAS } from "../tests/conformance.ts"

const dir = join(import.meta.dir, "..", "harness", "conformance")
const [cmd, flag] = process.argv.slice(2)
if (cmd !== "record") {
  console.error("usage: bun run harness record [--all]")
  process.exit(2)
}
let filled = 0
let changed = 0
for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
  const area = f.replace(/\.json$/, "")
  const run = AREAS[area]
  if (!run) {
    console.log(`${area}: no runner in tests/conformance.ts yet — skipped`)
    continue
  }
  const doc = JSON.parse(readFileSync(join(dir, f), "utf8")) as { about: string; cases: Record<string, unknown>[] }
  for (const c of doc.cases) {
    if ("expect" in c && flag !== "--all") continue
    const { expect: before, ...input } = c
    const now = run(input)
    if ("expect" in c && JSON.stringify(before) !== JSON.stringify(now)) {
      changed++
      console.log(`${area}: ${JSON.stringify(input)}\n  was ${JSON.stringify(before)}\n  now ${JSON.stringify(now)}`)
    } else if (!("expect" in c)) filled++
    c.expect = now
  }
  writeFileSync(join(dir, f), JSON.stringify(doc, null, 2) + "\n")
}
console.log(`recorded: ${filled} new, ${changed} changed`)
