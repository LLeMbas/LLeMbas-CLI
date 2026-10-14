import { existsSync, mkdirSync, mkdtempSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"

/** An environment variable under its LLeMbas CLI name: LEMBAS_<name>. */
export function env(name: string): string | undefined {
  return process.env[`LEMBAS_${name}`]
}

// XDG base directories, overridable for tests with LEMBAS_HOME (which roots all three).
function base(envVar: string, fallback: string): string {
  const root = env("HOME")
  if (root) return join(root, fallback.split("/").pop()!)
  // The XDG spec: a relative value is to be ignored (it would mean wherever the CLI was started).
  const v = process.env[envVar]
  return v && isAbsolute(v) ? v : join(homedir(), fallback)
}

const dir = (parent: string): string => join(parent, "lembas")

/** Local mode (`lembas -l`): the one directory everything of LLeMbas CLI's lives in — config,
 *  data and state — inside the project (project/local.ts). Unset: the usual three. */
let local: string | undefined

export function setLocalRoot(root: string | undefined) {
  local = root
}

/** The local root, in local mode. */
export const localRoot = (): string | undefined => local

export const isLocal = (): boolean => local !== undefined

/** The user's own three directories, whatever the mode. In local mode only the login is read from
 *  them (connections.yaml, lembas.json and the key files it names), and nothing is written there. */
export const globalPaths = {
  get config() {
    return dir(base("XDG_CONFIG_HOME", ".config"))
  },
  get data() {
    return dir(base("XDG_DATA_HOME", ".local/share"))
  },
  get state() {
    return dir(base("XDG_STATE_HOME", ".local/state"))
  },
}

/** Where LLeMbas CLI reads and writes its own files: the user's three directories, or the
 *  local root's in local mode. */
export const paths = {
  get config() {
    return local ? join(local, "config") : globalPaths.config
  },
  get data() {
    return local ? join(local, "data") : globalPaths.data
  },
  get state() {
    return local ? join(local, "state") : globalPaths.state
  },
}

export function expandHome(p: string): string {
  if (p === "~") return homedir()
  if (p.startsWith("~/")) return join(homedir(), p.slice(2))
  return p
}

/** A fresh temporary directory for LLeMbas CLI's own scratch files (speech being played or
 *  converted): the system's, or `state/tmp` in local mode, so nothing is left outside the project. */
export function makeTempDir(prefix: string): string {
  const parent = local ? join(local, "state", "tmp") : tmpdir()
  if (local) mkdirSync(parent, { recursive: true, mode: 0o700 })
  return mkdtempSync(join(parent, prefix))
}

/** The connections files read, in order: in local mode the user's own (read-only) and then the
 *  local one; otherwise the one. Only those that exist. */
export function connectionFiles(): string[] {
  const own = join(paths.config, "connections.yaml")
  const all = isLocal() ? [join(globalPaths.config, "connections.yaml"), own] : [own]
  return all.filter((f) => existsSync(f))
}
