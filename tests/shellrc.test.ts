// Shell integration in terminals opened from the web UI: the rc wrappers for bash, zsh and
// fish, and each shell run for real in a PTY (where installed) — the user's own startup files read
// first, then prompts, commands and exit status marked (OSC 133) and the directory said (OSC 7).
import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { shellKind, shellLaunch, type ShellLaunch } from "../src/acp/shellrc.ts"

const launched: ShellLaunch[] = []
afterEach(() => {
  for (const l of launched.splice(0)) l.cleanup()
})
const launch = (...a: Parameters<typeof shellLaunch>) => {
  const l = shellLaunch(...a)
  launched.push(l)
  return l
}

test("which shells get marks: bash, zsh and fish; anything else starts as before", () => {
  expect(shellKind("/usr/bin/bash")).toBe("bash")
  expect(shellKind("/bin/zsh")).toBe("zsh")
  expect(shellKind("/usr/local/bin/fish")).toBe("fish")
  expect(shellKind("/bin/dash")).toBe("other")
  expect(launch("/bin/dash", "t1", true)).toMatchObject({ kind: "other", integration: false, argv: ["/bin/dash", "-l"], env: {} })
  expect(launch("/bin/bash", "t2", false)).toMatchObject({ kind: "bash", integration: false, argv: ["/bin/bash", "-l"] })
})

test("bash: the login files read as a login shell would, /etc/bash.bashrc once, logout kept", () => {
  const l = launch("/bin/bash", "b1", true)
  expect(l.integration).toBe(true)
  expect(l.argv.slice(1, 2)).toEqual(["--rcfile"])
  const rc = readFileSync(l.argv[2]!, "utf8")
  // /etc/profile with PS1 unset: Debian's reads /etc/bash.bashrc again when PS1 is set, and bash
  // has already read it before this file.
  const sourced = rc.indexOf("[ -r /etc/profile ] && . /etc/profile")
  expect(rc.indexOf("\nunset PS1")).toBeLessThan(sourced)
  expect(rc.indexOf("\nPS1=$__lembas_ps1")).toBeGreaterThan(sourced)
  expect(sourced).toBeLessThan(rc.indexOf("__lembas_prompt()"))
  for (const f of ["~/.bash_profile", "~/.bash_login", "~/.profile", "~/.bash_logout", "logout()"]) expect(rc).toContain(f)
  for (const mark of ["133;A", "133;B", "133;C", "133;D;%s", "]7;file://"]) expect(rc).toContain(mark)
  l.cleanup()
  expect(existsSync(l.argv[2]!)).toBe(false)
})

test("zsh: a ZDOTDIR whose files read the user's own; ours are given back before their .zshrc runs", () => {
  const l = launch("/bin/zsh", "z1", true, { HOME: "/home/u", ZDOTDIR: "/home/u/.zsh" } as NodeJS.ProcessEnv)
  expect(l.argv).toEqual(["/bin/zsh", "-l"])
  expect(l.env).toMatchObject({ LEMBAS_USER_ZDOTDIR: "/home/u/.zsh", LEMBAS_USER_ZDOTDIR_SET: "1" })
  const dir = l.env.ZDOTDIR!
  expect(existsSync(join(dir, ".zlogin"))).toBe(false)
  const rc = readFileSync(join(dir, ".zshrc"), "utf8")
  expect(rc.indexOf("unset LEMBAS_USER_ZDOTDIR")).toBeLessThan(rc.indexOf("/.zshrc ]]"))
  for (const mark of ["133;A", "133;B", "133;C", "133;D;%s", "]7;file://"]) expect(rc).toContain(mark)
  const home = launch("/bin/zsh", "z2", true, { HOME: "/home/u" } as NodeJS.ProcessEnv)
  expect(home.env.LEMBAS_USER_ZDOTDIR).toBe("/home/u")
  expect(home.env.LEMBAS_USER_ZDOTDIR_SET).toBeUndefined()
})

test("fish: a command after its own config, wrapping its prompt", () => {
  const l = launch("/usr/bin/fish", "f1", true)
  expect(l.argv.slice(0, 3)).toEqual(["/usr/bin/fish", "-l", "-C"])
  const file = /source '(.*)'/.exec(l.argv[3]!)![1]!
  const text = readFileSync(file, "utf8")
  for (const ev of ["fish_preexec", "fish_postexec", "fish_prompt"]) expect(text).toContain(ev)
  expect(text).toContain("133;D;%s")
})

/** `shell` started for real in a PTY in `cwd`, with `home` as HOME; `run` types lines and waits. */
async function real(shell: string, home: string, cwd: string, id: string, extraEnv: Record<string, string> = {}) {
  const l = launch(shell, id, true, { HOME: home, ...extraEnv } as NodeJS.ProcessEnv)
  let out = ""
  const proc = Bun.spawn(l.argv, {
    cwd,
    env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", TERM: "xterm-256color", ...extraEnv, ...l.env },
    terminal: { cols: 120, rows: 30, data: (_t: unknown, d: Uint8Array) => void (out += Buffer.from(d).toString("utf8")) },
  } as Parameters<typeof Bun.spawn>[1])
  const pty = (proc as unknown as { terminal: { write(s: string): void } }).terminal
  const wait = async (what: string | RegExp, ms = 5000) => {
    for (let i = 0; i < ms / 10; i++) {
      if (typeof what === "string" ? out.includes(what) : what.test(out)) return true
      await Bun.sleep(10)
    }
    return false
  }
  return { proc, pty, wait, out: () => out, count: (s: string) => out.split(s).length - 1 }
}

function home(files: Record<string, string>) {
  const h = realpathSync(mkdtempSync(join(tmpdir(), "ph-shell-")))
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(h, f, ".."), { recursive: true })
    writeFileSync(join(h, f), text)
  }
  const work = join(h, "work dir é")
  mkdirSync(work)
  return { h, work }
}

const enc = (p: string) => Buffer.from(p).toString("latin1").replace(/[^A-Za-z0-9/._~-]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`)

test("a real bash: profile, marks, B kept when PS1 is rebuilt, percent-encoded directory, logout and ~/.bash_logout", async () => {
  if (!Bun.which("bash")) return
  // A prompt framework's way: PS1 rebuilt by PROMPT_COMMAND before every prompt.
  const { h, work } = home({ ".profile": "export FROM_PROFILE=yes\nPROMPT_COMMAND='PS1=\"$ \"'\n", ".bash_logout": "echo bye > ~/logged-out\n" })
  const b = await real("/bin/bash", h, work, "real-bash")
  expect(await b.wait("\x1b]133;A\x07")).toBe(true)
  b.pty.write("echo $FROM_PROFILE\r")
  expect(await b.wait("\x1b]133;D;0\x07")).toBe(true)
  b.pty.write("false\r")
  expect(await b.wait("\x1b]133;D;1\x07")).toBe(true)
  // An empty line ends no command: no D for it.
  const ds = b.count("133;D;")
  b.pty.write("\r")
  await Bun.sleep(150)
  expect(b.count("133;D;")).toBe(ds)
  // Every prompt drawn ends with B, though PS1 was made afresh each time.
  expect(b.count("\x1b]133;B\x07")).toBe(b.count("\x1b]133;A\x07"))
  b.pty.write("logout\r")
  await b.proc.exited
  expect(b.out()).toContain("yes")
  expect(b.out()).toContain("\x1b]133;C\x07")
  expect(b.out()).toContain(`${enc(work)}\x07`)
  expect(b.out()).not.toContain(`${work}\x07`)
  expect(readFileSync(join(h, "logged-out"), "utf8")).toBe("bye\n")
}, 20_000)

test("a real zsh: an XDG ZDOTDIR set in ~/.zshenv is followed, and nothing of ours is left behind", async () => {
  if (!Bun.which("zsh")) return
  const { h, work } = home({
    ".zshenv": 'export ZDOTDIR="$HOME/.config/zsh"\n',
    ".config/zsh/.zprofile": "export FROM_ZPROFILE=yes\n",
    ".config/zsh/.zshrc": "export FROM_ZSHRC=yes\nPS1='%% '\n",
    ".config/zsh/.zlogin": "export FROM_ZLOGIN=yes\n",
  })
  const z = await real(Bun.which("zsh")!, h, work, "real-zsh")
  expect(await z.wait("\x1b]133;A\x07")).toBe(true)
  z.pty.write('echo "[$FROM_ZPROFILE $FROM_ZSHRC $FROM_ZLOGIN] [$ZDOTDIR] [${LEMBAS_USER_ZDOTDIR-unset}]"\r')
  expect(await z.wait(`[yes yes yes] [${h}/.config/zsh] [unset]`)).toBe(true)
  z.pty.write("false\r")
  expect(await z.wait("\x1b]133;D;1\x07")).toBe(true)
  expect(z.out()).toContain("\x1b]133;B\x07")
  expect(z.out()).toContain(`${enc(work)}\x07`)
  z.pty.write("exit\r")
  await z.proc.exited
}, 20_000)

test("a real zsh whose .zshrc execs: the program it runs gets none of our variables", async () => {
  if (!Bun.which("zsh")) return
  const { h, work } = home({ ".zshrc": 'exec /bin/sh -c \'echo "[${ZDOTDIR-unset}] [${LEMBAS_USER_ZDOTDIR-unset}] [${LEMBAS_USER_ZDOTDIR_SET-unset}]"\'\n' })
  const z = await real(Bun.which("zsh")!, h, work, "real-zsh-exec")
  await z.proc.exited
  expect(z.out()).toContain("[unset] [unset] [unset]")
}, 20_000)

test("a real fish: marks and how each command ended", async () => {
  if (!Bun.which("fish")) return
  const { h, work } = home({})
  const f = await real(Bun.which("fish")!, h, work, "real-fish", { XDG_CONFIG_HOME: join(h, ".config"), XDG_DATA_HOME: join(h, ".local/share") })
  expect(await f.wait("\x1b]133;A\x07", 10_000)).toBe(true)
  f.pty.write("false\r")
  expect(await f.wait("\x1b]133;D;1\x07")).toBe(true)
  expect(f.out()).toContain("\x1b]133;C\x07")
  f.pty.write("exit\r")
  await f.proc.exited
}, 30_000)
