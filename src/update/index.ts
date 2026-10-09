// Updating LLeMbas CLI itself. On start (TUI, update.auto: install) the newest release of the chosen
// channel is looked for — at most once an hour — and, when it is newer than what runs:
//   1. its SHA256SUMS is fetched with SHA256SUMS.sig, and the signature checked against the
//      release key built in here (or update.public_key);
//   2. this machine's binary is fetched and checked against SHA256SUMS, unpacked, and asked its
//      --version;
//   3. the running binary is kept as <binary>.prev and the new one renamed over it.
// The running process keeps the old file open and carries on; /reload starts the new one. Nothing
// is ever installed that is older than what runs, unless asked for by name (lembas update vX).
import { createHash } from "node:crypto"
import { accessSync, closeSync, constants, copyFileSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { paths } from "../config/paths.ts"
import type { Update } from "../config/schema.ts"
import { VERSION } from "../version.ts"
import { assetUrl, DEFAULT_SOURCE, fetcher, listReleases, resolveSource, type Fetcher, type Release, type Source } from "./source.ts"
import { verifySshSig } from "./sshsig.ts"
import { compareVersions, newestFor, parseVersion, versionText, type Version } from "./version.ts"

/** The keys a release must be signed with. More than one, so the key can be changed: a release
 *  signed with the old key carries the new one, and the one after is signed with the new. */
export const RELEASE_KEYS = ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDSZO3Byow7R3ZpOH3MCvpPIga2pZBzhfX5wXfNP1cLa projecthor-release"]
export const SIG_NAMESPACE = "lembas-release"
const CHECK_EVERY_MS = 60 * 60 * 1000
const LOCK_STALE_MS = 10 * 60 * 1000

export type Outcome =
  | { kind: "current"; version: string }
  | { kind: "available"; version: string }
  | { kind: "installed"; version: string; previous: string }
  | { kind: "skipped"; reason: string }
  /** `security`: the release did not prove itself (signature, checksum) — said loudly. */
  | { kind: "failed"; reason: string; security?: boolean; /** failing again and again: say so */ repeated?: boolean }

export interface UpdateOptions {
  config?: Update
  /** The version running (default: this build's). */
  current?: string
  /** The binary to replace (default: this one, when it is a compiled binary). */
  target?: string
  fetcher?: Fetcher
  /** This machine's asset name (default: worked out). */
  asset?: string
  /** Where update.json and the lock live (default: the state directory). */
  stateDir?: string
}

class Refused extends Error {}

/** This machine's release binary: x86-64 with AVX2, x86-64 without (baseline), or arm64. */
export function machineAsset(): string | undefined {
  if (process.platform !== "linux") return undefined
  if (process.arch === "arm64") return "lembas-linux-arm64"
  if (process.arch !== "x64") return undefined
  let cpu = ""
  try {
    cpu = readFileSync("/proc/cpuinfo", "utf8")
  } catch {}
  return /\bavx2\b/.test(cpu) ? "lembas-linux-x64" : "lembas-linux-x64-baseline"
}

/** The binary this process runs from — undefined when run from source (bun src/cli.ts). */
export function installedBinary(): string | undefined {
  return Bun.main.startsWith("/$bunfs/") ? process.execPath : undefined
}

const sourceOf = (c?: Update): Source => resolveSource(c?.source ?? DEFAULT_SOURCE)
const keysOf = (c?: Update) => (c?.public_key === undefined ? RELEASE_KEYS : [c.public_key].flat())

/** The newest release of the configured channel, if it is newer than `current`. */
export async function check(o: UpdateOptions = {}): Promise<{ release: Release; version: Version } | Outcome> {
  const current = parseVersion(o.current ?? VERSION)
  if (!current) return { kind: "skipped", reason: `this is a build from source (${o.current ?? VERSION}); update it with get.sh or by rebuilding` }
  let releases: Release[]
  try {
    const source = sourceOf(o.config)
    releases = await listReleases(source, o.fetcher ?? fetcher(source))
  } catch (e) {
    return { kind: "failed", reason: (e as Error).message }
  }
  const newest = newestFor(releases, o.config?.channel ?? "stable")
  if (!newest || compareVersions(newest.version, current) <= 0) return { kind: "current", version: versionText(current) }
  return { release: newest, version: newest.version }
}

/** The signed list: file → SHA-256, and the version it names (`# lembas X.Y.Z`). */
function parseSums(text: string): { sums: Map<string, string>; version?: string } {
  const sums = new Map<string, string>()
  let version: string | undefined
  for (const line of text.split("\n")) {
    const v = /^# lembas (\S+)$/.exec(line.trim())
    if (v) version ??= v[1]
    const m = /^([0-9a-f]{64})  (\S+)$/.exec(line.trim())
    if (!m) continue
    if (sums.has(m[2]!)) throw new Refused(`SHA256SUMS lists ${m[2]} twice`)
    sums.set(m[2]!, m[1]!)
  }
  return { sums, version }
}

/** Fetch, prove and put in place one release. The binary is replaced only once all of it is right. */
export async function install(release: Release, version: Version, o: UpdateOptions = {}): Promise<Outcome> {
  const target = o.target ?? installedBinary()
  if (!target) return { kind: "skipped", reason: "this is a build from source; update it with get.sh or by rebuilding" }
  const asset = o.asset ?? machineAsset()
  if (!asset) return { kind: "skipped", reason: `no release binary for ${process.platform}/${process.arch}` }
  try {
    accessSync(dirname(target), constants.W_OK)
    accessSync(target, constants.W_OK)
  } catch {
    return { kind: "skipped", reason: `${target} is not writable by this user; install the update the way it was installed` }
  }
  let f: Fetcher
  try {
    f = o.fetcher ?? fetcher(sourceOf(o.config))
  } catch (e) {
    return { kind: "failed", reason: (e as Error).message }
  }
  const url = (name: string) => {
    const u = assetUrl(release, name)
    if (!u) throw new Refused(`release ${release.tag} has no ${name}`)
    return u
  }
  const tmp = join(dirname(target), `.${basename(target)}.update-${process.pid}`)
  try {
    const sums = await f.bytes(url("SHA256SUMS"))
    if (o.config?.verify !== "checksum") {
      const sigUrl = assetUrl(release, "SHA256SUMS.sig")
      const sig = sigUrl ? await f.text(sigUrl) : undefined
      if (!sig) throw new Refused(`release ${release.tag} is not signed (no SHA256SUMS.sig) — not installed`)
      try {
        verifySshSig(sums, sig, SIG_NAMESPACE, keysOf(o.config))
      } catch (e) {
        throw new Refused(`release ${release.tag}: the signature of SHA256SUMS is not valid (${(e as Error).message}) — not installed`)
      }
    }
    const list = parseSums(new TextDecoder().decode(sums))
    // The signed list names its version: an old release's files under a newer tag are refused here,
    // before anything is run. (Required where the list is signed.)
    if (list.version !== versionText(version) && (list.version !== undefined || o.config?.verify !== "checksum"))
      throw new Refused(`release ${release.tag} carries the files of ${list.version ?? "an unnamed version"} — not installed`)
    const name = asset
    const want = list.sums.get(`${name}.gz`)
    if (!want) throw new Refused(`release ${release.tag}: SHA256SUMS lists no ${asset}.gz`)
    const gz = await f.bytes(url(`${name}.gz`))
    if (createHash("sha256").update(gz).digest("hex") !== want) throw new Refused(`release ${release.tag}: ${name}.gz does not match SHA256SUMS — not installed`)
    const bin = Bun.gunzipSync(gz as Uint8Array<ArrayBuffer>)
    rmSync(tmp, { force: true })
    writeFileSync(tmp, bin, { mode: 0o755, flag: "wx" })
    const ran = Bun.spawnSync([tmp, "--version"], { stdout: "pipe", stderr: "pipe", timeout: 20_000 })
    const said = ran.stdout.toString().trim()
    if (ran.exitCode !== 0) throw new Error(`the new binary does not run here (${ran.stderr.toString().trim().slice(0, 200) || `exit ${ran.exitCode}`})`)
    if (said !== versionText(version)) throw new Refused(`release ${release.tag}'s binary says it is ${said || "nothing"} — not installed`)
    // The one before stays as .prev: lembas update --rollback puts it back.
    const prev = `${target}.prev`
    rmSync(prev, { force: true })
    try {
      linkSync(target, prev)
    } catch {
      copyFileSync(target, prev)
    }
    renameSync(tmp, target)
    return { kind: "installed", version: versionText(version), previous: o.current ?? VERSION }
  } catch (e) {
    return { kind: "failed", reason: (e as Error).message, security: e instanceof Refused }
  } finally {
    rmSync(tmp, { force: true })
  }
}

/** One update at a time, across every session on this machine (and `lembas update`). A lock
 *  left by a process that died is moved aside under a name of its own before a new one is made, so
 *  two processes that both find it stale cannot both go ahead. */
export function lock(dir = paths.state): (() => void) | undefined {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, "update.lock")
  for (let i = 0; i < 2; i++) {
    try {
      closeSync(openSync(file, "wx"))
      return () => rmSync(file, { force: true })
    } catch {
      try {
        if (Date.now() - statSync(file).mtimeMs < LOCK_STALE_MS) return undefined
        const aside = `${file}.stale-${process.pid}`
        renameSync(file, aside)
        rmSync(aside, { force: true })
      } catch {}
    }
  }
  return undefined
}

interface State {
  checked?: number
  /** Failed looks in a row, and the last reason: said once there are three. */
  failures?: number
  reason?: string
}

function readState(dir: string): State {
  try {
    return JSON.parse(readFileSync(join(dir, "update.json"), "utf8"))
  } catch {
    return {}
  }
}

/** On start: look, at most once an hour, and install or announce per update.auto. */
export async function autoUpdate(o: UpdateOptions & { force?: boolean } = {}): Promise<Outcome> {
  const mode = o.config?.auto ?? "install"
  if (mode === "off") return { kind: "skipped", reason: "update.auto is off" }
  // A build from source is updated with git, not from releases: nothing to look for.
  if (!(o.target ?? installedBinary())) return { kind: "skipped", reason: "a build from source" }
  const dir = o.stateDir ?? paths.state
  if (!o.force && Date.now() - (readState(dir).checked ?? 0) < CHECK_EVERY_MS) return { kind: "skipped", reason: "checked within the hour" }
  const unlock = lock(dir)
  if (!unlock) return { kind: "skipped", reason: "another session is updating" }
  try {
    const before = readState(dir)
    const save = (s: State) => writeFileSync(join(dir, "update.json"), JSON.stringify(s))
    save({ ...before, checked: Date.now() })
    let r: Outcome
    try {
      const found = await check(o)
      r = "kind" in found ? found : mode === "notify" ? { kind: "available", version: versionText(found.version) } : await install(found.release, found.version, o)
    } catch (e) {
      r = { kind: "failed", reason: (e as Error).message }
    }
    // A failure now and then (no network) is not worth a word; updates failing again and again
    // are — or a user could go without them for good and never know.
    if (r.kind === "failed") {
      const failures = (before.failures ?? 0) + 1
      save({ checked: Date.now(), failures, reason: r.reason })
      if (failures >= 3 && !r.security) return { ...r, reason: `updates have failed ${failures} times in a row: ${r.reason}`, repeated: true }
    } else save({ checked: Date.now() })
    return r
  } finally {
    unlock()
  }
}

/** `lembas update vX.Y.Z`: that release, older or newer, on purpose. */
export async function installTag(tag: string, o: UpdateOptions = {}): Promise<Outcome> {
  const version = parseVersion(tag)
  if (!version) return { kind: "failed", reason: `${tag} is not a release tag (vX.Y.Z or vX.Y.Z-beta.N)` }
  let source: Source
  let f: Fetcher
  try {
    source = sourceOf(o.config)
    f = o.fetcher ?? fetcher(source)
  } catch (e) {
    return { kind: "failed", reason: (e as Error).message }
  }
  const release = (await listReleases(source, f)).find((r) => parseVersion(r.tag) && compareVersions(parseVersion(r.tag)!, version) === 0)
  if (!release) return { kind: "failed", reason: `no release ${tag} at the update source` }
  return install(release, version, { ...o, fetcher: f })
}

/** Put <binary>.prev back (and keep the one it replaces as .prev: twice is a no-op). */
export function rollback(target = installedBinary()): string {
  if (!target) throw new Error("this is a build from source; there is nothing to roll back")
  const prev = `${target}.prev`
  if (!existsSync(prev)) throw new Error(`no earlier version kept (${prev})`)
  const ran = Bun.spawnSync([prev, "--version"], { stdout: "pipe", timeout: 20_000 })
  if (ran.exitCode !== 0) throw new Error(`${prev} does not run`)
  // Never a moment without a binary: the current one is linked aside, the old one renamed over it
  // (atomic), and the aside becomes .prev.
  const swap = `${target}.swap-${process.pid}`
  rmSync(swap, { force: true })
  linkSync(target, swap)
  renameSync(prev, target)
  renameSync(swap, prev)
  return ran.stdout.toString().trim()
}
