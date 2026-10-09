import { git } from "./run.ts"

export interface RepoState {
  branch: string
  upstream?: string
  ahead: number
  behind: number
  /** Changed paths, as `git status --porcelain` codes: " M src/a.ts", "?? new.txt". */
  changes: string[]
  recent: string[]
  detached: boolean
}

/** Branch, divergence, working-tree changes and the last commits — or undefined outside a repo. */
export function repoState(root: string, commits = 5): RepoState | undefined {
  const st = git(root, ["status", "--porcelain=v1", "--branch", "--untracked-files=normal"])
  if (st.code !== 0) return undefined
  const [head = "", ...changes] = st.out.split("\n")
  // "## main...origin/main [ahead 2, behind 1]" | "## HEAD (no branch)" | "## No commits yet on main"
  const m = /^## (?:No commits yet on )?(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/.exec(head)
  const detached = head.includes("(no branch)")
  const info = m?.[3] ?? ""
  const log = git(root, ["log", `-${commits}`, "--format=%h %s"])
  return {
    branch: detached ? "HEAD (detached)" : (m?.[1] ?? "?"),
    upstream: m?.[2],
    ahead: Number(/ahead (\d+)/.exec(info)?.[1] ?? 0),
    behind: Number(/behind (\d+)/.exec(info)?.[1] ?? 0),
    changes: changes.filter(Boolean),
    recent: log.code === 0 && log.out ? log.out.split("\n") : [],
    detached,
  }
}

/** The git block of the system prompt. */
export function describeRepo(s: RepoState): string {
  const lines = [`Branch: ${s.branch}${s.upstream ? ` (tracking ${s.upstream}${s.ahead || s.behind ? `, ahead ${s.ahead}, behind ${s.behind}` : ", up to date"})` : " (no upstream)"}`]
  if (s.changes.length) {
    const shown = s.changes.slice(0, 20).map((c) => `  ${c}`)
    lines.push(`Uncommitted changes (${s.changes.length}):`, ...shown, ...(s.changes.length > 20 ? [`  … ${s.changes.length - 20} more`] : []))
  } else lines.push("Working tree clean.")
  if (s.recent.length) lines.push("Recent commits:", ...s.recent.map((c) => `  ${c}`))
  else lines.push("No commits yet.")
  return lines.join("\n")
}

export function gitInit(root: string): { ok: boolean; message: string } {
  const r = git(root, ["init", "-q", "-b", "main"])
  return r.code === 0 ? { ok: true, message: `initialised an empty git repository in ${root} (branch main, no remote)` } : { ok: false, message: r.err }
}
