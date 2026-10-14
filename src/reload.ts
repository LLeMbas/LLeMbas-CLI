// /reload: start LLeMbas CLI again in place — the binary as it is on disk now (an update installed
// while it ran), every config file read afresh — back on the same session. The process replaces
// itself (execv), so the PID, the terminal and the shell's job stay what they were; where execv
// is not to be had, a child takes over and this process waits for it.
import { fstatSync, readdirSync } from "node:fs"

/** The command line that starts this program again: the compiled binary, or bun and the script. */
export function selfCommand(args: string[]): string[] {
  const compiled = Bun.main.startsWith("/$bunfs/")
  return compiled ? [process.execPath, ...args] : [process.execPath, Bun.main, ...args]
}

/** execv, or execve with `env` when given (local mode's start: TMPDIR must be set before the
 *  runtime reads it). */
function execv(argv: string[], env?: Record<string, string | undefined>): Error {
  try {
    const { dlopen, FFIType, ptr } = require("bun:ffi") as typeof import("bun:ffi")
    const libc = dlopen("libc.so.6", {
      execv: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      execve: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    })
    // Everything above stdio closes on exec: an open database, an MCP server's pipe would otherwise
    // live on, unknown, in the new program. Marked rather than closed, so a failed exec leaves this
    // process whole for the fallback.
    const F_SETFD = 2
    const FD_CLOEXEC = 1
    // Every open descriptor, however high: /proc/self/fd lists them.
    let fds: number[]
    try {
      fds = readdirSync("/proc/self/fd").map(Number).filter((n) => n >= 3)
    } catch {
      fds = Array.from({ length: 4093 }, (_, i) => i + 3)
    }
    for (const fd of fds) {
      try {
        fstatSync(fd)
        libc.symbols.fcntl(fd, F_SETFD, FD_CLOEXEC)
      } catch {}
    }
    const table = (items: string[]) => {
      const strings = items.map((a) => Buffer.from(`${a}\0`))
      const t = new BigUint64Array(strings.length + 1)
      strings.forEach((s, i) => (t[i] = BigInt(ptr(s))))
      return { strings, t }
    }
    const args = table(argv)
    if (env) {
      const vars = table(Object.entries(env).flatMap(([k, v]) => (v === undefined ? [] : [`${k}=${v}`])))
      libc.symbols.execve(ptr(args.strings[0]!), ptr(args.t), ptr(vars.t))
    } else libc.symbols.execv(ptr(args.strings[0]!), ptr(args.t))
    // execv returns only when it failed.
    return new Error("execv failed")
  } catch (e) {
    return e as Error
  }
}

/** Never returns: the new program runs, in this process or a child this one waits for. */
export async function restart(args: string[], env?: Record<string, string | undefined>): Promise<never> {
  const argv = selfCommand(args)
  execv(argv, env)
  const child = Bun.spawn(argv, { stdio: ["inherit", "inherit", "inherit"], ...(env ? { env } : {}) })
  process.exit(await child.exited)
}
