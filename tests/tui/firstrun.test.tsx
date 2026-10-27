import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { testRender } from "@opentui/solid"
import { paths } from "../../src/config/paths.ts"
import { trustOf } from "../../src/project/root.ts"
import { Boot } from "../../src/tui/index.tsx"
import { fakeProvider } from "../fake-provider.ts"

let setup: Awaited<ReturnType<typeof testRender>> | undefined
afterEach(() => setup?.renderer.destroy())

async function boot(cwd: string) {
  const fake = fakeProvider([])
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  fake:\n    type: webui\n    url: ${fake.url}\n    models: { fake/m: {} }\n`, { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), "model: fake/m\n")
  let quit = 0
  setup = await testRender(() => <Boot options={{ cwd, store: false }} onQuit={() => quit++} />, { width: 100, height: 30 })
  const frame = async () => {
    for (let i = 0; i < 3; i++) {
      await Bun.sleep(20)
      await setup!.renderOnce()
    }
    return setup!.captureCharFrame()
  }
  return { frame, quits: () => quit, fake }
}

test("first run: trust → git init → .agent/ created, .gitignore updated, session opens", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ph-first-"))
  const b = await boot(cwd)
  expect(await b.frame()).toContain("Trust this directory?")
  setup!.mockInput.pressEnter()
  expect(await b.frame()).toContain("No git repository here. Create one?")
  setup!.mockInput.pressEnter()
  const f = await b.frame()
  expect(f).toContain("trusted this directory")
  expect(f).toContain("initialised an empty git repository")
  expect(f).toContain("created .agent/")
  expect(trustOf(cwd)).toBe("trusted")
  expect(existsSync(join(cwd, ".git"))).toBe(true)
  expect(existsSync(join(cwd, ".agent", "config.yaml"))).toBe(true)
  expect(readFileSync(join(cwd, ".gitignore"), "utf8")).toContain("/.agent/local/")
  b.fake.stop()
})

test("first run: read-only skips the project dir; a file named .agent sends it to .lembas", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ph-first-"))
  Bun.spawnSync(["git", "init", "-q", cwd])
  writeFileSync(join(cwd, ".agent"), "someone else's file")
  const b = await boot(cwd)
  expect(await b.frame()).toContain("Trust this directory?")
  setup!.mockInput.pressArrow("down")
  setup!.mockInput.pressEnter()
  const f = await b.frame()
  expect(f).toContain("opened read-only")
  expect(f).toContain(" plan · fake/m")
  expect(existsSync(join(cwd, ".lembas"))).toBe(false)
  b.fake.stop()

  const cwd2 = mkdtempSync(join(tmpdir(), "ph-first-"))
  Bun.spawnSync(["git", "init", "-q", cwd2])
  writeFileSync(join(cwd2, ".agent"), "someone else's file")
  setup!.renderer.destroy()
  const b2 = await boot(cwd2)
  await b2.frame()
  setup!.mockInput.pressEnter()
  expect(await b2.frame()).toContain("created .lembas/")
  expect(existsSync(join(cwd2, ".lembas", "config.yaml"))).toBe(true)
  expect(readFileSync(join(cwd2, ".agent"), "utf8")).toContain("someone else's")
  b2.fake.stop()
})

test("a known directory skips the questions", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ph-first-"))
  const { setTrust } = await import("../../src/project/root.ts")
  setTrust(cwd, "trusted")
  const b = await boot(cwd)
  expect(await b.frame()).toContain("❯")
  b.fake.stop()
})

test("first run: ctrl+c leaves, and nothing is written", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ph-first-"))
  const b = await boot(cwd)
  expect(await b.frame()).toContain("Trust this directory?")
  setup!.mockInput.pressCtrlC()
  await b.frame()
  expect(b.quits()).toBe(1)
  expect(trustOf(cwd)).toBeUndefined()
  expect(existsSync(join(cwd, ".agent"))).toBe(false)
  b.fake.stop()
})
