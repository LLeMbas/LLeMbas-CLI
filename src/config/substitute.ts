import { readFileSync } from "node:fs"
import { expandHome } from "./paths.ts"

// `{env:NAME}` and `{file:path}` inside any string value of a config file.
// A missing variable or file is an error, not an empty string: an empty API key
// fails later and far from the cause.
const TOKEN = /\{(env|file):([^}]+)\}/g

export class SubstitutionError extends Error {}

export function substitute(value: string, where: string): string {
  return value.replace(TOKEN, (_, kind: string, arg: string) => {
    const name = arg.trim()
    if (kind === "env") {
      const v = process.env[name]
      if (v === undefined) throw new SubstitutionError(`${where}: environment variable ${name} is not set`)
      return v
    }
    try {
      return readFileSync(expandHome(name), "utf8").trim()
    } catch {
      throw new SubstitutionError(`${where}: cannot read file ${name}`)
    }
  })
}

export function substituteDeep<T>(value: T, where = "config"): T {
  if (typeof value === "string") return substitute(value, where) as T
  if (Array.isArray(value)) return value.map((v, i) => substituteDeep(v, `${where}[${i}]`)) as T
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = substituteDeep(v, `${where}.${k}`)
    return out as T
  }
  return value
}

// `key_cmd`: run a command and use its trimmed stdout, e.g. `pass show api/anthropic`.
export function runKeyCmd(cmd: string, where: string): string {
  const res = Bun.spawnSync(["sh", "-c", cmd], { stdout: "pipe", stderr: "pipe" })
  if (res.exitCode !== 0) {
    throw new SubstitutionError(`${where}: key_cmd exited ${res.exitCode}: ${res.stderr.toString().trim()}`)
  }
  const out = res.stdout.toString().trim()
  if (!out) throw new SubstitutionError(`${where}: key_cmd printed nothing`)
  return out
}
