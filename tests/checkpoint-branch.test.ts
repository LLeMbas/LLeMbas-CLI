import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { badBranchName, branches, currentBranch, deleteBranch, switchBranch } from "../src/git/branch.ts"
import { Snapshots } from "../src/git/snapshot.ts"

const sh = (d: string, ...args: string[]) => Bun.spawnSync(["git", "-C", d, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args])

function repo(commit = true) {
  const d = mkdtempSync(join(tmpdir(), "ph-cp-"))
  sh(d, "init", "-q", "-b", "main")
  writeFileSync(join(d, "a.txt"), "one\n")
  if (commit) {
    sh(d, "add", "a.txt")
    sh(d, "commit", "-q", "-m", "first")
  }
  return d
}

describe("checkpoints", () => {
  test("saved, listed newest first, and kept by a second Snapshots on the same project", () => {
    const d = repo()
    const s = new Snapshots(d, d)
    expect(s.checkpoints()).toEqual([])
    const a = s.checkpoint("before the refactor")!
    writeFileSync(join(d, "a.txt"), "two\n")
    const b = s.checkpoint("halfway")!
    expect(a.tree).not.toBe(b.tree)
    const again = new Snapshots(d, d).checkpoints()
    expect(again.map((c) => c.label)).toEqual(["halfway", "before the refactor"])
    expect(again[1]!.tree).toBe(a.tree)
  })

  test("going back restores only what differs, deletes what is new, and saves what was there first", () => {
    const d = repo()
    writeFileSync(join(d, "keep.txt"), "same\n")
    const s = new Snapshots(d, d)
    const cp = s.checkpoint("clean")!
    writeFileSync(join(d, "a.txt"), "changed\n")
    writeFileSync(join(d, "new.txt"), "made later\n")
    const r = s.restoreCheckpoint(cp)!
    expect(r.files.sort()).toEqual(["a.txt", "new.txt"])
    expect(readFileSync(join(d, "a.txt"), "utf8")).toBe("one\n")
    expect(existsSync(join(d, "new.txt"))).toBe(false)
    expect(readFileSync(join(d, "keep.txt"), "utf8")).toBe("same\n")
    // …and the restore can itself be undone from the checkpoint it saved.
    expect(r.saved!.label).toBe('before going back to "clean"')
    s.restoreCheckpoint(r.saved!)
    expect(readFileSync(join(d, "a.txt"), "utf8")).toBe("changed\n")
    expect(readFileSync(join(d, "new.txt"), "utf8")).toBe("made later\n")
  })

  test("going back when nothing changed touches nothing and leaves no extra checkpoint", () => {
    const d = repo()
    const s = new Snapshots(d, d)
    const cp = s.checkpoint("x")!
    expect(s.restoreCheckpoint(cp)).toEqual({ files: [] })
    expect(s.checkpoints()).toHaveLength(1)
  })

  test("a checkpoint survives the project dropping the objects it borrowed", () => {
    const d = repo()
    writeFileSync(join(d, "b.txt"), "only ever on a branch\n")
    sh(d, "switch", "-q", "-c", "tmp")
    sh(d, "add", "b.txt")
    sh(d, "commit", "-q", "-m", "b")
    const s = new Snapshots(d, d)
    const cp = s.checkpoint("with b")!
    // The blob of b.txt lives in the project's store; make the project forget it entirely.
    sh(d, "switch", "-q", "main")
    sh(d, "branch", "-q", "-D", "tmp")
    rmSync(join(d, "b.txt"), { force: true })
    sh(d, "reflog", "expire", "--expire=now", "--all")
    sh(d, "gc", "-q", "--prune=now")
    s.restoreCheckpoint(cp)
    expect(readFileSync(join(d, "b.txt"), "utf8")).toBe("only ever on a branch\n")
  })

  test("deleted, and only checkpoint refs can be", () => {
    const d = repo()
    const s = new Snapshots(d, d)
    const cp = s.checkpoint("gone soon")!
    expect(s.dropCheckpoint("refs/heads/main")).toBe(false)
    expect(s.dropCheckpoint(cp.ref)).toBe(true)
    expect(s.checkpoints()).toEqual([])
  })

  test("work without git too", () => {
    const d = mkdtempSync(join(tmpdir(), "ph-cp-nogit-"))
    writeFileSync(join(d, "a.txt"), "one\n")
    const s = new Snapshots(d)
    const cp = s.checkpoint("plain dir")!
    writeFileSync(join(d, "a.txt"), "two\n")
    s.restoreCheckpoint(cp)
    expect(readFileSync(join(d, "a.txt"), "utf8")).toBe("one\n")
  })
})

describe("branches", () => {
  test("listed with the current one marked; a new name is made from HEAD and switched to", () => {
    const d = repo()
    expect(branches(d).map((b) => [b.name, b.current])).toEqual([["main", true]])
    expect(switchBranch(d, "feature/x")).toMatchObject({ ok: true, text: expect.stringContaining("made feature/x from") })
    expect(currentBranch(d)).toBe("feature/x")
    expect(switchBranch(d, "main")).toEqual({ ok: true, text: "switched to main" })
    expect(switchBranch(d, "main")).toEqual({ ok: true, text: "already on main" })
    const list = branches(d)
    expect(list.find((b) => b.current)!.name).toBe("main")
    expect(list.map((b) => b.name).sort()).toEqual(["feature/x", "main"])
    expect(list[0]!.last).toMatch(/^[0-9a-f]+ first$/)
  })

  test("uncommitted changes come along; one git cannot carry is refused and nothing moves", () => {
    const d = repo()
    sh(d, "switch", "-q", "-c", "other")
    writeFileSync(join(d, "a.txt"), "other's\n")
    sh(d, "commit", "-q", "-am", "other")
    sh(d, "switch", "-q", "main")
    writeFileSync(join(d, "a.txt"), "uncommitted\n")
    const r = switchBranch(d, "other")
    expect(r.ok).toBe(false)
    expect(r.text).toContain("would be overwritten")
    expect(currentBranch(d)).toBe("main")
    expect(readFileSync(join(d, "a.txt"), "utf8")).toBe("uncommitted\n")
    expect(switchBranch(d, "fresh").ok).toBe(true)
    expect(readFileSync(join(d, "a.txt"), "utf8")).toBe("uncommitted\n")
  })

  test("bad names are refused before git is asked to make them", () => {
    const d = repo()
    expect(badBranchName(d, "-x")).toBeDefined()
    expect(badBranchName(d, "a..b")).toBeDefined()
    expect(badBranchName(d, "has space")).toBeDefined()
    expect(badBranchName(d, "fix/ok-1")).toBeUndefined()
    expect(switchBranch(d, "a..b").ok).toBe(false)
  })

  test("delete: merged only, never the current branch", () => {
    const d = repo()
    sh(d, "branch", "merged")
    sh(d, "switch", "-q", "-c", "unmerged")
    writeFileSync(join(d, "c.txt"), "x\n")
    sh(d, "add", "c.txt")
    sh(d, "commit", "-q", "-m", "c")
    expect(deleteBranch(d, "unmerged")).toEqual({ ok: false, text: "unmerged is the current branch — switch to another first" })
    sh(d, "switch", "-q", "main")
    expect(deleteBranch(d, "merged")).toEqual({ ok: true, text: "deleted merged" })
    const r = deleteBranch(d, "unmerged")
    expect(r.ok).toBe(false)
    expect(r.text).toContain("git branch -D unmerged")
    expect(branches(d).map((b) => b.name)).toContain("unmerged")
  })

  test("a repository with no commit yet: no branches to list, and a first name can still be given", () => {
    const d = repo(false)
    expect(branches(d)).toEqual([])
    const r = switchBranch(d, "trunk")
    expect(r.ok).toBe(true)
    expect(currentBranch(d)).toBe("trunk")
  })
})
