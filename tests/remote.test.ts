// `lembas remote`: the remote: block managed without editing YAML, and a running link that follows it.
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { refusalFor } from "../src/acp/agent.ts"
import { limitsFromConfig, runLink, type LinkStatus } from "../src/acp/link.ts"
import { paths } from "../src/config/paths.ts"
import { remoteCommand } from "../src/remote.ts"
import { setTrust } from "../src/project/root.ts"

const stops: (() => void)[] = []
afterEach(() => {
  for (const s of stops.splice(0)) s()
})

const file = () => join(paths.config, "config.yaml")

function fresh(text = "") {
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(file(), text)
}

function dir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "lembas-remote-")))
}

function run(...args: string[]) {
  const out: string[] = []
  const err: string[] = []
  const code = remoteCommand(args, { out: (l) => void out.push(l), err: (l) => void err.push(l) })
  return { code, out, err, json: () => JSON.parse(out.join("\n")) }
}

test("list --json: one object, the defaults applied", () => {
  fresh()
  const r = run("list", "--json")
  expect(r.code).toBe(0)
  expect(r.out).toHaveLength(1)
  expect(r.json()).toEqual({ enabled: false, roots: [], max_mode: "edit", terminal: false })
  // Without --json, lines a person reads.
  const plain = run("list")
  expect(plain.out.join("\n")).toContain("remote work: off")
  expect(plain.out.join("\n")).toContain("max mode: edit")
})

test("add: absolute real paths, turns remote work on, skips duplicates and covered dirs", () => {
  fresh()
  const a = dir()
  const b = dir()
  mkdirSync(join(a, "sub"))
  const link = join(dir(), "link")
  symlinkSync(b, link)
  const r = run("add", a, link, "--json")
  expect(r.code).toBe(0)
  // The link is stored as where it leads.
  expect(r.json()).toEqual({ enabled: true, roots: [a, b], max_mode: "edit", terminal: false })
  // Again, and a directory inside one: nothing more.
  const again = run("add", a, join(a, "sub"))
  expect(again.code).toBe(0)
  expect(again.out.join("\n")).toContain("already a root")
  expect(again.out.join("\n")).toContain(`already covered by ${a}`)
  expect(run("list", "--json").json().roots).toEqual([a, b])
  // Said in words when it turned remote work on; not again.
  fresh()
  expect(run("add", a).out.join("\n")).toContain("remote work is now on")
  expect(run("add", b).out.join("\n")).not.toContain("remote work is now on")
})

test("add: a missing directory or a file refuses the whole command, writing nothing", () => {
  fresh("remote:\n  roots: []\n")
  const a = dir()
  writeFileSync(join(a, "f"), "")
  const r = run("add", a, join(a, "missing"), join(a, "f"), "--json")
  expect(r.code).toBe(1)
  expect(r.out).toEqual([])
  expect(r.err.join("\n")).toContain("no such directory")
  expect(r.err.join("\n")).toContain("not a directory")
  expect(readFileSync(file(), "utf8")).toBe("remote:\n  roots: []\n")
})

test("remove: compared after resolving; an unknown one is an error and changes nothing", () => {
  const a = dir()
  const b = dir()
  fresh(`remote:\n  enabled: true\n  roots: [${a}, ${b}]\n`)
  const link = join(dir(), "to-a")
  symlinkSync(a, link)
  const r = run("remove", link, "--json")
  expect(r.code).toBe(0)
  expect(r.json().roots).toEqual([b])
  const bad = run("remove", b, "/nowhere/at/all")
  expect(bad.code).toBe(1)
  expect(bad.err.join("\n")).toContain("not one of the remote roots")
  expect(run("list", "--json").json().roots).toEqual([b])
  // A root whose directory is gone can still be removed.
  fresh("remote:\n  roots: [/gone/long/ago]\n")
  expect(run("remove", "/gone/long/ago", "--json").json().roots).toEqual([])
})

test("enable, disable, mode and terminal; usage errors", () => {
  fresh()
  expect(run("enable", "--json").json().enabled).toBe(true)
  expect(run("disable", "--json").json().enabled).toBe(false)
  expect(run("mode", "plan", "--json").json().max_mode).toBe("plan")
  expect(run("terminal", "on", "--json").json().terminal).toBe(true)
  expect(run("terminal", "off", "--json").json().terminal).toBe(false)
  expect(run("mode", "yolo").code).toBe(2)
  expect(run("terminal", "maybe").code).toBe(2)
  expect(run("frobnicate").code).toBe(2)
})

test("the file's comments and layout are kept", () => {
  const a = dir()
  fresh("# mine\ntheme: dark # the dark one\nremote:\n  # where remote work may happen\n  max_mode: manual\n")
  run("add", a)
  run("terminal", "on")
  const text = readFileSync(file(), "utf8")
  expect(text).toContain("# mine")
  expect(text).toContain("theme: dark # the dark one")
  expect(text).toContain("# where remote work may happen")
  expect(text).toContain("max_mode: manual")
  expect(text).toContain(a)
})

test("the limits a running link holds follow the config without a restart", () => {
  const a = dir()
  setTrust(a, "trusted")
  fresh()
  const L = limitsFromConfig()
  expect(refusalFor(L, a)).toContain("remote work is off")
  run("add", a)
  expect(L.enabled).toBe(true)
  expect(L.roots).toEqual([a])
  expect(refusalFor(L, a)).toBeUndefined()
  run("mode", "plan")
  expect(L.maxMode).toBe("plan")
  run("disable")
  expect(refusalFor(L, a)).toContain("remote work is off")
  // A file broken mid-edit keeps what was read last, rather than opening or closing anything.
  writeFileSync(file(), "remote: [unterminated\n")
  expect(L.maxMode).toBe("plan")
  // /remote's link while remote work is off reaches only what its terminal shares; once on, the roots.
  fresh(`remote:\n  roots: [${a}]\n`)
  const shared = limitsFromConfig({ sharedOnly: true })
  expect(shared.sharedOnly).toBe(true)
  expect(shared.roots).toEqual([])
  run("enable")
  expect(shared.sharedOnly).toBe(false)
  expect(shared.roots).toEqual([a])
})

test("the service links with remote work off, says no roots and refuses everything, and serves once a folder is added — no restart", async () => {
  const a = dir()
  setTrust(a, "trusted")
  fresh()
  const hellos: any[] = []
  /** Answers by request id, from the link that is up now. */
  let answers = new Map<number, any>()
  let current: any
  let next = 1
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      const u = new URL(req.url)
      const base = `http://${u.host}`
      if (u.pathname === "/.well-known/lembas.json")
        return Response.json({ service: "lembas", version: "2.2.0", protocol: 1, protocols: [1, 2], harness_spec: "2.1.0", base_url: base, api: { openai: `${base}/v1` }, login: { device: { code: `${base}/c`, token: `${base}/t`, verify: `${base}/d` } } })
      if (u.pathname === "/api/devices/link" && srv.upgrade(req)) return
      return new Response("no", { status: 404 })
    },
    websocket: {
      open(ws) {
        current = ws
        answers = new Map()
      },
      message(_ws, msg) {
        const m = JSON.parse(String(msg))
        if (m.method === "_lembas/hello") hellos.push(m.params)
        else if (m.id !== undefined && !m.method) answers.set(m.id, m)
      },
    },
  })
  stops.push(() => server.stop(true))
  writeFileSync(join(paths.config, "lembas.json"), JSON.stringify({ instances: { fake: { base_url: `http://127.0.0.1:${server.port}`, connection: "fake", logged_in_at: "" } } }))
  mkdirSync(join(paths.config, "lembas"), { recursive: true })
  writeFileSync(join(paths.config, "lembas", "fake.key"), "lmb_device\n", { mode: 0o600 })

  const stop = new AbortController()
  stops.push(() => stop.abort())
  const states: LinkStatus[] = []
  const until = async (ok: () => boolean, what: string) => {
    for (let i = 0; i < 200 && !ok(); i++) await Bun.sleep(25)
    if (!ok()) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(states.map((s) => [s.state, s.detail]))}`)
  }
  /** A request from the instance over the link that is up, and its answer. */
  const ask = async (method: string, params: unknown) => {
    const id = next++
    current.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
    await until(() => answers.has(id), method)
    return answers.get(id)
  }
  const done = runLink({ pollMs: 20, backoffMs: [10, 20], signal: stop.signal, onStatus: (s) => void states.push(s) })
  // Off: linked all the same, saying it allows no folder, and refusing whatever is asked.
  await until(() => hellos.length === 1, "the first hello")
  expect(hellos[0].limits.roots).toEqual([])
  const init = await ask("initialize", { protocolVersion: 1, clientCapabilities: { _meta: { lembas: { protocol: 2 } } } })
  expect(init.result._meta.lembas.limits.roots).toEqual([])
  expect((await ask("_lembas/directories", {})).result.places).toEqual([])
  expect((await ask("_lembas/directories", { path: a })).result?.accepted ?? false).toBe(false)
  const refused = await ask("session/new", { cwd: a, mcpServers: [] })
  expect(refused.error.message).toContain("remote work is off")
  // Turned on from outside, as Desktop does: it links again, saying the new roots, and serves.
  run("add", a)
  await until(() => hellos.length === 2, "a second hello")
  expect(hellos[1].limits).toEqual({ roots: [a], max_mode: "edit", require_trust: true })
  expect(states.some((s) => s.detail === "the remote settings changed; linking again")).toBe(true)
  await ask("initialize", { protocolVersion: 1, clientCapabilities: { _meta: { lembas: { protocol: 2 } } } })
  expect((await ask("_lembas/directories", {})).result.places.map((p: any) => [p.path, p.accepted])).toEqual([[a, true]])
  // A change the instance was told about, and turned off again: each time a new hello.
  run("mode", "plan")
  await until(() => hellos.length === 3, "a third hello")
  expect(hellos[2].limits.max_mode).toBe("plan")
  run("disable")
  await until(() => hellos.length === 4, "a fourth hello")
  expect(hellos[3].limits.roots).toEqual([])
  stop.abort()
  expect((await done).state).toBe("stopped")
})
