#!/usr/bin/env bun
// Drive the TUI in a real PTY against a scripted fake endpoint and print the screens.
//   bun scripts/drive.ts [cols] [rows] [--bin path]      (development aid; smoke.ts asserts)
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Terminal } from "@xterm/headless"
import { Unicode11Addon } from "@xterm/addon-unicode11"
import { delta, fakeProvider, toolCall, usage } from "../tests/fake-provider.ts"

export interface Driver {
  screen(): string[]
  /** Rows that are continuations of the row above: something was wider than the terminal. */
  wrapped(): number[]
  type(s: string): Promise<void>
  key(seq: string): Promise<void>
  waitFor(text: string, ms?: number): Promise<boolean>
  close(): Promise<number>
  /** The terminal's modes as the program left them: mouse reporting, alternate screen, cursor. */
  modes(): { mouse: string; altScreen: boolean; cursorHidden: boolean }
}

export async function drive(opts: { cols: number; rows: number; bin?: string; home: string; cwd: string; args?: string[]; env?: Record<string, string> }): Promise<Driver> {
  const cmd = opts.bin ? resolve(opts.bin) : `bun --config=${resolve(import.meta.dir, "../bunfig.toml")} ${resolve(import.meta.dir, "../src/cli.ts")}`
  const p = Bun.spawn(["script", "-qfec", `stty cols ${opts.cols} rows ${opts.rows}; exec ${cmd} ${(opts.args ?? []).join(" ")}`, "/dev/null"], {
    cwd: opts.cwd,
    env: { ...process.env, LEMBAS_HOME: opts.home, TERM: "xterm-256color", ...opts.env },
    stdin: "pipe",
    stdout: "pipe",
  })
  const term = new Terminal({ cols: opts.cols, rows: opts.rows, allowProposedApi: true })
  // Emoji are 2 columns in real terminals and in OpenTUI; xterm defaults to Unicode 6 widths.
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = "11"
  const reader = (async () => {
    for await (const c of p.stdout) await new Promise<void>((ok) => term.write(c, ok))
  })()
  const screen = () => Array.from({ length: opts.rows }, (_, y) => term.buffer.active.getLine(y)?.translateToString(true) ?? "")
  const send = async (s: string) => {
    p.stdin.write(s)
    await p.stdin.flush()
  }
  return {
    screen,
    wrapped: () => Array.from({ length: opts.rows }, (_, y) => y).filter((y) => term.buffer.active.getLine(y)?.isWrapped),
    async type(s) {
      for (const ch of s) {
        await send(ch)
        await Bun.sleep(8)
      }
    },
    key: send,
    async waitFor(text, ms = 8000) {
      const until = Date.now() + ms
      while (Date.now() < until) {
        if (screen().some((l) => l.includes(text))) return true
        await Bun.sleep(50)
      }
      return false
    },
    modes: () => ({ mouse: term.modes.mouseTrackingMode, altScreen: term.buffer.active.type === "alternate", cursorHidden: (term as unknown as { _core: { coreService: { isCursorHidden: boolean } } })._core.coreService.isCursorHidden }),
    async close() {
      const code = await Promise.race([p.exited, Bun.sleep(4000).then(() => (p.kill(), -1))])
      await reader
      return code
    },
  }
}

export function fakeHome(script: Parameters<typeof fakeProvider>[0]) {
  const fake = fakeProvider(script, { served: [{ id: "fake/coder" }, { id: "fake/other" }] })
  const home = mkdtempSync(join(tmpdir(), "lembas-drive-"))
  mkdirSync(join(home, ".config/lembas"), { recursive: true })
  writeFileSync(
    join(home, ".config/lembas/connections.yaml"),
    `connections:\n  fake:\n    type: webui\n    url: ${fake.url}\n    api_key: smoke\n    models:\n      fake/coder: { context: 32768, efforts: [low, high], effort: low }\n      fake/other: { context: 8192 }\n`,
    { mode: 0o600 },
  )
  writeFileSync(join(home, ".config/lembas/config.yaml"), "model: fake/coder\nupdate: { auto: off }\n")
  const cwd = mkdtempSync(join(tmpdir(), "lembas-drive-proj-"))
  Bun.spawnSync(["git", "init", "-q", cwd])
  writeFileSync(join(cwd, "hello.txt"), "hello world\n")
  return { fake, home, cwd }
}

if (import.meta.main) {
  const cols = Number(process.argv[2] ?? 100)
  const rows = Number(process.argv[3] ?? 30)
  const binAt = process.argv.indexOf("--bin")
  const { fake, home, cwd } = fakeHome([
    { chunks: [delta({ reasoning_content: "The user wants a greeting; I will check the file first." }), delta({ content: "Let me look." }), toolCall(0, "c1", "bash", '{"command":"cat hello.txt","description":"Show the file"}'), toolCall(1, "c2", "bash", '{"command":"echo hi > out.txt","description":"Write a file"}'), usage(9000, 50)] },
    { chunks: [delta({ content: "## Done\n\nThe file says **hello world**. I wrote `out.txt` as well.\n\n- one\n- two\n" }), usage(12000, 80)] },
  ])
  const d = await drive({ cols, rows, home, cwd, bin: binAt > 0 ? process.argv[binAt + 1] : undefined })
  const show = (label: string) => console.log(`\n=== ${label}\n` + d.screen().map((l) => l.trimEnd()).join("\n"))
  await d.waitFor("shift+tab mode · /help")
  show("start")
  await d.type("greet me")
  await d.key("\r")
  await d.waitFor("Allow once")
  show("permission")
  await d.key("y")
  await d.waitFor("Done", 8000)
  await Bun.sleep(300)
  show("answer")
  await d.type("/mo")
  await Bun.sleep(300)
  show("suggestions")
  await d.key("\x15") // ctrl+u clears? fall back to backspaces
  for (let i = 0; i < 3; i++) await d.key("\x7f")
  await d.key("\x03")
  await d.key("\x03")
  console.log("exit", await d.close())
  fake.stop()
}
