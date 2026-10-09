// Worktrees for subagents: a subagent that changes files can work in a checkout of its own, on a
// branch of its own, so two of them (or one and you) never edit the same files at once. When it
// is done its changes are committed on that branch and the checkout goes; the branch stays for
// you to merge or delete. A worktree starts from HEAD: uncommitted work is not in it.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { paths } from "../config/paths.ts"
import { git } from "./run.ts"

export interface Worktree {
  dir: string
  branch: string
  base: string
}

export function createWorktree(repo: string, label: string): Worktree {
  const id = Math.random().toString(36).slice(2, 8)
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "agent"
  const branch = `lembas/${slug}-${id}`
  const dir = join(paths.data, "worktrees", createHash("sha256").update(repo).digest("hex").slice(0, 12), `${slug}-${id}`)
  mkdirSync(join(dir, ".."), { recursive: true })
  // Records of checkouts whose directories are gone (a crash, a manual rm) go first.
  git(repo, ["worktree", "prune"])
  const base = git(repo, ["rev-parse", "HEAD"]).out
  if (!base) throw new Error("the repository has no commit yet, so there is nothing to branch from")
  const r = git(repo, ["worktree", "add", "-q", "-b", branch, dir, base])
  if (r.code) throw new Error(`git worktree add: ${r.err}`)
  return { dir, branch, base }
}

export interface WorktreeResult {
  /** What to tell the model and the user. */
  summary: string
  kept: boolean
}

/** Commit what the subagent left, remove the checkout, and keep the branch only if it has work. */
export function finishWorktree(repo: string, wt: Worktree, message: string): WorktreeResult {
  // The checkout is the subagent's own, so everything in it is its work.
  git(wt.dir, ["add", "-A"])
  if (git(wt.dir, ["diff", "--cached", "--quiet"]).code !== 0) {
    const c = git(wt.dir, ["commit", "-q", "-m", message])
    if (c.code) return { summary: `Its changes could not be committed (${c.err || c.out}); they are still in ${wt.dir} on branch ${wt.branch}.`, kept: true }
  }
  const commits = Number(git(repo, ["rev-list", "--count", `${wt.base}..${wt.branch}`]).out || "0")
  git(repo, ["worktree", "remove", "--force", wt.dir])
  if (!commits) {
    git(repo, ["branch", "-D", wt.branch])
    return { summary: "It changed nothing, so its branch was removed.", kept: false }
  }
  const stat = git(repo, ["diff", "--shortstat", wt.base, wt.branch]).out.trim()
  return {
    summary: `Its work is on branch ${wt.branch} (${commits} commit${commits > 1 ? "s" : ""}: ${stat}), not in your working tree. Look with \`git diff HEAD...${wt.branch}\`; take it with \`git merge ${wt.branch}\`; drop it with \`git branch -D ${wt.branch}\`.`,
    kept: true,
  }
}
