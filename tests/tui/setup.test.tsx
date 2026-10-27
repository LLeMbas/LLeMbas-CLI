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
  // 2.0: the server's models or none — the screen is the sign-in, and nothing else to fill in.
  expect(f).toContain("not logged in to a LLeMbas server")
  expect(f).toContain("Log in to a LLeMbas instance")
  expect(f).not.toContain("connections.yaml")
  // Focused: what is typed is the address, without pressing l first.
  await setup.mockInput.typeText("ai.example")
  f = await frame()
  expect(f).toContain("Address: ai.example")
  // A model added meanwhile: ctrl+r, a letter-free key, opens the session.
  writeFileSync(join(paths.config, "connections.yaml"), `connections:\n  fake:\n    type: webui\n    url: ${fake.url}\n    models: { fake/m: {} }\n`, { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), "model: fake/m\n")
  setup.mockInput.pressKey("r", { ctrl: true })
  f = await frame()
  expect(f).toContain("fake/m")
  fake.stop()
})
