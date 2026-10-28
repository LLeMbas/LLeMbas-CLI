// Local mode: `lembas -l` / `lembas --local`. Everything LLeMbas CLI keeps — config, sessions,
// memory, skills, the library, snapshots, worktrees, caches, trust, history — lives in the project,
// under its per-user directory (`.agent/local/lembas/`, git-ignored), and nothing is written
// anywhere else.
//
// What it reads from outside: only the login — the user's connections.yaml, lembas.json and the key
// files they name — read-only, so the connections and sign-ins work without being copied. The
// user's config.yaml is not read; the local one is this mode's global config. A LLeMbas instance
// is used for models, chat, speech in and out, and the usage, and for nothing that is kept there
// or shown there: no link, no shared sessions, no deletes sent, no server library, no search or
// fetch through it, no embeddings through it, no account personalization.
import { chmodSync, existsSync, mkdirSync } from "node:fs"
import { join, relative } from "node:path"
import { isLocal, localRoot, setLocalRoot } from "../config/paths.ts"
import { ignoreLocal } from "./init.ts"
import { findProject, type Project } from "./root.ts"

export class LocalError extends Error {}

/** The flags that turn it on. */
export const LOCAL_FLAGS = ["-l", "--local"]

/** What `-l` would use for `cwd`: the project's root (the nearest directory of ours, else the git
 *  root, else `cwd` itself) and, under its per-user directory, the local root. */
export function localFor(cwd: string): { project: Project; root: string } {
  const project = findProject(cwd)
  return { project, root: join(project.dir, "local", "lembas") }
}

/** Files of the local root the repository carries: settings, keys or sessions that came with a
 *  clone. Local mode refuses them — they would be somebody else's config passed off as yours. */
function tracked(project: Project, root: string): string[] {
  if (!project.gitRoot) return []
  const r = Bun.spawnSync(["git", "-C", project.gitRoot, "ls-files", "--", relative(project.gitRoot, root)], { stdout: "pipe", stderr: "pipe" })
  if (r.exitCode !== 0) return []
  return r.stdout.toString().split("\n").filter(Boolean)
}

/** Turn local mode on for `cwd`: make the local root (mode 700), keep it out of git, and root
 *  config, data and state there for the rest of this process. Returns what was done, in words. */
export function enterLocal(cwd: string): { project: Project; root: string; notes: string[] } {
  const { project, root } = localFor(cwd)
  const carried = tracked(project, root)
  if (carried.length)
    throw new LocalError(
      `${relative(project.root, root)} is in the repository (${carried.slice(0, 3).join(", ")}${carried.length > 3 ? ", …" : ""}): local mode keeps your own settings and keys there, and will not use files that came with a clone — remove them from git first`,
    )
  const notes: string[] = []
  const fresh = !existsSync(root)
  for (const sub of ["config", "data", "state"]) mkdirSync(join(root, sub), { recursive: true, mode: 0o700 })
  try {
    chmodSync(root, 0o700)
  } catch {}
  if (fresh) notes.push(`local mode: everything is kept in ${relative(project.root, root) || "."}`)
  if (ignoreLocal(project)) notes.push(`added the per-user ${relative(project.root, join(project.dir, "local"))}/ to .gitignore`)
  setLocalRoot(root)
  mkdirSync(localTmp(root), { recursive: true, mode: 0o700 })
  // The TUI library's own cache (its tree-sitter parsers, under XDG_DATA_HOME/opentui), set
  // before it is loaded. The commands the agent runs keep the environment they were started with:
  // tool/bash.ts takes it before this runs.
  process.env.XDG_DATA_HOME = join(root, "data")
  return { project, root, notes }
}

/** Local mode's temporary directory. The TUI runs with TMPDIR set to it from its very start — the
 *  compiled binary unpacks its native library there, and reads TMPDIR only once, as it starts
 *  (cli.ts starts it again with it set). */
export function localTmp(root: string): string {
  return join(root, "state", "tmp")
}

/** The one-line refusal for what local mode turns off. */
export function localRefusal(what: string): string {
  return `${what} is off in local mode (-l): nothing is shared with or kept on a server, and nothing is written outside ${localRoot() ?? "the project"}`
}

/** Refuse when in local mode: the refusal, or undefined. */
export function refusedLocally(what: string): string | undefined {
  return isLocal() ? localRefusal(what) : undefined
}
