// /branch: list, switch to, make and delete local branches. Plain git, and git's own refusals
// stand: a switch that would overwrite uncommitted work, or deleting a branch that is not merged,
// is refused by git and the reason is shown — nothing here forces either.
import { git } from "./run.ts"

export interface Branch {
  name: string
  current: boolean
  /** Last commit: short hash and subject. */
  last: string
  /** Unix ms of the last commit. */
  at: number
  upstream?: string
}

export function branches(root: string): Branch[] {
  const r = git(root, ["for-each-ref", "--sort=-committerdate", "--format=%(HEAD)%00%(refname:short)%00%(objectname:short) %(contents:subject)%00%(committerdate:unix)%00%(upstream:short)", "refs/heads/"])
  if (r.code !== 0 || !r.out) return []
  return r.out.split("\n").map((l) => {
    const [head = "", name = "", last = "", at = "0", upstream = ""] = l.split("\0")
    return { name, current: head === "*", last, at: Number(at) * 1000, upstream: upstream || undefined }
  })
}

export function currentBranch(root: string): string | undefined {
  const r = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"])
  return r.code === 0 ? r.out : undefined
}

/** Why a name cannot be a branch, or undefined when it can. */
export function badBranchName(root: string, name: string): string | undefined {
  if (!name) return "no name given"
  if (name.startsWith("-")) return "a branch name cannot start with -"
  return git(root, ["check-ref-format", "--branch", name]).code === 0 ? undefined : `"${name}" is not a valid branch name`
}

export interface BranchResult {
  ok: boolean
  text: string
}

/** Switch to a branch, making it from HEAD when it does not exist yet. Uncommitted changes go
 *  along when git can carry them; when it cannot, git refuses and nothing changes. */
export function switchBranch(root: string, name: string): BranchResult {
  const bad = badBranchName(root, name)
  if (bad) return { ok: false, text: bad }
  if (currentBranch(root) === name) return { ok: true, text: `already on ${name}` }
  const exists = git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]).code === 0
  const r = git(root, exists ? ["switch", "--quiet", name] : ["switch", "--quiet", "-c", name])
  if (r.code !== 0) return { ok: false, text: r.err || r.out }
  return { ok: true, text: exists ? `switched to ${name}` : `made ${name} from ${git(root, ["log", "-1", "--format=%h %s"]).out || "an empty history"} and switched to it` }
}

/** `git branch -d`: only a branch whose work is merged. The current branch cannot be deleted. */
export function deleteBranch(root: string, name: string): BranchResult {
  if (currentBranch(root) === name) return { ok: false, text: `${name} is the current branch — switch to another first` }
  const r = git(root, ["branch", "-d", "--", name])
  if (r.code === 0) return { ok: true, text: `deleted ${name}` }
  if (/not fully merged/.test(r.err)) return { ok: false, text: `${name} has work that is not merged anywhere, so it was kept. If it really should go: git branch -D ${name}` }
  return { ok: false, text: r.err || r.out }
}
