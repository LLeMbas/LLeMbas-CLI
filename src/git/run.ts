// Plain git, synchronously. Every call is scoped with -C; output is trimmed text.
export interface GitResult {
  code: number
  out: string
  err: string
}

export function git(cwd: string, args: string[], opts: { env?: Record<string, string>; input?: string; timeoutMs?: number } = {}): GitResult {
  // core.fsmonitor names a program git runs on status — off for every call made here, before and
  // after a project is trusted.
  const r = Bun.spawnSync(["git", "-c", "core.quotepath=false", "-c", "core.fsmonitor=false", "-C", cwd, ...args], {
    // Nothing may hang the app: a signing key that wants a passphrase, a slow hook.
    timeout: opts.timeoutMs ?? 120_000,
    stdout: "pipe",
    stderr: "pipe",
    stdin: opts.input !== undefined ? new TextEncoder().encode(opts.input) : "ignore",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", LC_ALL: "C", ...opts.env },
  })
  const err = r.stderr.toString().trim()
  return { code: r.exitCode ?? 1, out: r.stdout.toString().replace(/\s+$/, ""), err: r.exitCode === null && !err ? `git ${args[0]} did not finish in ${Math.round((opts.timeoutMs ?? 120_000) / 1000)} s (a key waiting for a passphrase? a slow hook?)` : err }
}

export const hasGit = Bun.which("git") !== null
