// Updating itself, against stand-in sources: the newest release of a channel, its SHA256SUMS
// signed (by a key made here, given as update.public_key), the binary checked, put in place with
// the old one kept — and nothing at all changed when any of that is not right.
import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Update } from "../src/config/schema.ts"
import { autoUpdate, check, install, installTag, rollback } from "../src/update/index.ts"
import { verifySshSig } from "../src/update/sshsig.ts"
import { compareVersions, newestFor, parseVersion } from "../src/update/version.ts"

const ASSET = "lembas-linux-test"
const keys = mkdtempSync(join(tmpdir(), "ph-upd-keys-"))
for (const k of ["release", "other"]) Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", k, "-f", join(keys, k)])
const PUBKEY = readFileSync(join(keys, "release.pub"), "utf8").trim()
function sign(data: Uint8Array, key = "release", ns = "lembas-release"): string {
  const f = join(keys, "SUMS")
  writeFileSync(f, data)
  rmSync(`${f}.sig`, { force: true })
  Bun.spawnSync(["ssh-keygen", "-q", "-Y", "sign", "-f", join(keys, key), "-n", ns, f])
  return readFileSync(`${f}.sig`, "utf8")
}

const script = (version: string) => new TextEncoder().encode(`#!/bin/sh\necho ${version}\n`)

let server: ReturnType<typeof Bun.serve> | undefined
afterEach(() => server?.stop(true))

/** A Gitea-shaped forge with these releases, or a static directory (stable/beta files). */
function source(releases: string[], o: { unsigned?: boolean; signer?: string; tamper?: boolean; wrongVersion?: boolean; relabel?: string } = {}) {
  const A = ASSET
  const files = new Map<string, Uint8Array | string>()
  for (const tag of releases) {
    const gz = Bun.gzipSync(script(o.wrongVersion ? "0.0.1" : tag.replace(/^v/, "")))
    // `relabel`: an old release's signed list put under a newer tag.
    const named = o.relabel ?? tag.replace(/^v/, "")
    const sums = new TextEncoder().encode(`# lembas ${named}\n${o.tamper ? "0".repeat(64) : createHash("sha256").update(gz).digest("hex")}  ${A}.gz\n`)
    files.set(`${tag}/${A}.gz`, gz)
    files.set(`${tag}/SHA256SUMS`, sums)
    if (!o.unsigned) files.set(`${tag}/SHA256SUMS.sig`, sign(sums, o.signer, "lembas-release"))
  }
  const seen: string[] = []
  server = Bun.serve({
    port: 0,
    fetch(req): Response {
      const p = new URL(req.url).pathname
      seen.push(p)
      if (p === "/api/v1/repos/o/p/releases")
        return Response.json(
          releases.map((tag) => ({
            tag_name: tag,
            prerelease: tag.includes("-"),
            draft: false,
            assets: ["SHA256SUMS", "SHA256SUMS.sig", `${A}.gz`].filter((n) => files.has(`${tag}/${n}`)).map((n) => ({ name: n, browser_download_url: `${url}/dl/${tag}/${n}` })),
          })),
        )
      const m = /^\/(?:dl|static)\/(.+)$/.exec(p)
      if (m && files.has(decodeURIComponent(m[1]!))) return new Response(files.get(decodeURIComponent(m[1]!))!)
      if (p === "/static/stable") return new Response(releases.filter((t) => !t.includes("-")).at(-1) ?? "", { status: releases.some((t) => !t.includes("-")) ? 200 : 404 })
      if (p === "/static/beta") return new Response(releases.filter((t) => t.includes("-")).at(-1) ?? "", { status: releases.some((t) => t.includes("-")) ? 200 : 404 })
      return new Response("not found", { status: 404 })
    },
  })
  const url: string = `http://127.0.0.1:${server.port}`
  return { url, seen, gitea: { type: "gitea", url, repo: "o/p" } as const, static: { type: "static", url: `${url}/static` } as const }
}

/** The installed binary: a script saying its version, in a directory of its own. */
function installed(version = "1.0.0") {
  const dir = mkdtempSync(join(tmpdir(), "ph-upd-bin-"))
  const target = join(dir, "lembas")
  writeFileSync(target, script(version))
  chmodSync(target, 0o755)
  return target
}
const ran = (bin: string) => Bun.spawnSync([bin]).stdout.toString().trim()
const cfg = (src: Update["source"], extra: Partial<Update> = {}): Update => ({ source: src, public_key: PUBKEY, ...extra })

test("versions: SemVer order, a beta below its release, stable never offered a beta", () => {
  const v = (s: string) => parseVersion(s)!
  expect(compareVersions(v("v1.0.0"), v("1.0.0"))).toBe(0)
  expect(compareVersions(v("1.1.0-beta.1"), v("1.1.0"))).toBeLessThan(0)
  expect(compareVersions(v("1.1.0-beta.2"), v("1.1.0-beta.10"))).toBeLessThan(0)
  expect(compareVersions(v("1.10.0"), v("1.9.9"))).toBeGreaterThan(0)
  expect(parseVersion("0.9.2+g1234abc")).toBeUndefined()
  const rel = ["v1.0.0", "v1.1.0-beta.1", "v0.9.0"].map((tag) => ({ tag }))
  expect(newestFor(rel, "stable")!.tag).toBe("v1.0.0")
  expect(newestFor(rel, "beta")!.tag).toBe("v1.1.0-beta.1")
  expect(newestFor([...rel, { tag: "v1.1.0" }], "beta")!.tag).toBe("v1.1.0")
})

test("an SSH signature: good, tampered, another namespace, another key", () => {
  const msg = new TextEncoder().encode("abc  file\n")
  const sig = sign(msg)
  expect(() => verifySshSig(msg, sig, "lembas-release", [PUBKEY])).not.toThrow()
  expect(() => verifySshSig(new TextEncoder().encode("abd  file\n"), sig, "lembas-release", [PUBKEY])).toThrow("does not match")
  expect(() => verifySshSig(msg, sig, "elsewhere", [PUBKEY])).toThrow("not \"elsewhere\"")
  expect(() => verifySshSig(msg, sign(msg, "other"), "lembas-release", [PUBKEY])).toThrow("not trusted")
})

test("installs the newest stable release: signature, checksum, --version, the old one kept as .prev", async () => {
  const s = source(["v1.0.0", "v1.1.0", "v1.2.0-beta.1"])
  const target = installed("1.0.0")
  const found = await check({ current: "1.0.0", config: cfg(s.gitea) })
  expect("release" in found && found.release.tag).toBe("v1.1.0")
  if (!("release" in found)) throw new Error("no release")
  const r = await install(found.release, found.version, { current: "1.0.0", config: cfg(s.gitea), target, asset: ASSET })
  expect(r).toEqual({ kind: "installed", version: "1.1.0", previous: "1.0.0" })
  expect(ran(target)).toBe("1.1.0")
  expect(ran(`${target}.prev`)).toBe("1.0.0")
  // Rolled back, and forward again.
  expect(rollback(target)).toBe("1.0.0")
  expect(ran(target)).toBe("1.0.0")
  expect(rollback(target)).toBe("1.1.0")
})

test("the beta channel takes the newest beta; a static directory works the same", async () => {
  const s = source(["v1.1.0", "v1.2.0-beta.1"])
  const target = installed("1.0.0")
  const r = await autoUpdate({ current: "1.0.0", config: cfg(s.static, { channel: "beta" }), target, asset: ASSET, stateDir: mkdtempSync(join(tmpdir(), "ph-upd-state-")) })
  expect(r).toMatchObject({ kind: "installed", version: "1.2.0-beta.1" })
  expect(ran(target)).toBe("1.2.0-beta.1")
})

test("nothing older or the same is installed; notify only says so", async () => {
  const s = source(["v1.0.0", "v1.1.0"])
  expect(await check({ current: "1.1.0", config: cfg(s.gitea) })).toEqual({ kind: "current", version: "1.1.0" })
  expect(await check({ current: "2.0.0", config: cfg(s.gitea) })).toEqual({ kind: "current", version: "2.0.0" })
  const target = installed("1.0.0")
  const r = await autoUpdate({ current: "1.0.0", config: cfg(s.gitea, { auto: "notify" }), target, asset: ASSET, stateDir: mkdtempSync(join(tmpdir(), "ph-upd-state-")) })
  expect(r).toEqual({ kind: "available", version: "1.1.0" })
  expect(ran(target)).toBe("1.0.0")
  // By name, older is allowed: on purpose.
  expect(await installTag("v1.0.0", { current: "1.1.0", config: cfg(s.gitea), target, asset: ASSET })).toMatchObject({ kind: "installed", version: "1.0.0" })
})

for (const [name, opts, expectText] of [
  ["unsigned", { unsigned: true }, "not signed"],
  ["signed by another key", { signer: "other" }, "not trusted"],
  ["a checksum that does not match", { tamper: true }, "does not match SHA256SUMS"],
] as const)
  test(`${name}: refused, said loudly, nothing changed`, async () => {
    const s = source(["v1.1.0"], opts)
    const target = installed("1.0.0")
    const r = await autoUpdate({ current: "1.0.0", config: cfg(s.gitea), target, asset: ASSET, stateDir: mkdtempSync(join(tmpdir(), "ph-upd-state-")) })
    expect(r).toMatchObject({ kind: "failed", security: true })
    expect(r.kind === "failed" && r.reason).toContain(expectText)
    expect(ran(target)).toBe("1.0.0")
    expect(existsSync(`${target}.prev`)).toBe(false)
  })

test("verify: checksum takes an unsigned source of your own", async () => {
  const s = source(["v1.1.0"], { unsigned: true })
  const target = installed("1.0.0")
  const r = await autoUpdate({ current: "1.0.0", config: cfg(s.gitea, { verify: "checksum" }), target, asset: ASSET, stateDir: mkdtempSync(join(tmpdir(), "ph-upd-state-")) })
  expect(r).toMatchObject({ kind: "installed" })
})

test("a binary that does not say the version it should is not put in place", async () => {
  const s = source(["v1.1.0"], { wrongVersion: true })
  const target = installed("1.0.0")
  const r = await autoUpdate({ current: "1.0.0", config: cfg(s.gitea), target, asset: ASSET, stateDir: mkdtempSync(join(tmpdir(), "ph-upd-state-")) })
  expect(r).toMatchObject({ kind: "failed" })
  expect(ran(target)).toBe("1.0.0")
})

test("looked for at most once an hour; off is off; a build from source never looks", async () => {
  const s = source(["v1.1.0"])
  const stateDir = mkdtempSync(join(tmpdir(), "ph-upd-state-"))
  const o = { current: "1.0.0", config: cfg(s.gitea, { auto: "notify" as const }), target: installed("1.0.0"), asset: ASSET, stateDir }
  expect((await autoUpdate(o)).kind).toBe("available")
  expect(await autoUpdate(o)).toEqual({ kind: "skipped", reason: "checked within the hour" })
  expect((await autoUpdate({ ...o, config: { ...o.config, auto: "off" } })).kind).toBe("skipped")
  const before = s.seen.length
  expect(await autoUpdate({ current: "1.0.0", config: cfg(s.gitea), force: true, stateDir })).toEqual({ kind: "skipped", reason: "a build from source" })
  expect(s.seen.length).toBe(before)
})

test("an old release's signed files under a newer tag are refused before anything runs", async () => {
  const s = source(["v2.0.0"], { relabel: "1.0.0" })
  const target = installed("1.0.0")
  const r = await autoUpdate({ current: "1.0.0", config: cfg(s.gitea), target, asset: ASSET, stateDir: mkdtempSync(join(tmpdir(), "ph-upd-state-")) })
  expect(r).toMatchObject({ kind: "failed", security: true })
  expect(r.kind === "failed" && r.reason).toContain("carries the files of 1.0.0")
  expect(ran(target)).toBe("1.0.0")
})

test("updates failing again and again are said, once there are three", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ph-upd-state-"))
  const o = { current: "1.0.0", config: cfg({ type: "gitea", url: "http://127.0.0.1:9", repo: "o/p" }), target: installed("1.0.0"), asset: ASSET, stateDir, force: true }
  const a = await autoUpdate(o)
  const b = await autoUpdate(o)
  const c = await autoUpdate(o)
  expect([a, b].every((r) => r.kind === "failed" && !r.repeated)).toBe(true)
  expect(c).toMatchObject({ kind: "failed", repeated: true })
  expect(c.kind === "failed" && c.reason).toContain("failed 3 times in a row")
})

test("a signature with anything around or after it is not one", () => {
  const msg = new TextEncoder().encode("abc  file\n")
  const sig = sign(msg)
  expect(() => verifySshSig(msg, `junk\n${sig}`, "lembas-release", [PUBKEY])).toThrow("not one armored")
  expect(() => verifySshSig(msg, `${sig}${sig}`, "lembas-release", [PUBKEY])).toThrow()
})
