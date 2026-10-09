import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { testRender } from "@opentui/solid"
import { createApp } from "../../src/app.ts"
import { Bus } from "../../src/bus/index.ts"
import { paths } from "../../src/config/paths.ts"
import { Root } from "../../src/tui/app.tsx"
import { createView } from "../../src/tui/state.ts"
import { DEFAULT_THEME } from "../../src/tui/theme.ts"
import { fakeProvider, type Scripted } from "../fake-provider.ts"

/** The whole TUI in OpenTUI's test renderer, against a scripted endpoint. */
export async function tui(script: Scripted[], size = { width: 100, height: 30 }, extraConfig = "", o: { store?: boolean } = {}) {
  const fake = fakeProvider(script)
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(
    join(paths.config, "connections.yaml"),
    `connections:\n  fake:\n    dialect: openai-chat\n    base_url: ${fake.url}\n    models:\n      coder: { context: 32768, efforts: [low, high], effort: low }\n      other: { context: 8192 }\n`,
    { mode: 0o600 },
  )
  writeFileSync(join(paths.config, "config.yaml"), `model: fake/coder\n${extraConfig}`)
  const cwd = mkdtempSync(join(tmpdir(), "lembas-tui-"))
  Bun.spawnSync(["git", "init", "-q", cwd])
  writeFileSync(join(cwd, "hello.txt"), "hello world\n")
  const bus = new Bus()
  const view = createView(bus)
  // `store`: a real sessions.db (/sessions); by default none.
  const app = createApp({ cwd, asker: view.asker, bus, ...(o.store ? {} : { store: false as const }) })
  let quit = 0
  const setup = await testRender(() => <Root app={app} view={view} theme={DEFAULT_THEME} onQuit={() => quit++} />, size)
  const frame = () => setup.captureCharFrame()
  const settle = async (ms = 60) => {
    for (let i = 0; i < 4; i++) {
      await Bun.sleep(ms / 4)
      await setup.renderOnce()
    }
  }
  const until = async (text: string, ms = 5000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      await settle(40)
      if (frame().includes(text)) return true
    }
    return false
  }
  await settle()
  return { fake, app, view, setup, frame, settle, until, cwd, quits: () => quit, input: setup.mockInput, stop: () => (fake.stop(), setup.renderer.destroy(), void app.close()) }
}
