// `lembas service`: the link as a background service, after Hermes's gateway — a
// systemd *user* unit, restarted when it fails, its output in the journal, one copy at a time.
//
//   lembas service install    write ~/.config/systemd/user/lembas.service and start it
//   lembas service uninstall  stop it and remove the unit
//   lembas service status     what the running link says (and systemd's view)
//   lembas service logs       its journal
//   lembas service run        what the unit runs: the link, in the foreground
//
// It runs as the user, never as root, and listens on nothing. To keep it running while nobody is
// logged in, the user needs lingering (`loginctl enable-linger`), which `install` says rather than
// does: on most systems that is a decision for whoever administers the machine.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { paths } from "./config/paths.ts"
import { LinkError, limitsFromConfig, runLink, type LinkStatus } from "./acp/link.ts"
import { Hub } from "./acp/hub.ts"

export const UNIT = "lembas.service"
const unitDir = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user")
export const unitFile = () => join(unitDir(), UNIT)
const statusFile = () => join(paths.state, "service.json")
const lockFile = () => join(paths.state, "service.lock")

/** The command the unit starts: this binary, or `bun <cli>` when run from source. */
export function execStart(): string {
  const exe = process.execPath
  const script = process.argv[1] ?? ""
  const fromSource = /(^|\/)bun$/.test(exe) && script.endsWith(".ts")
  const q = (s: string) => (/[\s"'\\]/.test(s) ? `"${s.replace(/(["\\])/g, "\\$1")}"` : s)
  return fromSource ? `${q(exe)} ${q(script)} service run` : `${q(exe)} service run`
}

export function unitText(command = execStart()): string {
  return `[Unit]
Description=LLeMbas CLI: work from a LLeMbas instance (lembas service)
Documentation=https://llembas.eu
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${command}
Restart=on-failure
RestartSec=10
# Stopping: the service ends its own work in seconds; a shell left behind (a terminal
# opened from the web UI is an interactive bash, which ignores SIGTERM) is hung up on, and nothing
# holds a stop for the default 90 s.
KillMode=mixed
SendSIGHUP=yes
TimeoutStopSec=15
# Nothing here needs more than the user already has.
NoNewPrivileges=yes

[Install]
WantedBy=default.target
`
}

export type Systemctl = (...args: string[]) => { ok: boolean; out: string }

function systemctl(...args: string[]): { ok: boolean; out: string } {
  const r = Bun.spawnSync(["systemctl", "--user", ...args], { stdout: "pipe", stderr: "pipe" })
  return { ok: r.exitCode === 0, out: (r.stdout.toString() + r.stderr.toString()).trim() }
}

/** The installed unit, if any: what `service uninstall` and `lembas uninstall` stop. */
export const installedUnits = () => [unitFile()].filter((f) => existsSync(f))

/** Stop, disable and remove the unit, where installed. Before the binary goes too: a unit left
 *  running sees its binary vanish and restart-loops on 203/EXEC every 10 s. A systemctl
 *  that fails (no user manager — a container, an SSH session without lingering) does not stop the
 *  files going: nothing is left to start it again. */
export function removeUnits(run: Systemctl = systemctl): string[] {
  const lines: string[] = []
  for (const file of installedUnits()) {
    run("disable", "--now", UNIT)
    rmSync(file, { force: true })
    lines.push(`stopped, and removed ${file}`)
  }
  if (lines.length) run("daemon-reload")
  return lines
}

export function install(): string[] {
  mkdirSync(unitDir(), { recursive: true })
  const lines: string[] = []
  writeFileSync(unitFile(), unitText())
  lines.push(`wrote ${unitFile()}`)
  const reload = systemctl("daemon-reload")
  if (!reload.ok) return [...lines, `systemctl --user daemon-reload failed: ${reload.out}`, "Start it by hand: lembas service run"]
  const start = systemctl("enable", "--now", UNIT)
  lines.push(start.ok ? "enabled and started" : `could not start it: ${start.out}`)
  const user = process.env.USER ?? ""
  const linger = Bun.spawnSync(["loginctl", "show-user", user, "--property=Linger"], { stdout: "pipe", stderr: "pipe" }).stdout.toString()
  if (!/Linger=yes/.test(linger)) lines.push(`It stops when you log out. To keep it running: loginctl enable-linger ${user}`)
  return lines
}

export function uninstall(): string[] {
  const lines = removeUnits()
  if (!lines.some((l) => l.includes(unitFile()))) lines.unshift("no service installed")
  rmSync(statusFile(), { force: true })
  return lines
}

export function status(): string[] {
  const lines: string[] = []
  try {
    const s = JSON.parse(readFileSync(statusFile(), "utf8")) as LinkStatus & { pid: number }
    let alive = false
    try {
      process.kill(s.pid, 0)
      alive = true
    } catch {}
    lines.push(alive ? `${s.state} — ${s.instance} since ${s.since}${s.detail ? ` (${s.detail})` : ""}` : `not running (last: ${s.state}${s.detail ? `, ${s.detail}` : ""})`)
  } catch {
    lines.push("not running")
  }
  if (existsSync(unitFile())) lines.push(`systemd: ${systemctl("is-active", UNIT).out || "unknown"}`)
  else lines.push("no systemd unit installed (lembas service install)")
  return lines
}

export function logs(follow: boolean): number {
  const r = Bun.spawnSync(["journalctl", "--user", "-u", UNIT, "-n", "200", ...(follow ? ["-f"] : [])], { stdout: "inherit", stderr: "inherit" })
  return r.exitCode ?? 1
}

/** One copy at a time: a second `service run` refuses while the first holds the lock. */
function takeLock(): () => void {
  mkdirSync(paths.state, { recursive: true })
  try {
    const held = Number(readFileSync(lockFile(), "utf8"))
    if (held) {
      process.kill(held, 0)
      throw new LinkError(`already running (pid ${held})`)
    }
  } catch (e) {
    if (e instanceof LinkError) throw e
  }
  const fd = openSync(lockFile(), "w")
  writeFileSync(fd, String(process.pid))
  closeSync(fd)
  return () => rmSync(lockFile(), { force: true })
}

/** An installed unit from an older release is brought up to this one's text, so a change to
 *  how it stops reaches machines that installed it before. It takes effect at the next start. */
function refreshUnit() {
  try {
    if (!existsSync(unitFile())) return
    const want = unitText()
    if (readFileSync(unitFile(), "utf8") === want) return
    writeFileSync(unitFile(), want)
    systemctl("daemon-reload")
    console.log(`brought ${unitFile()} up to this release`)
  } catch {}
}

/** Exit status for "the binary was updated; start me again" — non-zero, so Restart=on-failure does. */
export const RESTART_FOR_UPDATE = 75

export async function run(instance?: string): Promise<number> {
  const release = takeLock()
  const stop = new AbortController()
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => stop.abort())
  refreshUnit()
  // The hub: the terminals on this machine share their sessions through the service. A
  // terminal that holds the link itself for /remote keeps it until it closes; one link per device,
  // so the service waits for it rather than knocking it off.
  const hub = new Hub({ service: true, limits: limitsFromConfig() })
  let said = false
  while (!stop.signal.aborted && !(await hub.listen())) {
    if (!said) console.log("a terminal here holds the link (/remote); waiting for it to close")
    said = true
    await new Promise<void>((r) => {
      const t = setTimeout(r, 15_000)
      stop.signal.addEventListener("abort", () => (clearTimeout(t), r()), { once: true })
    })
  }
  // Updated on disk: a terminal installs a new release, and this process goes on running
  // the old one. It starts again on the new one only when nothing works here — no session
  // working, none a terminal shares in the middle of a turn — so an update never cuts a reply off.
  // Sessions are in the store; the terminals reconnect by themselves.
  let updated = false
  const binary = process.execPath
  const fromSource = /(^|\/)bun$/.test(binary)
  const builtAt = fromSource ? 0 : mtime(binary)
  const watch = fromSource
    ? undefined
    : setInterval(() => {
        if (!builtAt || mtime(binary) === builtAt || hub.busy()) return
        updated = true
        console.log("a new release is installed and nothing is working: starting again on it")
        stop.abort()
      }, 30_000)
  watch?.unref?.()
  try {
    const end = await runLink({
      instance,
      hub,
      signal: stop.signal,
      onStatus: (s) => {
        writeFileSync(statusFile(), JSON.stringify({ ...s, pid: process.pid }, null, 2))
        console.log(`${s.state}${s.detail ? `: ${s.detail}` : ""}`)
      },
    })
    // Refused (token revoked): exit cleanly so systemd does not knock on a closed door for ever.
    void end
    return updated ? RESTART_FOR_UPDATE : 0
  } catch (e) {
    console.error(`lembas service: ${(e as Error).message}`)
    // A configuration that cannot work is not fixed by restarting: exit 0 so Restart=on-failure
    // leaves it, and the journal says why.
    return e instanceof LinkError ? 0 : 1
  } finally {
    clearInterval(watch)
    hub.close()
    release()
  }
}

function mtime(file: string): number {
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}
