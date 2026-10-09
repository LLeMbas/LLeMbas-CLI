#!/usr/bin/env bun
// Smoke test of the COMPILED binary — what `bun test` cannot see: that the bundle, OpenTUI's
// native library and bun:sqlite FTS5 all survive `bun build --compile`.
//   bun run scripts/smoke.ts [path/to/binary]
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { delta, fakeProvider, toolCall, usage } from "../tests/fake-provider.ts"
import { drive, fakeHome } from "./drive.ts"

const bin = resolve(process.argv[2] ?? "dist/lembas")
const home = mkdtempSync(join(tmpdir(), "lembas-smoke-"))
const env = { ...process.env, LEMBAS_HOME: home }
let failed = 0
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : "  " + detail}`)
  if (!ok) failed++
}
const run = (args: string[], cwd = home) => {
  const r = Bun.spawnSync([bin, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" })
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
}

// 1. --version
const v = run(["--version"])
check("--version", v.code === 0 && /^\d+\.\d+\.\d+/.test(v.out), v.err)

// 2. a headless run against a fake endpoint, with the session store on (FTS5 inside the binary)
const fake = fakeProvider([{ chunks: [delta({ content: "smoke ok" }), usage(5, 2)] }])
mkdirSync(join(home, ".config/lembas"), { recursive: true })
writeFileSync(
  join(home, ".config/lembas/connections.yaml"),
  `connections:\n  fake:\n    dialect: openai-chat\n    base_url: ${fake.url}\n    models:\n      m: {}\n`,
  { mode: 0o600 },
)
writeFileSync(join(home, ".config/lembas/config.yaml"), "model: fake/m\nupdate: { auto: off }\n")
const r = await new Promise<{ code: number; out: string; err: string }>((res) => {
  const p = Bun.spawn([bin, "run", "say hi"], { cwd: home, env, stdout: "pipe", stderr: "pipe" })
  Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]).then(([out, err, code]) => res({ code, out, err }))
})
fake.stop()
check("run → streamed answer", r.code === 0 && r.out === "smoke ok\n", JSON.stringify(r))
const s = run(["sessions"])
check("sessions → recorded (sqlite + FTS5 in the binary)", s.code === 0 && s.out.includes("fake/m"), s.err || s.out)

// 2b. serve --stdio: the ACP agent inside the binary answers initialize, opens a session and
// streams a reply — the code the LLeMbas link runs too.
{
  const f = fakeProvider([{ chunks: [delta({ content: "acp ok" })] }])
  writeFileSync(
    join(home, ".config/lembas/connections.yaml"),
    `connections:\n  fake:\n    dialect: openai-chat\n    base_url: ${f.url}\n    models:\n      m: {}\n`,
    { mode: 0o600 },
  )
  const p = Bun.spawn([bin, "serve", "--stdio"], { cwd: home, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const lines: any[] = []
  const reader = (async () => {
    let buf = ""
    for await (const chunk of p.stdout as unknown as AsyncIterable<Uint8Array>) {
      buf += new TextDecoder().decode(chunk)
      let nl: number
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line) lines.push(JSON.parse(line))
      }
    }
  })()
  const send = (m: unknown) => p.stdin.write(JSON.stringify(m) + "\n")
  const answer = async (id: number) => {
    for (let i = 0; i < 300; i++) {
      const hit = lines.find((l) => l.id === id)
      if (hit) return hit
      await Bun.sleep(20)
    }
    return undefined
  }
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } })
  const init = await answer(1)
  send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: home, mcpServers: [] } })
  const session = await answer(2)
  send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: session?.result?.sessionId, prompt: [{ type: "text", text: "hi" }] } })
  const done = await answer(3)
  const text = lines.filter((l) => l.method === "session/update" && l.params.update.sessionUpdate === "agent_message_chunk").map((l) => l.params.update.content.text).join("")
  p.stdin.end()
  await Promise.race([p.exited, Bun.sleep(3000)])
  p.kill()
  await reader.catch(() => {})
  f.stop()
  check("serve --stdio → ACP session streams a reply", init?.result?.protocolVersion === 1 && done?.result?.stopReason === "end_turn" && text === "acp ok", JSON.stringify({ init, session, done, text }))
}

// 3. the real TUI in a real PTY, read back through a headless xterm, at two sizes
for (const [cols, rows] of [
  [120, 40],
  [80, 24],
] as const) {
  const { fake: f, home: h, cwd } = fakeHome([
    { chunks: [delta({ content: "Let me check." }), toolCall(0, "c1", "bash", '{"command":"echo smoke > out.txt","description":"Write out.txt"}'), usage(9000, 40)] },
    { chunks: [delta({ content: "## Done\n\nWrote **out.txt**." }), usage(12000, 60)] },
  ])
  const d = await drive({ cols, rows, bin, home: h, cwd })
  // A fresh directory opens with the first-run question; trust it (the default), then work.
  const firstRun = await d.waitFor("Trust this directory?")
  await d.key("\r")
  const drawn = await d.waitFor("☤ LLeMbas")
  await d.type("make a file")
  await d.key("\r")
  const asked = await d.waitFor("Allow once")
  await d.key("y")
  const answered = await d.waitFor("Wrote out.txt.")
  await Bun.sleep(200)
  const screen = d.screen()
  const wrapped = d.wrapped()
  await d.key("\x03")
  await d.key("\x03")
  const code = await d.close()
  f.stop()
  const file = await Bun.file(join(cwd, "out.txt")).text().catch(() => "")
  check(
    `TUI ${cols}x${rows}: first run → prompt → approval → answer → quit`,
    firstRun && drawn && asked && answered && file === "smoke\n" && code === 0,
    `firstRun=${firstRun} drawn=${drawn} asked=${asked} answered=${answered} file=${JSON.stringify(file)} exit=${code}\n${screen.join("\n")}`,
  )
  check(`TUI ${cols}x${rows}: nothing wider than the terminal`, wrapped.length === 0, `wrapped rows: ${wrapped.join(", ")}`)
  check(`TUI ${cols}x${rows}: status bar on the last row`, (screen[rows - 1] ?? "").includes("manual · fake/coder"), screen[rows - 1] ?? "")
}

// 4. a fresh install: no model yet. A screen that says what to add (not an exception with the
// terminal left in mouse-reporting mode); r once it is added opens the session; the terminal is
// given back as it was found.
{
  const { fake: f, home: h, cwd } = fakeHome([{ chunks: [delta({ content: "hello after setup" }), usage(5, 2)] }])
  const cfgDir = join(h, ".config/lembas")
  const connections = await Bun.file(join(cfgDir, "connections.yaml")).text()
  await Bun.write(join(cfgDir, "connections.yaml"), "connections: {}\n")
  await Bun.write(join(cfgDir, "config.yaml"), "mode: manual\nupdate: { auto: off }\n")
  const d = await drive({ cols: 100, rows: 30, bin, home: h, cwd })
  await d.waitFor("Trust this directory?")
  await d.key("\r")
  const setup = await d.waitFor("no model to talk to yet")
  await Bun.write(join(cfgDir, "connections.yaml"), connections)
  await Bun.write(join(cfgDir, "config.yaml"), "model: fake/coder\nupdate: { auto: off }\n")
  // The screen opens on the sign-in, its address focused: ctrl+r tries again from there.
  const focused = await d.waitFor("Log in to a LLeMbas instance")
  await d.key("\x12")
  const opened = await d.waitFor("fake/coder")
  await d.type("hi")
  await d.key("\r")
  const answered = await d.waitFor("hello after setup")
  await d.key("\x03")
  await d.key("\x03")
  const code = await d.close()
  const modes = d.modes()
  f.stop()
  check("fresh install: no model → setup screen on the sign-in; ctrl+r after adding one → a session", setup && focused && opened && answered && code === 0, `setup=${setup} focused=${focused} opened=${opened} answered=${answered} exit=${code}\n${d.screen().join("\n")}`)
  check("fresh install: the terminal is given back (mouse reporting off, normal screen)", modes.mouse === "none" && !modes.altScreen, JSON.stringify(modes))
}

// 5. /reload: the same process starts again (execv) on the same session — the conversation is
// there, the terminal is the TUI's again, and quitting leaves it as it was found.
{
  const { fake: f, home: h, cwd } = fakeHome([
    { chunks: [delta({ content: "first answer" }), usage(5, 2)] },
    { chunks: [delta({ content: "second answer" }), usage(9, 2)] },
  ])
  const d = await drive({ cols: 100, rows: 30, bin, home: h, cwd })
  await d.waitFor("Trust this directory?")
  await d.key("\r")
  await d.waitFor("fake/coder")
  await d.type("hello")
  await d.key("\r")
  const answered = await d.waitFor("first answer")
  await d.type("/reload")
  await d.key("\r")
  // The new program draws its welcome box again, with the conversation loaded under it.
  await Bun.sleep(300)
  const back = await d.waitFor("☤ LLeMbas")
  // The new program's next request carries the conversation from before the reload.
  await d.type("again")
  await d.key("\r")
  await d.waitFor("second answer")
  const history = JSON.stringify(f.requests[1]?.messages ?? [])
  const kept = history.includes("hello") && history.includes("first answer")
  const screen = d.screen()
  await d.key("\x03")
  await d.key("\x03")
  const code = await d.close()
  const modes = d.modes()
  f.stop()
  check("/reload: started again, back on the same session", answered && back && kept && code === 0, `answered=${answered} back=${back} kept=${kept} exit=${code}\n${screen.join("\n")}`)
  check("/reload: the terminal is given back on quit", modes.mouse === "none" && !modes.altScreen, JSON.stringify(modes))
}

process.exit(failed ? 1 : 0)
