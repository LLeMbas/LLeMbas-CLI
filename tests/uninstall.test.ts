// `lembas uninstall`: the same as install.sh --uninstall, from the binary.
import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { paths } from "../src/config/paths.ts"
import { apply, plan, stripBlock } from "../src/uninstall.ts"

const BLOCK = "# >>> lembas >>>\nexport PATH=x\nalias agent='lembas'\n# <<< lembas <<<\n"

test("the rc block comes out; everything else stays byte for byte", () => {
  expect(stripBlock(`# mine\nexport FOO=1\n${BLOCK}`)).toBe("# mine\nexport FOO=1\n")
  expect(stripBlock(`a\n${BLOCK}b\n`)).toBe("a\nb\n")
  expect(stripBlock(BLOCK)).toBe("")
})

test("keeps settings and sessions by default; --purge takes them too; .agent is never touched", () => {
  const home = mkdtempSync(join(tmpdir(), "ph-uninst-"))
  // Its own root: a purge must not take the other tests' config with it.
  const shared = process.env.LEMBAS_HOME
  process.env.LEMBAS_HOME = home
  try {
    run(home)
  } finally {
    process.env.LEMBAS_HOME = shared
  }
})

function run(home: string) {
  const bin = join(home, ".local/bin/lembas")
  mkdirSync(join(home, ".local/bin"), { recursive: true })
  writeFileSync(bin, "x")
  writeFileSync(`${bin}.prev`, "x")
  writeFileSync(join(home, ".bashrc"), `# mine\n${BLOCK}`)
  for (const d of [join(paths.config, "schema"), paths.data, paths.state, join(home, "work/.agent")]) mkdirSync(d, { recursive: true })
  writeFileSync(join(paths.config, "config.yaml"), "model: a/b\n")

  const p = plan({ binary: bin, home })
  expect(p.remove).toEqual([bin, `${bin}.prev`, join(paths.config, "schema")])
  expect(p.rc).toEqual([join(home, ".bashrc")])
  expect(p.kept).toEqual([paths.config, paths.data, paths.state])
  apply(p)
  expect(existsSync(bin) || existsSync(`${bin}.prev`)).toBe(false)
  expect(readFileSync(join(home, ".bashrc"), "utf8")).toBe("# mine\n")
  expect(existsSync(join(paths.config, "config.yaml"))).toBe(true)

  const purge = plan({ binary: bin, home, purge: true })
  expect(purge.remove).toEqual([paths.config, paths.data, paths.state])
  apply(purge)
  for (const d of [paths.config, paths.data, paths.state]) expect(existsSync(d)).toBe(false)
  expect(existsSync(join(home, "work/.agent"))).toBe(true)
}

test("an rc file whose block lost its end marker is left as it is", async () => {
  const home = mkdtempSync(join(tmpdir(), "ph-uninst-"))
  const text = "# mine\n# >>> lembas >>>\nexport PATH=x\nalias ll='ls -l'\n# my own lines after\n"
  writeFileSync(join(home, ".bashrc"), text)
  const { rcFiles } = await import("../src/uninstall.ts")
  expect(rcFiles(home)).toEqual({ whole: [], broken: [join(home, ".bashrc")] })
  expect(readFileSync(join(home, ".bashrc"), "utf8")).toBe(text)
})

test("the service goes first: the unit stopped, disabled and removed before the binary", async () => {
  const { unitFile } = await import("../src/service.ts")
  const home = mkdtempSync(join(tmpdir(), "ph-uninst-"))
  const bin = join(home, ".local/bin/lembas")
  mkdirSync(join(home, ".local/bin"), { recursive: true })
  writeFileSync(bin, "x")
  mkdirSync(join(unitFile(), ".."), { recursive: true })
  writeFileSync(unitFile(), "[Service]\n")

  const p = plan({ binary: bin, home })
  expect(p.units).toEqual([unitFile()])
  const calls: string[][] = []
  apply(p, (...args) => {
    // The binary is still there while a unit is stopped.
    if (args[0] === "disable") expect(existsSync(bin)).toBe(true)
    calls.push(args)
    return { ok: true, out: "" }
  })
  expect(calls).toEqual([["disable", "--now", "lembas.service"], ["daemon-reload"]])
  for (const f of [unitFile(), bin]) expect(existsSync(f)).toBe(false)
  expect(plan({ binary: bin, home }).units).toEqual([])
})
