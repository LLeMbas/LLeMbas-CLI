// Local mode (`lembas -l`): everything under the project, the user's login read and nothing more,
// and what would reach or be kept on a server turned off.
import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { addPendingDeleted, pendingDeleted } from "../src/acp/pending.ts"
import { connectHub, Hub } from "../src/acp/hub.ts"
import { limitsFromConfig, LinkError, runLink } from "../src/acp/link.ts"
import { loadConfig } from "../src/config/load.ts"
import { globalPaths, isLocal, makeTempDir, paths, setLocalRoot } from "../src/config/paths.ts"
import { instances, keyFile, logout } from "../src/lembas/login.ts"
import { pushPersonalization } from "../src/lembas/personal.ts"
import { evaluate } from "../src/permission/evaluate.ts"
import { protectedPath } from "../src/permission/hardline.ts"
import { enterLocal, LocalError } from "../src/project/local.ts"
import { delta, fakeProvider } from "./fake-provider.ts"

const cli = join(import.meta.dir, "../src/cli.ts")
const xdgData = process.env.XDG_DATA_HOME

afterEach(() => {
  setLocalRoot(undefined)
  if (xdgData === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = xdgData
})

function repo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lembas-local-")))
  Bun.spawnSync(["git", "init", "-q", dir])
  return dir
}

/** The user's own files: a connection and a config.yaml local mode must not read. */
function userFiles(extraConfig = "") {
  mkdirSync(globalPaths.config, { recursive: true })
  writeFileSync(join(globalPaths.config, "connections.yaml"), "connections:\n  mine:\n    dialect: openai-chat\n    base_url: http://127.0.0.1:9/v1\n    models: { m: {} }\n", { mode: 0o600 })
  writeFileSync(join(globalPaths.config, "config.yaml"), `model: mine/m\ntheme: forest\n${extraConfig}`)
}

test("every directory is under the project, kept out of git; .lembas where .agent is another tool's", () => {
  const dir = repo()
  mkdirSync(join(dir, "sub"))
  const { root, notes } = enterLocal(join(dir, "sub"))
  expect(root).toBe(join(dir, ".agent/local/lembas"))
  expect(isLocal()).toBe(true)
  for (const p of [paths.config, paths.data, paths.state]) expect(p.startsWith(`${root}/`)).toBe(true)
  for (const sub of ["config", "data", "state", "state/tmp"]) expect(existsSync(join(root, sub))).toBe(true)
  expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain("/.agent/local/")
  expect(notes.join("\n")).toContain(".agent/local/lembas")
  // Its own temporary files are made there too.
  expect(makeTempDir("x-").startsWith(join(root, "state/tmp"))).toBe(true)
  setLocalRoot(undefined)

  const other = repo()
  mkdirSync(join(other, ".agent/workflows"), { recursive: true })
  writeFileSync(join(other, ".agent/workflows/x.md"), "someone else's")
  expect(enterLocal(other).root).toBe(join(other, ".lembas/local/lembas"))
})

test("a local directory that came with the repository is refused", () => {
  const dir = repo()
  mkdirSync(join(dir, ".agent/local/lembas/config"), { recursive: true })
  writeFileSync(join(dir, ".agent/local/lembas/config/config.yaml"), "mode: auto\n")
  Bun.spawnSync(["git", "-C", dir, "add", "-f", ".agent/local/lembas/config/config.yaml"])
  expect(() => enterLocal(dir)).toThrow(LocalError)
  expect(isLocal()).toBe(false)
})

test("the user's config.yaml is not read; their connections are, and a local one wins by name", () => {
  userFiles()
  const dir = repo()
  enterLocal(dir)
  let loaded = loadConfig()
  expect(loaded.config.model).toBeUndefined()
  expect(loaded.config.theme).toBeUndefined()
  expect(Object.keys(loaded.connections)).toEqual(["mine"])
  writeFileSync(join(paths.config, "config.yaml"), "model: mine/m\n")
  writeFileSync(join(paths.config, "connections.yaml"), "connections:\n  mine:\n    dialect: openai-chat\n    base_url: http://127.0.0.1:8/v1\n    models: { n: {} }\n", { mode: 0o600 })
  loaded = loadConfig()
  expect(loaded.config.model).toBe("mine/m")
  expect(Object.keys(loaded.connections.mine!.models)).toEqual(["n"])
})

test("a login made outside local mode is read, never written or signed out", async () => {
  mkdirSync(join(globalPaths.config, "lembas"), { recursive: true })
  writeFileSync(join(globalPaths.config, "lembas.json"), JSON.stringify({ instances: { ex: { base_url: "http://127.0.0.1:9", connection: "ex", logged_in_at: "" } } }))
  writeFileSync(join(globalPaths.config, "lembas", "ex.key"), "lmb_x\n", { mode: 0o600 })
  enterLocal(repo())
  expect(Object.keys(instances())).toEqual(["ex"])
  expect(keyFile("ex")).toBe(join(globalPaths.config, "lembas", "ex.key"))
  await expect(logout("ex")).rejects.toThrow("outside local mode")
  expect(existsSync(join(globalPaths.config, "lembas", "ex.key"))).toBe(true)
  await expect(pushPersonalization("personality", "concise")).rejects.toThrow("local mode")
})

test("the instance is not used for search, fetch, embeddings or the library; the whole hardline stays", () => {
  mkdirSync(globalPaths.config, { recursive: true })
  writeFileSync(join(globalPaths.config, "connections.yaml"), "connections:\n  ex:\n    type: webui\n    url: http://127.0.0.1:9\n    api_key: k\n", { mode: 0o600 })
  enterLocal(repo())
  writeFileSync(
    join(paths.config, "config.yaml"),
    "search:\n  order: [webui, ddg]\n  fetch: webui\nlibrary: lembas\nembedding: ex/nomic\nhardline_disable: [rm-root]\n",
  )
  const loaded = loadConfig()
  expect(loaded.config.search?.order).toEqual(["ddg"])
  expect(loaded.config.search?.fetch).toBe("local")
  expect(loaded.config.search?.webui).toBeUndefined()
  expect(loaded.config.library).toBe("local")
  expect(loaded.config.embedding).toBeUndefined()
  expect(loaded.config.hardline_disable).toBeUndefined()
  expect(loaded.warnings.join("\n")).toContain("local mode")
})

test("the link, the hub, /remote's socket and deletes for the server are off", async () => {
  enterLocal(repo())
  writeFileSync(join(paths.config, "config.yaml"), `remote:\n  enabled: true\n  roots: [/]\n`)
  await expect(runLink()).rejects.toBeInstanceOf(LinkError)
  await expect(runLink({ sharedOnly: true })).rejects.toThrow("local mode")
  expect(await connectHub()).toBeUndefined()
  expect(await new Hub({ service: true, limits: limitsFromConfig() }).listen()).toBe(false)
  addPendingDeleted(["s1"])
  expect(pendingDeleted()).toEqual([])
})

test("tools never write local mode's own files, and read them only as outside the project", () => {
  const dir = repo()
  const { root } = enterLocal(dir)
  expect(protectedPath(join(root, "config/config.yaml"))).toBe("local mode's own files")
  expect(protectedPath(join(root, "state/trust.json"))).toBe("local mode's own files")
  expect(protectedPath(join(root, "data/worktrees/abc/x.ts"))).toBeUndefined()
  // The user's connections.yaml stays guarded as well.
  expect(protectedPath(join(globalPaths.config, "connections.yaml"))).toBe("connections.yaml")
  const ctx = { mode: "edit" as const, root: dir, rules: [], hardline: [] }
  expect(evaluate({ permission: "write", class: "write", patterns: ["x"], paths: [join(root, "config/config.yaml")] }, ctx).action).toBe("deny")
  expect(evaluate({ permission: "read", class: "read", patterns: ["x"], paths: [join(root, "config/lembas/ex.key")] }, ctx).action).not.toBe("allow")
  expect(evaluate({ permission: "read", class: "read", patterns: ["x"], paths: [join(dir, "hello.txt")] }, ctx).action).toBe("allow")
})

/** Every file under `dir` — but the runtime's own cache: this test runs the CLI from source with
 *  `bun`, which keeps one under HOME (the compiled binary does not; the smoke test checks that). */
function listing(dir: string): string[] {
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((p) => p !== ".bun" && !p.startsWith(".bun/"))
    .sort()
}

test("the CLI: -l refuses what it turns off, and a run writes nothing outside the project", async () => {
  const fake = fakeProvider([{ chunks: [delta({ content: "local hi" })] }])
  try {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "lembas-local-home-")))
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), "lembas-local-tmp-")))
    mkdirSync(join(home, ".config/lembas"), { recursive: true })
    writeFileSync(join(home, ".config/lembas/connections.yaml"), `connections:\n  fake:\n    dialect: openai-chat\n    base_url: ${fake.url}\n    models: { m: {} }\n`, { mode: 0o600 })
    writeFileSync(join(home, ".config/lembas/config.yaml"), "model: nowhere/x\n")
    const dir = repo()
    const env = { ...process.env, LEMBAS_HOME: home, HOME: home, TMPDIR: tmp, XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state") }
    const before = { home: listing(home), tmp: listing(tmp) }
    const run = async (...args: string[]) => {
      const p = Bun.spawn(["bun", cli, ...args], { cwd: dir, env, stdout: "pipe", stderr: "pipe" })
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
      return { out, err, code }
    }
    for (const cmd of ["service", "update", "uninstall", "remote"]) {
      const r = await run("-l", cmd)
      expect(r.code).toBe(1)
      expect(r.err).toContain("off in local mode")
    }
    // The user's config.yaml names a model that does not exist: read, it would fail.
    const r = await run("--local", "run", "hello")
    expect(r.err).not.toContain("nowhere")
    expect(r.out).toBe("local hi\n")
    expect(r.code).toBe(0)
    const help = await run("-l", "--help")
    expect(help.out).toContain("Local mode")
    expect(existsSync(join(dir, ".agent/local/lembas/data/sessions.db"))).toBe(true)
    expect({ home: listing(home), tmp: listing(tmp) }).toEqual(before)
  } finally {
    fake.stop()
  }
}, 60_000)
