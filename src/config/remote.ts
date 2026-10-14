// The global `remote:` block, read on its own and cheaply: what a LLeMbas instance may ask of this
// machine over the link. A running service asks for it whenever it decides something (a session
// opened, a directory listed, a terminal shared), so `lembas remote …` or an edit of config.yaml
// applies without a restart. The file is parsed again only when its mtime or size changed.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"
import { parse } from "yaml"
import { ConfigError } from "./load.ts"
import { expandHome, paths } from "./paths.ts"
import { Config, type Mode } from "./schema.ts"
import { substituteDeep } from "./substitute.ts"

export type RemoteBlock = NonNullable<Config["remote"]>

const RemoteSchema = Config.shape.remote

let cache: { file: string; stamp: string; block: RemoteBlock; error?: string } | undefined

function stampOf(file: string): string {
  try {
    const s = statSync(file)
    return `${s.mtimeMs}:${s.size}:${s.ino}`
  } catch {
    return "absent"
  }
}

/** The `remote:` block of the global config.yaml (the local one in local mode). A file that cannot
 *  be read or is invalid keeps what was read from it last (nothing, the first time: remote work off),
 *  so a half-written file never opens or closes anything; `strict` throws instead. */
export function remoteBlock(o: { strict?: boolean } = {}): RemoteBlock {
  const file = join(paths.config, "config.yaml")
  const stamp = stampOf(file)
  if (!cache || cache.file !== file || cache.stamp !== stamp) {
    const last = cache?.file === file ? cache.block : {}
    let block: RemoteBlock = {}
    let error: string | undefined
    if (stamp !== "absent") {
      try {
        const raw = parse(readFileSync(file, "utf8")) as { remote?: unknown } | null
        const value = raw && typeof raw === "object" ? raw.remote : undefined
        const r = RemoteSchema.safeParse(value === undefined || value === null ? undefined : substituteDeep(value, "remote"))
        if (r.success) block = r.data ?? {}
        else {
          error = `${file}: remote is invalid: ${r.error.issues.map((i) => `${["remote", ...i.path].join(".")}: ${i.message}`).join("; ")}`
          block = last
        }
      } catch (e) {
        error = `${file}: ${(e as Error).message}`
        block = last
      }
    }
    cache = { file, stamp, block, ...(error ? { error } : {}) }
  }
  if (o.strict && cache.error) throw new ConfigError(cache.error)
  return cache.block
}

/** What `lembas remote list --json` prints: the values in force, defaults applied. */
export interface RemoteState {
  enabled: boolean
  roots: string[]
  max_mode: Mode
  terminal: boolean
}

export function remoteState(b: RemoteBlock = remoteBlock()): RemoteState {
  return {
    enabled: b.enabled === true,
    roots: (b.roots ?? []).map((r) => resolve(expandHome(r))),
    max_mode: b.max_mode ?? "edit",
    terminal: b.terminal === true,
  }
}

/** A path as it really is (links followed), or as written where it does not exist. */
export function realOrResolved(p: string): string {
  const abs = resolve(expandHome(p))
  try {
    return realpathSync(abs)
  } catch {
    return abs
  }
}

/** `dir` is one of `roots` or under one of them. */
export function coveredBy(dir: string, roots: string[]): string | undefined {
  const target = realOrResolved(dir)
  return roots.find((r) => {
    const rel = relative(realOrResolved(r), target)
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
  })
}

/** A directory given on the command line, as stored in `remote.roots`: absolute, links followed.
 *  A string says why it cannot be one. */
export function rootFor(dir: string, cwd = process.cwd()): string | { error: string } {
  const abs = resolve(cwd, expandHome(dir))
  if (!existsSync(abs)) return { error: `${dir}: no such directory` }
  if (!statSync(abs).isDirectory()) return { error: `${dir}: not a directory` }
  return realpathSync(abs)
}
