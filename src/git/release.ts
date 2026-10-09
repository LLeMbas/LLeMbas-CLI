// /release: bump the version where the project keeps it, move CHANGELOG's Unreleased section
// under the new version, commit both files by name, and make an annotated tag — signed when git
// is set up to sign — whose message is that section. Nothing is pushed unless asked.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { git } from "./run.ts"

export interface VersionFile {
  file: string
  version: string
  /** The file's text with the version replaced. */
  with(next: string): string
  /** Other files that repeat the version and must move with it (package-lock.json). */
  also?: { file: string; with(next: string): string }[]
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/
const VERSIONISH = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`

/** Replace the first match of `re` (whose group 2 is the version) in `text`. */
const swap = (text: string, re: RegExp, next: string) => text.replace(re, (_m, a: string, _v: string, b: string) => `${a}${next}${b}`)

function tomlVersion(text: string, table: string): string | undefined {
  const sec = new RegExp(`^\\[${table.replace(".", "\\.")}\\]\\s*$([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, "m").exec(text)
  return sec ? /^version\s*=\s*["']([^"']+)["']/m.exec(sec[1]!)?.[1] : undefined
}

function tomlWith(text: string, table: string, next: string): string {
  const re = new RegExp(`(^\\[${table.replace(".", "\\.")}\\]\\s*$[\\s\\S]*?^version\\s*=\\s*["'])([^"']+)(["'])`, "m")
  return swap(text, re, next)
}

/** package.json-style: the top-level "version" only (a nested one is someone else's), rewritten
 *  with the file's own indentation. */
function jsonVersion(text: string): { version: string; with(next: string): string } | undefined {
  let j: any
  try {
    j = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof j?.version !== "string") return undefined
  const indent = /^\{\s*\n([ \t]+)"/.exec(text)?.[1] ?? "  "
  return {
    version: j.version,
    with: (next) => {
      const o = JSON.parse(text)
      o.version = next
      // package-lock.json repeats it for the root package
      if (o.packages?.[""] && typeof o.packages[""].version === "string") o.packages[""].version = next
      return JSON.stringify(o, null, indent) + (text.endsWith("\n") ? "\n" : "")
    },
  }
}

/** Where the project's version lives: the first of package.json, pyproject.toml, Cargo.toml, a
 *  package's __init__.py, VERSION. The tree rule: one source of the version. */
export function findVersion(root: string): VersionFile | undefined {
  const read = (f: string) => (existsSync(join(root, f)) ? readFileSync(join(root, f), "utf8") : undefined)
  const pkg = read("package.json")
  const pv = pkg ? jsonVersion(pkg) : undefined
  if (pv) {
    const lock = read("package-lock.json")
    const lv = lock ? jsonVersion(lock) : undefined
    return { file: "package.json", version: pv.version, with: pv.with, also: lv && lv.version === pv.version ? [{ file: "package-lock.json", with: lv.with }] : [] }
  }
  const py = read("pyproject.toml")
  if (py) {
    for (const t of ["project", "tool.poetry"]) {
      const v = tomlVersion(py, t)
      if (v) return { file: "pyproject.toml", version: v, with: (n) => tomlWith(py, t, n) }
    }
  }
  const cargo = read("Cargo.toml")
  if (cargo) {
    for (const t of ["package", "workspace.package"]) {
      const v = tomlVersion(cargo, t)
      if (v) return { file: "Cargo.toml", version: v, with: (n) => tomlWith(cargo, t, n) }
    }
  }
  for (const base of [".", "src"]) {
    const dir = join(root, base)
    if (!existsSync(dir)) continue
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith(".")) continue
      const rel = join(base === "." ? "" : base, d.name, "__init__.py")
      const text = read(rel)
      const v = text && /^__version__\s*=\s*["']([^"']+)["']/m.exec(text)?.[1]
      if (text && v) return { file: rel, version: v, with: (n) => swap(text, /^(__version__\s*=\s*["'])([^"']+)(["'])/m, n) }
    }
  }
  const plain = read("VERSION")?.trim()
  if (plain) return { file: "VERSION", version: plain, with: (n) => `${n}\n` }
  return undefined
}

/** The next version: patch, minor, major, or one given outright. */
export function nextVersion(current: string, how: string): string {
  if (/^v\d/.test(how)) how = how.slice(1)
  if (SEMVER.test(how)) return how
  const m = SEMVER.exec(current)
  if (!m) throw new Error(`the current version "${current}" is not x.y.z; give the new one outright`)
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])]
  // A pre-release goes to its own release: 1.2.0-beta.3 → 1.2.0.
  if (m[4] && (how === "" || how === "patch")) return `${maj}.${min}.${pat}`
  if (how === "major") return `${maj + 1}.0.0`
  if (how === "minor") return `${maj}.${min + 1}.0`
  if (how === "patch" || how === "") return `${maj}.${min}.${pat + 1}`
  throw new Error(`"${how}" is not patch, minor, major or a version`)
}

export interface ChangelogRelease {
  /** CHANGELOG.md with the Unreleased entries under the new version. */
  text: string
  /** The entries: the tag message's body. */
  notes: string
}

/** Keep a Changelog: `## [Unreleased]` keeps its place, empty, and its entries move under
 *  `## [X.Y.Z] — date`. undefined when there is nothing under Unreleased. */
export function releaseChangelog(text: string, version: string, date: string): ChangelogRelease | undefined {
  const head = /^## \[?Unreleased\]?[^\n]*\n/im.exec(text)
  if (!head) return undefined
  const start = head.index + head[0].length
  const next = /^## /m.exec(text.slice(start))
  const end = next ? start + next.index : text.length
  const notes = text.slice(start, end).trim()
  if (!notes) return undefined
  const out = `${text.slice(0, start)}\n## [${version}] — ${date}\n\n${notes}\n\n${text.slice(end)}`
  // Link references at the bottom, if the file keeps them: Unreleased compares from the new tag.
  const withLinks = out.replace(new RegExp(`^\\[Unreleased\\]:\\s*(\\S+?)\\/compare\\/(v?)(${VERSIONISH})\\.\\.\\.HEAD\\s*$`, "im"), (_m, base: string, v: string, prev: string) => `[Unreleased]: ${base}/compare/${v}${version}...HEAD\n[${version}]: ${base}/compare/${v}${prev}...${v}${version}`)
  return { text: withLinks.replace(/\n{3,}/g, "\n\n"), notes }
}

export interface ReleasePlan {
  /** Only the tag is missing: HEAD is already "Release <version>" (a tag that failed last time). */
  tagOnly?: boolean
  /** The tag message's body when there is no changelog move to take it from. */
  notes?: string
  root: string
  name: string
  from: string
  to: string
  tag: string
  versionFile: VersionFile
  changelog?: ChangelogRelease
  sign: boolean
  /** Why it cannot go ahead, if it cannot. */
  blocked?: string
}

const today = () => new Date().toISOString().slice(0, 10)
/** v-prefixed tags unless the repository's tags are not. */
const tagPrefix = (root: string) => (git(root, ["tag", "--list", "v[0-9]*"]).out || !git(root, ["tag", "--list"]).out ? "v" : "")
const signs = (root: string) => git(root, ["config", "--bool", "tag.gpgsign"]).out === "true" || git(root, ["config", "user.signingkey"]).out !== ""
function projectName(root: string): string {
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name?.replace(/^@[^/]+\//, "") || basename(root)
  } catch {
    return basename(root)
  }
}

export function planRelease(root: string, how: string): ReleasePlan | { blocked: string } {
  const vf = findVersion(root)
  if (!vf) return { blocked: "no version found (package.json, pyproject.toml, Cargo.toml, __init__.py __version__ or VERSION)" }
  const prefix = tagPrefix(root)
  // The last /release committed but could not tag (a locked key): finish that one, do not skip it.
  if (!how.trim() && git(root, ["log", "-1", "--format=%s"]).out === `Release ${vf.version}` && git(root, ["rev-parse", "-q", "--verify", `refs/tags/${prefix}${vf.version}`]).code !== 0) {
    const cl = existsSync(join(root, "CHANGELOG.md")) ? readFileSync(join(root, "CHANGELOG.md"), "utf8") : ""
    const sec = new RegExp(`^## \\[?${vf.version.replace(/\./g, "\\.")}\\]?[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m").exec(cl)?.[1]?.trim()
    return { root, name: projectName(root), from: vf.version, to: vf.version, tag: `${prefix}${vf.version}`, versionFile: vf, sign: signs(root), tagOnly: true, notes: sec }
  }
  let to: string
  try {
    to = nextVersion(vf.version, how.trim())
  } catch (e) {
    return { blocked: (e as Error).message }
  }
  const tag = `${prefix}${to}`
  if (git(root, ["rev-parse", "-q", "--verify", `refs/tags/${tag}`]).code === 0) return { blocked: `the tag ${tag} already exists` }
  const dirty = git(root, ["status", "--porcelain", "--untracked-files=no"]).out
  if (dirty) return { blocked: `the working tree has uncommitted changes — commit them first:\n${dirty}` }
  const cl = existsSync(join(root, "CHANGELOG.md")) ? releaseChangelog(readFileSync(join(root, "CHANGELOG.md"), "utf8"), to, today()) : undefined
  return { root, name: projectName(root), from: vf.version, to, tag, versionFile: vf, changelog: cl, sign: signs(root) }
}

/** Do it: write, commit by name, tag. Returns what happened, line by line. */
export function doRelease(p: ReleasePlan, push = false): { ok: boolean; lines: string[] } {
  const lines: string[] = []
  // The plan may be minutes old: the tree and the version must still be what it saw.
  const dirty = git(p.root, ["status", "--porcelain", "--untracked-files=no"]).out
  if (dirty) return { ok: false, lines: [`the working tree changed since the plan — nothing done:\n${dirty}`] }
  if (findVersion(p.root)?.version !== p.from) return { ok: false, lines: ["the version changed since the plan — nothing done; run /release again"] }
  const files = [p.versionFile.file]
  if (p.from !== p.to) {
    writeFileSync(join(p.root, p.versionFile.file), p.versionFile.with(p.to))
    for (const a of p.versionFile.also ?? []) {
      writeFileSync(join(p.root, a.file), a.with(p.to))
      files.push(a.file)
    }
  }
  if (p.changelog) {
    writeFileSync(join(p.root, "CHANGELOG.md"), p.changelog.text)
    files.push("CHANGELOG.md")
  }
  const add = git(p.root, ["add", "--", ...files])
  if (add.code) return { ok: false, lines: [`git add: ${add.err}`] }
  if (git(p.root, ["diff", "--cached", "--quiet"]).code !== 0) {
    const c = git(p.root, ["commit", "-q", "-m", `Release ${p.to}`])
    if (c.code) return { ok: false, lines: [`commit failed: ${c.err || c.out}`] }
    lines.push(`committed ${git(p.root, ["log", "-1", "--format=%h %s"]).out}`)
  }
  const message = `${p.name} ${p.to}\n\n${p.changelog?.notes ?? p.notes ?? ""}`.trim() + "\n"
  // verbatim: by default git strips every line starting with "#" — the "### Added" headings.
  const t = git(p.root, ["tag", p.sign ? "-s" : "-a", "--cleanup=verbatim", p.tag, "-F", "-"], { input: message })
  if (t.code) return { ok: false, lines: [...lines, `tag failed: ${t.err || t.out}`] }
  lines.push(`tagged ${p.tag}${p.sign ? " (signed)" : ""}`)
  if (push) {
    // The tag goes where the branch goes.
    const remote = git(p.root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).out.split("/")[0] || "origin"
    const branch = git(p.root, ["push", "-q"])
    const tag = branch.code ? branch : git(p.root, ["push", "-q", remote, p.tag])
    if (tag.code) return { ok: false, lines: [...lines, `push failed: ${tag.err || tag.out}`] }
    lines.push(`pushed the branch and ${p.tag}`)
  } else lines.push(`nothing pushed — when ready: git push && git push ${git(p.root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).out.split("/")[0] || "origin"} ${p.tag}`)
  return { ok: true, lines }
}
