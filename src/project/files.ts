// The project's file list for @ completion: ripgrep when present (honours .gitignore), a walk
// otherwise; refreshed at most every few seconds. Ranked with fuzzysort, nudged by frecency.
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import fuzzysort from "fuzzysort"
import { paths } from "../config/paths.ts"

const MAX = 50_000
const IGNORED = ["node_modules", ".git", "dist", "build", ".venv", "venv", "__pycache__", "target", ".next", ".cache"]
const hasRg = Bun.which("rg") !== null

export class FileIndex {
  private files: string[] = []
  private dirs: string[] = []
  private at = 0
  private frecency: Record<string, { n: number; t: number }>

  constructor(readonly root: string) {
    this.frecency = readFrecency()[root] ?? {}
  }

  private refresh() {
    if (Date.now() - this.at < 5000) return
    this.at = Date.now()
    let list: string[] = []
    if (hasRg) {
      const r = Bun.spawnSync(["rg", "--files", "--hidden", "--glob", "!.git"], { cwd: this.root, stdout: "pipe", stderr: "ignore" })
      list = r.stdout.toString().split("\n").filter(Boolean)
    } else {
      for (const f of new Bun.Glob("**/*").scanSync({ cwd: this.root, dot: true, onlyFiles: true })) {
        if (f.split("/").some((s) => IGNORED.includes(s))) continue
        list.push(f)
        if (list.length >= MAX) break
      }
    }
    this.files = list.slice(0, MAX).sort()
    const dirs = new Set<string>()
    for (const f of this.files) {
      const parts = f.split("/")
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/") + "/")
    }
    this.dirs = [...dirs].sort()
  }

  /** Best matches for what was typed after @. A trailing / lists that directory's children. */
  search(query: string, limit = 8): string[] {
    this.refresh()
    const q = query.replace(/#.*$/, "")
    const all = [...this.dirs, ...this.files]
    if (!q) return this.recent(limit)
    if (q.endsWith("/")) return all.filter((p) => p.startsWith(q) && p !== q && !p.slice(q.length).replace(/\/$/, "").includes("/")).slice(0, limit)
    const hits = fuzzysort.go(q, all, { limit: 200, threshold: -10000 })
    return hits
      .map((h) => ({ p: h.target, score: h.score + this.boost(h.target) - h.target.length / 1000 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.p)
  }

  private recent(limit: number): string[] {
    return Object.entries(this.frecency)
      .sort((a, b) => b[1].t - a[1].t)
      .map(([p]) => p)
      .filter((p) => this.files.includes(p))
      .slice(0, limit)
  }

  /** Frecency: used often and lately ranks higher. fuzzysort scores are ≤ 1; this adds up to ~0.3. */
  private boost(p: string): number {
    const f = this.frecency[p]
    if (!f) return 0
    const days = (Date.now() - f.t) / 86_400_000
    return Math.min(0.3, (Math.log2(f.n + 1) * 0.1) / (1 + days))
  }

  used(p: string) {
    const f = (this.frecency[p] ??= { n: 0, t: 0 })
    f.n++
    f.t = Date.now()
    const all = readFrecency()
    all[this.root] = this.frecency
    try {
      mkdirSync(paths.state, { recursive: true })
      writeFileSync(join(paths.state, "frecency.json"), JSON.stringify(all))
    } catch {}
  }

  isDir(p: string): boolean {
    try {
      return statSync(join(this.root, p)).isDirectory()
    } catch {
      return false
    }
  }
}

function readFrecency(): Record<string, Record<string, { n: number; t: number }>> {
  try {
    return JSON.parse(readFileSync(join(paths.state, "frecency.json"), "utf8"))
  } catch {
    return {}
  }
}
