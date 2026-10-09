import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { doRelease, findVersion, nextVersion, planRelease, releaseChangelog, type ReleasePlan } from "../src/git/release.ts"
import { git } from "../src/git/run.ts"

const repo = (files: Record<string, string>) => {
  const d = mkdtempSync(join(tmpdir(), "ph-rel-"))
  for (const [f, t] of Object.entries(files)) {
    mkdirSync(join(d, f, ".."), { recursive: true })
    writeFileSync(join(d, f), t)
  }
  git(d, ["init", "-q", "-b", "main"])
  git(d, ["config", "user.email", "t@example.com"])
  git(d, ["config", "user.name", "T"])
  git(d, ["config", "commit.gpgsign", "false"])
  git(d, ["config", "tag.gpgsign", "false"])
  git(d, ["add", "-A"])
  git(d, ["commit", "-q", "-m", "init"])
  return d
}

const CL = `# Changelog

## [Unreleased]

### Added
- A thing.

## [0.1.0] — 2026-01-01

### Added
- The start.

[Unreleased]: https://git.example/p/compare/v0.1.0...HEAD
[0.1.0]: https://git.example/p/releases/tag/v0.1.0
`

describe("release", () => {
  test("the version is found where each kind of project keeps it, and replaced only there", () => {
    const py = repo({ "pyproject.toml": '[build-system]\nrequires = ["x"]\n\n[project]\nname = "p"\nversion = "1.2.3"\n\n[tool.x]\nversion = "9"\n' })
    const v = findVersion(py)!
    expect([v.file, v.version]).toEqual(["pyproject.toml", "1.2.3"])
    expect(v.with("1.3.0")).toContain('[project]\nname = "p"\nversion = "1.3.0"')
    expect(v.with("1.3.0")).toContain('version = "9"')
    const cargo = repo({ "Cargo.toml": '[package]\nname = "c"\nversion = "0.4.1"\n\n[dependencies]\nserde = { version = "1" }\n' })
    expect(findVersion(cargo)!.with("0.5.0")).toBe('[package]\nname = "c"\nversion = "0.5.0"\n\n[dependencies]\nserde = { version = "1" }\n')
    const init = repo({ "src/lembas/__init__.py": '"""x"""\n__version__ = "1.9.0"\n' })
    expect(findVersion(init)!).toMatchObject({ file: "src/lembas/__init__.py", version: "1.9.0" })
    expect(findVersion(repo({ VERSION: "2.0.0\n" }))!.version).toBe("2.0.0")
    // single quotes in TOML; package.json's own version, not a nested one; the lockfile moves too
    expect(findVersion(repo({ "Cargo.toml": "[package]\nname = 'c'\nversion = '0.2.0'\n" }))!.with("0.3.0")).toContain("version = '0.3.0'")
    const js = repo({ "package.json": '{\n    "name": "x",\n    "config": { "version": "9.9.9" },\n    "version": "1.0.0"\n}\n', "package-lock.json": '{\n  "name": "x",\n  "version": "1.0.0",\n  "packages": { "": { "version": "1.0.0" } }\n}\n' })
    const jv = findVersion(js)!
    expect(jv.version).toBe("1.0.0")
    expect(JSON.parse(jv.with("1.1.0"))).toEqual({ name: "x", config: { version: "9.9.9" }, version: "1.1.0" })
    expect(jv.with("1.1.0")).toStartWith('{\n    "name"')
    expect(JSON.parse(jv.also![0]!.with("1.1.0"))).toMatchObject({ version: "1.1.0", packages: { "": { version: "1.1.0" } } })
    expect(findVersion(repo({ "a.txt": "" }))).toBeUndefined()
  })

  test("next versions", () => {
    expect(nextVersion("0.7.0", "")).toBe("0.7.1")
    expect(nextVersion("0.7.3", "minor")).toBe("0.8.0")
    expect(nextVersion("0.7.3", "major")).toBe("1.0.0")
    expect(nextVersion("1.2.0-beta.3", "patch")).toBe("1.2.0")
    expect(nextVersion("0.7.0", "0.9.0")).toBe("0.9.0")
    expect(nextVersion("0.7.0", "v0.9.0")).toBe("0.9.0")
    expect(() => nextVersion("0.7.0", "huge")).toThrow("not patch, minor, major")
  })

  test("the Unreleased entries move under the new version; Unreleased stays, empty; link references follow", () => {
    const r = releaseChangelog(CL, "0.2.0", "2026-10-01")!
    expect(r.notes).toBe("### Added\n- A thing.")
    expect(r.text).toContain("## [Unreleased]\n\n## [0.2.0] — 2026-10-01\n\n### Added\n- A thing.\n\n## [0.1.0]")
    expect(r.text).toContain("[Unreleased]: https://git.example/p/compare/v0.2.0...HEAD\n[0.2.0]: https://git.example/p/compare/v0.1.0...v0.2.0")
    expect(releaseChangelog("# C\n\n## [Unreleased]\n\n## [0.1.0]\n- x\n", "0.2.0", "d")).toBeUndefined()
    const pre = releaseChangelog("## [Unreleased]\n- y\n\n[Unreleased]: https://g/p/compare/v1.0.0-beta.1...HEAD\n", "1.0.0", "d")!
    expect(pre.text).toContain("[1.0.0]: https://g/p/compare/v1.0.0-beta.1...v1.0.0")
  })

  test("plan and do: a clean tree is required; one commit with both files, an annotated tag carrying the notes; nothing pushed", () => {
    const d = repo({ "package.json": '{\n  "name": "@x/demo",\n  "version": "0.1.0"\n}\n', "CHANGELOG.md": CL })
    git(d, ["tag", "-a", "v0.1.0", "-m", "0.1.0"])
    writeFileSync(join(d, "package.json"), '{\n  "name": "@x/demo",\n  "version": "0.1.0" \n}\n')
    expect(planRelease(d, "minor")).toMatchObject({ blocked: expect.stringContaining("uncommitted changes") })
    git(d, ["checkout", "--", "package.json"])
    const p = planRelease(d, "minor") as ReleasePlan
    expect([p.from, p.to, p.tag, p.name, p.sign]).toEqual(["0.1.0", "0.2.0", "v0.2.0", "demo", false])
    const r = doRelease(p)
    expect(r.ok).toBe(true)
    expect(r.lines.at(-1)).toContain("nothing pushed")
    expect(readFileSync(join(d, "package.json"), "utf8")).toContain('"version": "0.2.0"')
    expect(git(d, ["show", "--stat", "--format=%s", "HEAD"]).out).toMatch(/^Release 0\.2\.0\n[\s\S]*CHANGELOG\.md[\s\S]*package\.json/)
    expect(git(d, ["tag", "-l", "--format=%(contents)", "v0.2.0"]).out).toBe("demo 0.2.0\n\n### Added\n- A thing.")
    expect(git(d, ["cat-file", "-t", "v0.2.0"]).out).toBe("tag")
    expect(planRelease(d, "0.2.0")).toMatchObject({ blocked: "the tag v0.2.0 already exists" })
  })

  test("a tag that failed last time is finished, not skipped; a plan gone stale does nothing", () => {
    const d = repo({ "package.json": '{ "name": "demo", "version": "0.1.0" }\n', "CHANGELOG.md": CL })
    const p = planRelease(d, "minor") as ReleasePlan
    // the tag fails (as with a locked key): the commit is there, the tag is not
    git(d, ["tag", "v0.2.0", "HEAD"])
    expect(doRelease(p).ok).toBe(false)
    git(d, ["tag", "-d", "v0.2.0"])
    expect(git(d, ["log", "-1", "--format=%s"]).out).toBe("Release 0.2.0")
    const again = planRelease(d, "") as ReleasePlan
    expect([again.tagOnly, again.to, again.tag]).toEqual([true, "0.2.0", "v0.2.0"])
    expect(doRelease(again).ok).toBe(true)
    expect(git(d, ["tag", "-l", "--format=%(contents)", "v0.2.0"]).out).toBe("demo 0.2.0\n\n### Added\n- A thing.")
    // stale: the tree changed after the plan
    const q = planRelease(d, "patch") as ReleasePlan
    writeFileSync(join(d, "CHANGELOG.md"), "changed\n")
    const stale = doRelease(q)
    expect(stale.ok).toBe(false)
    expect(stale.lines[0]).toContain("changed since the plan")
  })
})
