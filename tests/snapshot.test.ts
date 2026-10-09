import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Snapshots } from "../src/git/snapshot.ts"

const project = (git: boolean) => {
  const d = mkdtempSync(join(tmpdir(), "ph-snap-"))
  if (git) Bun.spawnSync(["git", "init", "-q", d])
  writeFileSync(join(d, "a.txt"), "one\n")
  writeFileSync(join(d, "keep.txt"), "untouched\n")
  return d
}

for (const withGit of [false, true]) {
  describe(`snapshots ${withGit ? "in a git repository" : "without git"}`, () => {
    test("restore puts changed files back, deletes created ones, leaves the rest", () => {
      const d = project(withGit)
      const s = new Snapshots(d, withGit ? d : undefined)
      const before = s.track()!
      writeFileSync(join(d, "a.txt"), "two\n")
      writeFileSync(join(d, "new.txt"), "created\n")
      const after = s.track()!
      expect(s.changed(before, after).sort()).toEqual(["a.txt", "new.txt"])
      expect(s.diff(before, after)).toContain("+two")
      writeFileSync(join(d, "keep.txt"), "edited by someone else\n")
      s.restore(before, s.changed(before, after))
      expect(readFileSync(join(d, "a.txt"), "utf8")).toBe("one\n")
      expect(existsSync(join(d, "new.txt"))).toBe(false)
      expect(readFileSync(join(d, "keep.txt"), "utf8")).toBe("edited by someone else\n")
      // …and the shadow store never touched the project's own git
      expect(existsSync(join(d, ".git"))).toBe(withGit)
      if (withGit) expect(Bun.spawnSync(["git", "-C", d, "status", "--porcelain"]).stdout.toString()).toContain("?? a.txt")
    })
  })
}

test("files over 2 MB stay out; a tree over the limit turns snapshots off with a reason", () => {
  const d = project(false)
  writeFileSync(join(d, "big.bin"), Buffer.alloc(3 * 1024 * 1024))
  const s = new Snapshots(d)
  const t1 = s.track()!
  writeFileSync(join(d, "big.bin"), Buffer.alloc(3 * 1024 * 1024, 1))
  expect(s.changed(t1, s.track()!)).toEqual([])

  const many = project(false)
  for (let i = 0; i < 6; i++) writeFileSync(join(many, `f${i}`), "x")
  const off = new Snapshots(many, undefined, 5)
  expect(off.track()).toBeUndefined()
  expect(off.reason).toContain("too many")
})
