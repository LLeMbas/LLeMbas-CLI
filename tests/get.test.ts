// get.sh against a stand-in forge: the latest release's binary for this machine, its SHA256SUMS
// signed (by a key made here, in place of the release key), installed by the release's install.sh.
import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const getSh = resolve(import.meta.dir, "../get.sh")
const installSh = readFileSync(resolve(import.meta.dir, "../install.sh"))
const machine = () => {
  const m = Bun.spawnSync(["uname", "-m"]).stdout.toString().trim()
  if (m === "aarch64" || m === "arm64") return "lembas-linux-arm64"
  return /\bavx2\b/.test(readFileSync("/proc/cpuinfo", "utf8")) ? "lembas-linux-x64" : "lembas-linux-x64-baseline"
}

let server: ReturnType<typeof Bun.serve> | undefined
afterEach(() => server?.stop(true))

// A signing key for these tests, and another that is not trusted.
const keys = mkdtempSync(join(tmpdir(), "ph-get-keys-"))
for (const k of ["release", "other"]) Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", k, "-f", join(keys, k)])
const PUBKEY = readFileSync(join(keys, "release.pub"), "utf8").trim()
function sign(data: Uint8Array, key = "release", ns = "lembas-release"): Uint8Array {
  const f = join(keys, "SHA256SUMS")
  writeFileSync(f, data)
  rmSync(`${f}.sig`, { force: true })
  Bun.spawnSync(["ssh-keygen", "-q", "-Y", "sign", "-f", join(keys, key), "-n", ns, f])
  return readFileSync(`${f}.sig`)
}

forge.url = ""
function forge(opts: { tag?: string; tamper?: boolean; unsigned?: boolean; signer?: string; github?: boolean; relabel?: string; says?: string; tags?: string[] } = {}) {
  const version = (opts.tag ?? "v9.9.9").replace(/^v/, "")
  const binary = new TextEncoder().encode(`#!/bin/sh\necho ${opts.says ?? version}\n`)
  const asset = machine()
  const files: Record<string, Uint8Array> = { [`${asset}.gz`]: Bun.gzipSync(binary), "install.sh": installSh }
  const sum = (b: Uint8Array) => createHash("sha256").update(b).digest("hex")
  files.SHA256SUMS = new TextEncoder().encode(
    `# lembas ${opts.relabel ?? version}\n` +
    Object.entries(files).map(([n, b]) => `${opts.tamper && n.endsWith(".gz") ? "0".repeat(64) : sum(b)}  ${n}`).join("\n") + "\n",
  )
  if (!opts.unsigned) files["SHA256SUMS.sig"] = sign(files.SHA256SUMS, opts.signer, "lembas-release")
  const seen: string[] = []
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const p = new URL(req.url).pathname
      seen.push(p)
      if (p === (opts.github ? "/ghapi/repos/LLeMbas/LLeMbas-CLI/releases" : "/api/v1/repos/LLeMbas/LLeMbas-CLI/releases"))
        return opts.tag ? Response.json((opts.tags ?? [opts.tag]).map((t, i) => ({ id: i, tag_name: t, name: "x" }))) : new Response("not found", { status: 404 })
      const m = /^\/LLeMbas\/LLeMbas-CLI\/releases\/download\/([^/]+)\/(.+)$/.exec(p)
      if (m && m[1] === opts.tag && files[m[2]!]) return new Response(files[m[2]!])
      return new Response("not found", { status: 404 })
    },
  })
  forge.url = `http://127.0.0.1:${server.port}`
  return { url: forge.url, seen }
}

async function run(env: Record<string, string>, args = ["--no-aliases"], home = mkdtempSync(join(tmpdir(), "ph-get-"))) {
  const p = Bun.spawn(["bash", getSh, ...args], {
    env: { PATH: "/usr/bin:/bin", HOME: home, SHELL: "/bin/bash", LEMBAS_PUBKEY: PUBKEY, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = [await new Response(p.stdout).text(), await new Response(p.stderr).text(), await p.exited]
  return { home, out, err, code }
}

test("the latest release's binary for this machine, checked and installed", async () => {
  const f = forge({ tag: "v9.9.9" })
  const r = await run({ LEMBAS_FORGE: f.url })
  expect(r.code).toBe(0)
  expect(r.out).toContain(`LLeMbas CLI v9.9.9 (${machine()})`)
  expect(r.out).toContain("signature good")
  expect(Bun.spawnSync([join(r.home, ".local/bin/lembas"), "--version"]).stdout.toString().trim()).toBe("9.9.9")
  expect(f.seen).toContain(`/LLeMbas/LLeMbas-CLI/releases/download/v9.9.9/${machine()}.gz`)
})

test("LEMBAS_REF picks a tag without asking for the latest", async () => {
  const f = forge({ tag: "v1.2.3" })
  const r = await run({ LEMBAS_FORGE: f.url, LEMBAS_REF: "v1.2.3" })
  expect(r.code).toBe(0)
  expect(f.seen.some((p) => p.endsWith("/releases"))).toBe(false)
})

test("a checksum that does not match installs nothing", async () => {
  const f = forge({ tag: "v9.9.9", tamper: true })
  const r = await run({ LEMBAS_FORGE: f.url })
  expect(r.code).not.toBe(0)
  expect(r.err).toContain("checksums did not match")
  expect(existsSync(join(r.home, ".local/bin/lembas"))).toBe(false)
})

test("no release, or the releases cannot be listed: it says so and installs nothing — no quiet source build", async () => {
  const f = forge({})
  const r = await run({ LEMBAS_FORGE: f.url, LEMBAS_REPO: join(tmpdir(), "no-such-repo.git") })
  expect(r.code).not.toBe(0)
  expect(r.err).toContain("LEMBAS_FROM=source")
  expect(r.out).not.toContain("Cloning")
  expect(existsSync(join(r.home, ".local/bin/lembas"))).toBe(false)
})

test("the newest tag of the channel by version, a release above its betas", async () => {
  forge({ tag: "v1.10.0", tags: ["v1.9.0", "v1.10.0", "v1.11.0-beta.2", "v1.10.0-beta.1"] })
  const stable = forge.url
  expect((await run({ LEMBAS_FORGE: stable })).out).toContain("LLeMbas CLI v1.10.0")
  server?.stop(true)
  forge({ tag: "v1.11.0-beta.2", tags: ["v1.9.0", "v1.10.0", "v1.11.0-beta.2"] })
  expect((await run({ LEMBAS_FORGE: forge.url, LEMBAS_CHANNEL: "beta" })).out).toContain("LLeMbas CLI v1.11.0-beta.2")
})

test("an old release's files under a newer tag, or a binary saying another version, install nothing", async () => {
  forge({ tag: "v9.9.9", relabel: "0.9.0" })
  const a = await run({ LEMBAS_FORGE: forge.url })
  expect(a.code).not.toBe(0)
  expect(a.err).toContain("carries the files of 0.9.0")
  server?.stop(true)
  forge({ tag: "v9.9.9", says: "0.9.0" })
  const b = await run({ LEMBAS_FORGE: forge.url })
  expect(b.code).not.toBe(0)
  expect(b.err).toContain("binary says it is 0.9.0")
  expect(existsSync(join(b.home, ".local/bin/lembas"))).toBe(false)
})

test("a GitHub-shaped forge: the API elsewhere, the downloads where the forge is", async () => {
  const f = forge({ tag: "v9.9.9", github: true })
  const r = await run({ LEMBAS_FORGE: f.url, LEMBAS_API: `${f.url}/ghapi` })
  expect(r.code).toBe(0)
  expect(f.seen).toContain("/ghapi/repos/LLeMbas/LLeMbas-CLI/releases")
})

test("on GitHub the repository is LLeMbas/LLeMbas-CLI by default", async () => {
  const f = forge({})
  await run({ LEMBAS_FORGE: "https://github.com", LEMBAS_API: `${f.url}/ghapi`, LEMBAS_REPO: join(tmpdir(), "no-such-repo.git") })
  expect(f.seen).toContain("/ghapi/repos/LLeMbas/LLeMbas-CLI/releases")
})

test("an unsigned release installs nothing — unless LEMBAS_VERIFY=checksum", async () => {
  const f = forge({ tag: "v9.9.9", unsigned: true })
  const r = await run({ LEMBAS_FORGE: f.url })
  expect(r.code).not.toBe(0)
  expect(r.err).toContain("not signed")
  expect(existsSync(join(r.home, ".local/bin/lembas"))).toBe(false)
  const ok = await run({ LEMBAS_FORGE: f.url, LEMBAS_VERIFY: "checksum" })
  expect(ok.code).toBe(0)
})

test("a release signed by another key installs nothing", async () => {
  const f = forge({ tag: "v9.9.9", signer: "other" })
  const r = await run({ LEMBAS_FORGE: f.url })
  expect(r.code).not.toBe(0)
  expect(r.err).toContain("not signed by the release key")
  expect(existsSync(join(r.home, ".local/bin/lembas"))).toBe(false)
})

test("--uninstall, with no binary to ask, runs the release's install.sh --uninstall", async () => {
  const f = forge({ tag: "v9.9.9" })
  const installed = await run({ LEMBAS_FORGE: f.url })
  expect(installed.code).toBe(0)
  // The stand-in binary has no uninstall of its own; take it away so the release's install.sh does it.
  const bin = join(installed.home, ".local/bin/lembas")
  writeFileSync(bin, "#!/bin/sh\nexit 1\n")
  const r = await run({ LEMBAS_FORGE: f.url }, ["--uninstall"], installed.home)
  expect(r.code).toBe(0)
  expect(existsSync(bin)).toBe(false)
  expect(existsSync(join(installed.home, ".config/lembas/config.yaml"))).toBe(true)
}, 30_000)
