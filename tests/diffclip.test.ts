// The transcript's short form of a diff must stay a diff: until this, cutting one added
// "@@ … N more lines (ctrl+o) @@" inside it and the renderer refused the whole thing.
import { expect, test } from "bun:test"
import { createTwoFilesPatch, parsePatch } from "diff"
import { clipDiff } from "../src/tui/diffclip.ts"

const before = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n") + "\n"
const after = before.replace("line 5\n", "line five\n").replace("line 30\n", "LINE 30\nextra\n").replace("line 55\n", "")
const patch = createTwoFilesPatch("index.html", "index.html", before, after)

const counts = (p: string) =>
  parsePatch(p)[0]!.hunks.map((h) => {
    const old = h.lines.filter((l) => l[0] === " " || l[0] === "-").length
    const neu = h.lines.filter((l) => l[0] === " " || l[0] === "+").length
    return { ok: old === h.oldLines && neu === h.newLines, old, neu }
  })

test("a cut diff still parses, every hunk's header matches its lines, and what was left out is counted", () => {
  for (const n of [1, 3, 7, 10, 15, 24]) {
    const { diff, hidden } = clipDiff(patch, n)
    expect(() => parsePatch(diff)).not.toThrow()
    expect(counts(diff).every((h) => h.ok)).toBe(true)
    expect(diff).not.toContain("more lines")
    const body = (d: string) => d.replace(/\n$/, "").split("\n").slice(d.split("\n").findIndex((l) => l.startsWith("@@"))).filter((l) => !l.startsWith("@@")).length
    expect(body(diff)).toBe(n)
    expect(hidden).toBeGreaterThan(0)
  }
})

test("short diffs, and diffs without hunks, pass through untouched", () => {
  expect(clipDiff(patch, 500)).toEqual({ diff: patch, hidden: 0 })
  expect(clipDiff("not a diff", 2)).toEqual({ diff: "not a diff", hidden: 0 })
})

test("'No newline at end of file' stays with its line", () => {
  const p = createTwoFilesPatch("a", "a", "x\ny\nz", "x\nY\nZ")
  const { diff } = clipDiff(p, 5)
  expect(() => parsePatch(diff)).not.toThrow()
  expect(counts(diff).every((h) => h.ok)).toBe(true)
})
