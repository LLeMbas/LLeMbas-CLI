// Snapshots of the working tree in a shadow git repository — the idea of OpenCode's
// snapshot/index.ts, written small. The shadow repo lives in ~/.local/share/lembas/snapshot/,
// never inside the project, and works whether or not the project itself uses git.
//
//   track()            → a tree hash for the working tree as it is now
//   changed(a, b)      → paths that differ between two trees
//   restore(tree, ps)  → put those paths back as they were in `tree` (deleting ones it lacks)
//   checkpoint(label)  → a named snapshot that outlives the session (/checkpoint)
//
// Restoring by path, never the whole tree, is what makes /undo safe: files the turn did not
// touch are left alone, whatever happened to them since.
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { paths } from "../config/paths.ts"
import { LOCAL_DIRS } from "../project/root.ts"
import { git } from "./run.ts"

const MAX_FILES = 20_000
const MAX_FILE_BYTES = 2 * 1024 * 1024

/** A named snapshot: a commit in the shadow store under refs/checkpoints/, so it is kept. */
export interface Checkpoint {
  ref: string
  label: string
  at: number
  tree: string
}

export class Snapshots {
  readonly gitdir: string
  enabled = true
  reason = ""
  private ready = false
  private bigExcluded = new Set<string>()

  constructor(
    readonly root: string,
    readonly realGitRoot?: string,
    private maxFiles = MAX_FILES,
  ) {
    const id = createHash("sha1").update(root).digest("hex").slice(0, 16)
    this.gitdir = join(paths.data, "snapshot", id)
  }

  private g(args: string[], input?: string) {
    return git(this.root, ["--git-dir", this.gitdir, "--work-tree", this.root, "-c", "core.autocrlf=false", ...args], { input })
  }

  private init(): boolean {
    if (this.ready) return this.enabled
    this.ready = true
    if (!existsSync(join(this.gitdir, "HEAD"))) {
      mkdirSync(this.gitdir, { recursive: true })
      const r = git(this.root, ["init", "-q", "--bare", this.gitdir])
      if (r.code !== 0) return this.disable(`cannot create the snapshot store: ${r.err}`)
      for (const [k, v] of [["core.autocrlf", "false"], ["core.fsmonitor", "false"], ["gc.auto", "0"], ["core.bare", "false"]] as const)
        git(this.root, ["--git-dir", this.gitdir, "config", k, v])
    }
    // Borrow the project's own object store: files git already hashed are not hashed again.
    if (this.realGitRoot) {
      const common = git(this.realGitRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
      if (common.code === 0 && existsSync(join(common.out, "objects"))) {
        mkdirSync(join(this.gitdir, "objects", "info"), { recursive: true })
        writeFileSync(join(this.gitdir, "objects", "info", "alternates"), join(common.out, "objects") + "\n")
      }
    }
    this.writeExcludes()
    const count = this.g(["ls-files", "--others", "--cached", "--exclude-standard", "-z"])
    const n = count.out ? count.out.split("\0").filter(Boolean).length : 0
    if (n > this.maxFiles) return this.disable(`${n} files — too many to snapshot (limit ${this.maxFiles}); /undo is off here`)
    return true
  }

  private disable(reason: string): false {
    this.enabled = false
    this.reason = reason
    return false
  }

  private writeExcludes() {
    const lines = ["/.git", ...LOCAL_DIRS.map((d) => `/${d}`), "node_modules/", ...[...this.bigExcluded].map((p) => `/${p}`)]
    if (this.realGitRoot) {
      const own = join(this.realGitRoot, ".git", "info", "exclude")
      if (existsSync(own)) lines.push(readFileSync(own, "utf8"))
    }
    mkdirSync(join(this.gitdir, "info"), { recursive: true })
    writeFileSync(join(this.gitdir, "info", "exclude"), lines.join("\n") + "\n")
  }

  /** Keep new large files (logs, builds, media) out: a snapshot store is not a backup. */
  private excludeBig() {
    const others = this.g(["ls-files", "--others", "--exclude-standard", "-z"])
    let added = false
    for (const p of others.out.split("\0").filter(Boolean)) {
      try {
        if (statSync(join(this.root, p)).size > MAX_FILE_BYTES && !this.bigExcluded.has(p)) {
          this.bigExcluded.add(p)
          added = true
        }
      } catch {}
    }
    if (added) this.writeExcludes()
  }

  /** The working tree now, as a tree hash; undefined when snapshots are off. */
  track(): string | undefined {
    if (!this.init()) return undefined
    this.excludeBig()
    const add = this.g(["add", "--all", "--", "."])
    if (add.code !== 0) {
      this.disable(`snapshot failed: ${add.err.split("\n")[0]}`)
      return undefined
    }
    const tree = this.g(["write-tree"])
    return tree.code === 0 ? tree.out : undefined
  }

  changed(from: string, to: string): string[] {
    const r = this.g(["diff", "--name-only", "--no-renames", "-z", from, to, "--", "."])
    return r.code === 0 ? r.out.split("\0").filter(Boolean) : []
  }

  /** Unified diff between two trees (or from a tree to the working tree when `to` is omitted). */
  diff(from: string, to?: string): string {
    const r = this.g(["diff", "--no-ext-diff", "--no-renames", "--no-color", from, ...(to ? [to] : []), "--", "."])
    return r.code === 0 ? r.out : ""
  }

  /** Save the working tree as it is now under a name. Its objects are copied into the shadow
   *  store: the project's own store (borrowed for speed) may drop them in a gc, and a checkpoint
   *  can be weeks old by the time it is wanted. */
  checkpoint(label: string): Checkpoint | undefined {
    const tree = this.track()
    if (!tree) return undefined
    const at = Date.now()
    const c = this.g(["-c", "user.name=lembas", "-c", "user.email=lembas@localhost", "commit-tree", tree, "-m", label])
    if (c.code !== 0) return undefined
    const ref = `refs/checkpoints/${at.toString(36)}${Math.random().toString(36).slice(2, 5)}`
    if (this.g(["update-ref", ref, c.out]).code !== 0) return undefined
    this.g(["pack-objects", "--revs", "--quiet", join(this.gitdir, "objects", "pack", "pack")], `${c.out}\n`)
    return { ref, label, at, tree }
  }

  /** Checkpoints of this project, newest first. */
  checkpoints(): Checkpoint[] {
    if (!this.init()) return []
    const r = this.g(["for-each-ref", "--sort=-creatordate", "--format=%(refname)%00%(tree)%00%(creatordate:unix)%00%(contents:subject)", "refs/checkpoints/"])
    if (r.code !== 0 || !r.out) return []
    // The ref's name carries the time to the millisecond (git's dates stop at the second).
    return r.out
      .split("\n")
      .map((l) => {
        const [ref = "", tree = "", at = "0", label = ""] = l.split("\0")
        const ms = Number.parseInt(ref.slice("refs/checkpoints/".length, -3), 36)
        return { ref, tree, at: Number.isFinite(ms) ? ms : Number(at) * 1000, label }
      })
      .sort((a, b) => b.at - a.at)
  }

  dropCheckpoint(ref: string): boolean {
    return ref.startsWith("refs/checkpoints/") && this.g(["update-ref", "-d", ref]).code === 0
  }

  /** Put the working tree back as it was at a checkpoint — only the files that differ. What was
   *  there is saved first as a checkpoint of its own, so a restore can itself be undone. */
  restoreCheckpoint(cp: Checkpoint): { files: string[]; saved?: Checkpoint } | undefined {
    const saved = this.checkpoint(`before going back to "${cp.label}"`)
    if (!saved) return undefined
    const files = this.changed(cp.tree, saved.tree)
    if (!files.length) {
      this.dropCheckpoint(saved.ref)
      return { files }
    }
    return { files: this.restore(cp.tree, files), saved }
  }

  /** Put `files` back as they are in `tree`; a file the tree does not have is deleted. */
  restore(tree: string, files: string[]): string[] {
    const done: string[] = []
    for (const f of files) {
      const has = this.g(["ls-tree", "--name-only", tree, "--", f]).out.trim() !== ""
      if (has) {
        const r = this.g(["checkout", tree, "--", f])
        if (r.code === 0) done.push(f)
      } else {
        rmSync(join(this.root, f), { force: true })
        done.push(f)
      }
    }
    return done
  }
}
