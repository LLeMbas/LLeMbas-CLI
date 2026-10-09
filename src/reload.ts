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

function execv(argv: string[]): Error {
  try {
    const { dlopen, FFIType, ptr } = require("bun:ffi") as typeof import("bun:ffi")
    const libc = dlopen("libc.so.6", {
      execv: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
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
    const strings = argv.map((a) => Buffer.from(`${a}\0`))
    const table = new BigUint64Array(strings.length + 1)
    strings.forEach((s, i) => (table[i] = BigInt(ptr(s))))
    libc.symbols.execv(ptr(strings[0]!), ptr(table))
    // execv returns only when it failed.
    return new Error("execv failed")
  } catch (e) {
    return e as Error
  }
}

/** Never returns: the new program runs, in this process or a child this one waits for. */
export async function restart(args: string[]): Promise<never> {
  const argv = selfCommand(args)
  execv(argv)
  const child = Bun.spawn(argv, { stdio: ["inherit", "inherit", "inherit"] })
  process.exit(await child.exited)
}
