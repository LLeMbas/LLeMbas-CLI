import { homedir } from "node:os"
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

export const paths = {
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

export function expandHome(p: string): string {
  if (p === "~") return homedir()
  if (p.startsWith("~/")) return join(homedir(), p.slice(2))
  return p
}
