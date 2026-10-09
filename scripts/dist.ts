#!/usr/bin/env bun
// The files a Release carries: one binary per supported platform, gzipped (100 MB → 40), the
// installer, get.sh, SHA256SUMS over them all, and SHA256SUMS.sig — the release key's signature,
// which get.sh and the updater check. Run from a clean checkout at the release tag:
//   bun run dist -- --sign ~/.ssh/projecthor-release        → dist/release/
// (The path is where the release key is kept on the machine that signs; it is the key built in as
// RELEASE_KEYS, and it signs in the namespace lembas-release.)
// (--sign KEY with a key of your own for your own builds; then set update.public_key to its .pub.)
// The arm64 build needs OpenTUI's arm64 library: bun install --frozen-lockfile --os=linux --cpu=arm64
import { createHash } from "node:crypto"
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import pkg from "../package.json"
import { RELEASE_KEYS, SIG_NAMESPACE } from "../src/update/index.ts"
import { verifySshSig } from "../src/update/sshsig.ts"

export const TARGETS = ["linux-x64", "linux-x64-baseline", "linux-arm64"] as const
const root = join(import.meta.dir, "..")
const out = join(root, "dist", "release")

const dirty = Bun.spawnSync(["git", "status", "--porcelain", "--untracked-files=no"], { cwd: root, stdout: "pipe" }).stdout.toString().trim()
if (dirty && !process.argv.includes("--dirty")) {
  console.error(`dist: the checkout has uncommitted changes — release files come from a commit (--dirty to build anyway)\n${dirty}`)
  process.exit(1)
}

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const files: string[] = []
for (const t of TARGETS) {
  const name = `lembas-${t}`
  const r = Bun.spawnSync(["bun", "run", "scripts/build.ts", join(out, name), "--target", t], { cwd: root, stdout: "inherit", stderr: "inherit" })
  if (r.exitCode !== 0) process.exit(r.exitCode ?? 1)
  await Bun.write(join(out, `${name}.gz`), Bun.gzipSync(readFileSync(join(out, name)), { level: 9 }))
  files.push(`${name}.gz`)
}
for (const f of ["install.sh", "get.sh", "LICENSES.txt"]) {
  copyFileSync(join(root, f), join(out, f))
  files.push(f)
}
// The first line names the version: it is signed with the rest, so an old release's files cannot
// be passed off under a newer tag. (sha256sum -c skips it as a comment.)
const sums = `# lembas ${pkg.version}\n` + files.map((f) => `${createHash("sha256").update(readFileSync(join(out, f))).digest("hex")}  ${f}`).join("\n") + "\n"
await Bun.write(join(out, "SHA256SUMS"), sums)

// The signature: made with ssh-keygen, and checked here the way the updater will check it.
const signIdx = process.argv.indexOf("--sign")
const key = signIdx > 0 ? process.argv[signIdx + 1] : undefined
if (key) {
  const r = Bun.spawnSync(["ssh-keygen", "-q", "-Y", "sign", "-f", key.replace(/^~(?=\/)/, process.env.HOME ?? "~"), "-n", SIG_NAMESPACE, join(out, "SHA256SUMS")], { stdout: "inherit", stderr: "inherit" })
  if (r.exitCode !== 0) process.exit(1)
  const pub = readFileSync(`${key.replace(/^~(?=\/)/, process.env.HOME ?? "~")}.pub`, "utf8")
  verifySshSig(readFileSync(join(out, "SHA256SUMS")), readFileSync(join(out, "SHA256SUMS.sig"), "utf8"), SIG_NAMESPACE, [pub])
  const ours = RELEASE_KEYS.some((k) => k.split(/\s+/)[1] === pub.split(/\s+/)[1])
  console.log(`SHA256SUMS.sig — signed by ${pub.trim().split(/\s+/).slice(2).join(" ") || "the key"}${ours ? " (the release key built into LLeMbas CLI)" : " (NOT the built-in release key: users need update.public_key)"}`)
} else console.warn("dist: no --sign KEY — this release is unsigned, and neither get.sh nor the updater will install it")

// What runs here is checked to run: the x64 builds on an x64 machine.
for (const t of TARGETS) {
  if (!t.startsWith(`linux-${process.arch}`)) continue
  const v = Bun.spawnSync([join(out, `lembas-${t}`), "--version"], { stdout: "pipe" })
  if (v.exitCode !== 0) {
    console.error(`dist: lembas-${t} does not run here`)
    process.exit(1)
  }
  console.log(`lembas-${t} --version → ${v.stdout.toString().trim()}`)
}
// The plain binaries stay beside them for a look; only what SHA256SUMS lists is published.
console.log(`\n${out} — publish these (and SHA256SUMS.sig):\n${sums}`)
