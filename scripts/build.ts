#!/usr/bin/env bun
// Builds the single-file `lembas` binary — for the host, or for another platform:
//   bun run scripts/build.ts [outfile] [--target linux-arm64]
// Targets: linux-x64, linux-x64-baseline (x86-64 CPUs without AVX2), linux-arm64, and the -musl
// variants; Bun also knows darwin-* and windows-*, which LLeMbas CLI does not support yet.
// Another platform needs OpenTUI's native package for it in node_modules: Bun skips the ones for
// other machines, so fetch them with `bun install --frozen-lockfile --os=linux --cpu=arm64` (the
// lockfile already lists them; nothing in the repository changes).
import type { BunPlugin } from "bun"
import solidPlugin from "@opentui/solid/bun-plugin"
import pkg from "../package.json"

const args = process.argv.slice(2)
const at = args.indexOf("--target")
const target = at >= 0 ? args.splice(at, 2)[1] : undefined
if (target !== undefined && !/^(linux|darwin|windows)-(x64|arm64)(-musl)?(-baseline)?$/.test(target)) {
  console.error(`--target ${target}: expected e.g. linux-arm64, linux-x64, linux-x64-baseline, linux-x64-musl`)
  process.exit(2)
}
const outfile = args[0] ?? "dist/lembas"
// -baseline is the CPU level of Bun itself; OpenTUI's library is the same one.
const [os, arch, libc] = (target ?? `${process.platform}-${process.arch}`).replace(/-baseline$/, "").split("-")

// OpenTUI imports the native library of whichever platform it runs on, so the bundle would carry
// every variant found in node_modules. Only the target's goes in; the others stay out.
const nativeOnly: BunPlugin = {
  name: "opentui-native-for-target",
  setup(build) {
    const want = `@opentui/core-${os === "windows" ? "win32" : os}-${arch}${libc ? `-${libc}` : ""}`
    build.onResolve({ filter: /^@opentui\/core-(linux|darwin|win32)-/ }, (a) => (a.path === want || a.path === `${want}-musl` ? undefined : { path: a.path, external: true }))
    void Bun.resolveSync(want, process.cwd()) // fail here, by name, when it is not installed
  },
}

// A release build (HEAD exactly at the tag vX.Y.Z) reports X.Y.Z; anything else reports
// X.Y.Z+<commit>, so a tester can tell which build they have. An export without .git (a deploy
// script may build one) passes the commit in LEMBAS_BUILD.
function buildId(): string {
  const given = process.env.LEMBAS_BUILD
  if (given !== undefined) return given
  const r = Bun.spawnSync(["git", "describe", "--tags", "--always", "--dirty"], { stdout: "pipe", stderr: "ignore" })
  return r.exitCode === 0 ? r.stdout.toString().trim() : ""
}
const id = buildId()
const version = id === `v${pkg.version}` || id === "" ? pkg.version : `${pkg.version}+${id.replace(/^v[\d.]+-\d+-/, "")}`

const result = await Bun.build({
  entrypoints: ["./src/cli.ts"],
  tsconfig: "./tsconfig.json",
  plugins: [solidPlugin, nativeOnly],
  format: "esm",
  minify: true,
  compile: {
    outfile,
    ...(target ? { target: `bun-${target}` as Bun.Build.CompileTarget } : {}),
    autoloadBunfig: false,
    autoloadDotenv: false,
    // --use-system-ca: a root installed in the OS store (a private CA) is trusted, as OpenCode does.
    execArgv: [`--user-agent=lembas-cli/${version}`, "--use-system-ca", "--"],
  },
  define: {
    LEMBAS_VERSION: JSON.stringify(version),
    // Reserved: an instance a build could offer on its first-run screen. Empty, and read by
    // nothing yet — rule 1, nothing predefined, holds for every build this script makes.
    LEMBAS_DEFAULT_INSTANCE: JSON.stringify(""),
  },
})

for (const log of result.logs) console.error(log)
if (!result.success) process.exit(1)
console.log(`built ${outfile} (${version}${target ? `, ${target}` : ""})`)
