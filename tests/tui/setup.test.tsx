// The first run with no model: the setup screen opens on "Log in to a LLeMbas instance"
// with the address field focused — typing goes straight into it — and ctrl+r tries again from there.
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { testRender } from "@opentui/solid"
import { paths } from "../../src/config/paths.ts"
import { setTrust } from "../../src/project/root.ts"
import { Boot } from "../../src/tui/index.tsx"
import { fakeProvider } from "../fake-provider.ts"

let setup: Awaited<ReturnType<typeof testRender>> | undefined
afterEach(() => setup?.renderer.destroy())

test("no model yet: the sign-in is first and focused; ctrl+r opens the session once there is one", async () => {
  const fake = fakeProvider([])
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(join(paths.config, "connections.yaml"), "connections: {}\n", { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), "mode: manual\n")
  const cwd = mkdtempSync(join(tmpdir(), "ph-setup-"))
  Bun.spawnSync(["git", "init", "-q", cwd])
  setTrust(cwd, "trusted")
  mkdirSync(join(cwd, ".agent", "plans"), { recursive: true })
  setup = await testRender(() => <Boot options={{ cwd, store: false }} onQuit={() => {}} />, { width: 100, height: 40 })
  const frame = async () => {
    for (let i = 0; i < 3; i++) {
      await Bun.sleep(20)
      await setup!.renderOnce()
    }
    return setup!.captureCharFrame()
  }
  let f = await frame()
  expect(f).toContain("no model to talk to yet")
  expect(f).toContain("Log in to a LLeMbas instance")
  // Before the file instructions: the screen opens on the sign-in.
  expect(f.indexOf("Log in to a LLeMbas instance")).toBeLessThan(f.indexOf("connections.yaml"))
  // Focused: what is typed is the address, without pressing l first.
  await setup.mockInput.typeText("ai.example")
  f = await frame()
  expect(f).toContain("Address: ai.example")
  // A model added meanwhile: ctrl+r, a letter-free key, opens the session.
  writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  fake:\n    dialect: openai-chat\n    base_url: ${fake.url}\n    models: { m: {} }\n`, { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), "model: fake/m\n")
  setup.mockInput.pressKey("r", { ctrl: true })
  f = await frame()
  expect(f).toContain("fake/m")
  fake.stop()
})
