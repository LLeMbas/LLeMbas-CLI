// Checks of this machine that `lembas config check` reports.
//
// A LLeMbas server installed with pip may bring a console script called `lembas` too (the server
// itself runs as `lembas-server`). Installed into a directory
// that comes first on PATH, it is what `lembas` runs — and the person typing it gets a Python
// traceback or a web server instead of this program. install.sh says so when it installs; this says
// so whenever the configuration is checked.
import { accessSync, constants, openSync, readSync, closeSync, realpathSync, statSync } from "node:fs"
import { delimiter, dirname, join } from "node:path"

/** The first `lembas` on `path`, the way a shell finds it. */
export function firstOnPath(name: string, path = process.env.PATH ?? ""): string | undefined {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue
    const f = join(dir, name)
    try {
      if (!statSync(f).isFile()) continue
      accessSync(f, constants.X_OK)
      return f
    } catch {}
  }
  return undefined
}

function real(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/** Whether a file is a Python script (its first line a `#!` naming python). */
export function isPythonScript(file: string): boolean {
  try {
    const fd = openSync(real(file), "r")
    const buf = Buffer.alloc(300)
    const n = readSync(fd, buf, 0, 300, 0)
    closeSync(fd)
    const first = buf.subarray(0, n).toString("utf8").split("\n")[0] ?? ""
    return first.startsWith("#!") && /python/.test(first)
  } catch {
    return false
  }
}

/** Why `lembas` typed in a shell would not run this program, or undefined when it would (or this
 *  cannot tell: run from source, nothing on PATH). `self`: this binary — undefined from source, where
 *  only a Python script is recognised as the wrong one. */
export function lembasShadowed(o: { path?: string; self?: string } = {}): string | undefined {
  const self = "self" in o ? o.self : /(^|\/)bun$/.test(process.execPath) ? undefined : process.execPath
  const found = firstOnPath("lembas", o.path)
  if (!found) return undefined
  if (self && real(found) === real(self)) return undefined
  const python = isPythonScript(found)
  if (!python && !self) return undefined
  const what = python ? "a Python console script — most likely the LLeMbas server's own `lembas`" : "another program"
  return `\`lembas\` runs ${found}, ${what}, not this LLeMbas CLI${self ? ` (${self})` : ""}. Put ${self ? dirname(self) : "the directory LLeMbas CLI is installed in"} before ${dirname(found)} in PATH, or remove that one — the server itself runs as lembas-server.`
}
