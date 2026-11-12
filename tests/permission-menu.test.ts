// A rule set from a menu (/permissions, /mcp) loosens exactly what the person chose and no more:
// it decides what a broader rule decided, never what a narrower, stricter one did; the person's
// own config stays the floor; and the session judges a call as the next start does from the file
// the rule was saved to.
import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../src/app.ts"
import { paths } from "../src/config/paths.ts"
import { evaluate, narrowerThan, standsInTheWay, toRules, type Rule } from "../src/permission/evaluate.ts"
import { setTrust } from "../src/project/root.ts"

type App = ReturnType<typeof createApp>
const apps: App[] = []
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close()
})

function config(extra = "") {
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(join(paths.config, "connections.yaml"), "connections:\n  f:\n    type: webui\n    url: http://127.0.0.1:9/v1\n    models: { f/m: {} }\n", { mode: 0o600 })
  writeFileSync(join(paths.config, "config.yaml"), `model: f/m\n${extra}`)
}
function project(trusted = true): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lembas-rules-")))
  Bun.spawnSync(["git", "init", "-q", dir])
  writeFileSync(join(dir, ".env"), "SECRET=1\n")
  if (trusted) setTrust(dir, "trusted")
  return dir
}
const open = (cwd: string): App => {
  const app = createApp({ cwd, store: false, asker: { ask: async () => ({ kind: "deny" as const }) } })
  apps.push(app)
  return app
}
/** What a call of a tool would meet now: allow, ask or deny (in manual mode, before any card). */
function verdict(app: App, tool: string, args: Record<string, unknown>): string {
  const t = app.engine.o.tools.find((x) => x.name === tool)!
  const request = t.permission(args as never, { ...app.engine.o.toolCtx, signal: new AbortController().signal })
  return evaluate(request, { ...app.engine.o.perm, mode: "manual", rules: app.engine.rules }).action
}
const saved = (dir: string) => (existsSync(join(dir, ".agent", "config.yaml")) ? readFileSync(join(dir, ".agent", "config.yaml"), "utf8") : "")

test("choosing what is already in force changes nothing: no rule added, nothing written — and .env still asks", () => {
  config()
  const dir = project()
  const app = open(dir)
  expect(verdict(app, "read", { path: ".env" })).toBe("ask")
  // Enter on the built-in `read — always allowed` row, Enter again on the value it already has.
  const before = app.engine.rules.length
  expect(app.engine.setRule({ permission: "read", pattern: "*", action: "allow" })).toEqual({ unchanged: true })
  expect(app.engine.rules.length).toBe(before)
  expect(saved(dir)).toBe("")
  expect(verdict(app, "read", { path: ".env" })).toBe("ask")
})

test("a broad allow from the menu leaves the narrower asks asking — .env, private addresses — in this session and after a start from the saved file", () => {
  config()
  const dir = project()
  const app = open(dir)
  // Something is really changed first, so the broad rule is made (not a no-op) and saved.
  expect(app.engine.setRule({ permission: "read", pattern: "*", action: "ask" })).toMatchObject({ saved: "project" })
  const r = app.engine.setRule({ permission: "read", pattern: "*", action: "allow" })
  expect(r).toMatchObject({ saved: "project" })
  // It says which stricter rules it leaves standing.
  expect((r as { still: Rule[] }).still.map((x) => `${x.permission} ${x.pattern} ${x.action}`)).toEqual(["read *.env ask", "read *.env.* ask"])
  expect(verdict(app, "read", { path: "README.md" })).toBe("allow")
  expect(verdict(app, "read", { path: ".env" })).toBe("ask")
  expect(verdict(app, "read", { path: "config/.env.local" })).toBe("ask")

  expect(verdict(app, "web_fetch", { url: "http://127.0.0.1:8080/admin" })).toBe("ask")
  expect(app.engine.setRule({ permission: "web_fetch", pattern: "*", action: "ask" })).toMatchObject({ saved: "project" })
  expect(app.engine.setRule({ permission: "web_fetch", pattern: "*", action: "allow" })).toMatchObject({ saved: "project", still: [{ permission: "web_fetch", pattern: "private:*", action: "ask" }] })
  expect(verdict(app, "web_fetch", { url: "https://example.org/" })).toBe("allow")
  expect(verdict(app, "web_fetch", { url: "http://127.0.0.1:8080/admin" })).toBe("ask")

  // Even the broadest rule there is.
  expect(app.engine.setRule({ permission: "*", pattern: "*", action: "allow" })).toMatchObject({ saved: "project" })
  expect(verdict(app, "read", { path: ".env" })).toBe("ask")
  expect(verdict(app, "web_fetch", { url: "http://127.0.0.1:8080/admin" })).toBe("ask")

  // The next start reads the file: every call is judged as this session judged it.
  expect(saved(dir)).toContain("read")
  const again = open(dir)
  expect(again.engine.ownRules.length).toBe(0)
  for (const [tool, args] of [
    ["read", { path: "README.md" }],
    ["read", { path: ".env" }],
    ["read", { path: "config/.env.local" }],
    ["web_fetch", { url: "https://example.org/" }],
    ["web_fetch", { url: "http://127.0.0.1:8080/admin" }],
    ["bash", { command: "ls -la" }],
    ["bash", { command: "make install" }],
  ] as const)
    expect([tool, JSON.stringify(args), verdict(again, tool, args)]).toEqual([tool, JSON.stringify(args), verdict(app, tool, args)])
})

test("`bash allow` typed into Add a rule does not undo the person's own `rm *` deny or `git push *` ask — now, and after a start from the file", () => {
  config("permission:\n  bash:\n    'rm *': deny\n    'git push *': ask\n")
  const dir = project()
  const app = open(dir)
  const r = app.engine.setRule({ permission: "bash", pattern: "*", action: "allow" })
  expect(r).toMatchObject({ saved: "project" })
  expect((r as { still: Rule[] }).still.map((x) => `${x.pattern} ${x.action}`)).toEqual(expect.arrayContaining(["rm * deny", "git push * ask"]))
  expect(verdict(app, "bash", { command: "make all" })).toBe("allow")
  expect(verdict(app, "bash", { command: "rm -rf build" })).toBe("deny")
  expect(verdict(app, "bash", { command: "git push origin main" })).toBe("ask")
  const again = open(dir)
  expect(verdict(again, "bash", { command: "make all" })).toBe("allow")
  expect(verdict(again, "bash", { command: "rm -rf build" })).toBe("deny")
  expect(verdict(again, "bash", { command: "git push origin main" })).toBe("ask")
})

test("a rule the person's own config, or a written deny, takes in whole is refused where it is made — not set, not saved", () => {
  config("permission:\n  bash:\n    'git push *': ask\n    'rm *': deny\n")
  const dir = project()
  const app = open(dir)
  // The very rule the person wrote, loosened: refused.
  expect(app.engine.setRule({ permission: "bash", pattern: "git push *", action: "allow" })).toMatchObject({ refused: { pattern: "git push *", action: "ask", source: "global" } })
  // A narrower allow under their deny: refused too — the deny takes it in.
  expect(app.engine.setRule({ permission: "bash", pattern: "rm -rf build", action: "allow" })).toMatchObject({ refused: { pattern: "rm *", action: "deny" } })
  expect(app.engine.ownRules.length).toBe(0)
  expect(saved(dir)).toBe("")
  // Stricter is always possible.
  expect(app.engine.setRule({ permission: "bash", pattern: "git push *", action: "deny" })).toMatchObject({ saved: "project", still: [] })
  expect(verdict(app, "bash", { command: "git push origin main" })).toBe("deny")
})

test("a save that fails is said, and the rule holds for this session only; removing a rule takes its saved copy too", () => {
  config()
  const dir = project()
  const app = open(dir)
  expect(app.engine.setRule({ permission: "bash", pattern: "make *", action: "allow" })).toMatchObject({ saved: "project" })
  expect(saved(dir)).toContain("make *")
  expect(app.engine.dropSessionRule("bash", "make *")).toEqual({ removed: true, file: "removed" })
  expect(saved(dir)).not.toContain("make *")
  expect(verdict(app, "bash", { command: "make all" })).toBe("ask")
  expect(verdict(open(dir), "bash", { command: "make all" })).toBe("ask")
  // The project's config cannot be written (a directory stands where the file should be).
  const blocked = project()
  const b = open(blocked)
  mkdirSync(join(blocked, ".agent", "config.yaml"), { recursive: true })
  const r = b.engine.setRule({ permission: "bash", pattern: "make *", action: "allow" })
  expect(r).toMatchObject({ saved: "session" })
  expect((r as { failed?: string }).failed).toBeTruthy()
  expect(verdict(b, "bash", { command: "make all" })).toBe("allow")
  // An untrusted project: the session only, and removing says nothing was saved.
  const u = open(project(false))
  expect(u.engine.setRule({ permission: "bash", pattern: "make *", action: "allow" })).toEqual({ saved: "session", still: [] })
  expect(u.engine.dropSessionRule("bash", "make *")).toEqual({ removed: true, file: "kept" })
})

test("the rules themselves: what is narrower, what stands in the way, and a project's broad allow under a default's narrow ask", () => {
  expect(narrowerThan({ permission: "read", pattern: "*.env" }, { permission: "read", pattern: "*" })).toBe(true)
  expect(narrowerThan({ permission: "read", pattern: "*" }, { permission: "*", pattern: "*" })).toBe(true)
  expect(narrowerThan({ permission: "read", pattern: "*" }, { permission: "read", pattern: "*" })).toBe(false)
  expect(narrowerThan({ permission: "read", pattern: "*" }, { permission: "read", pattern: "*.env" })).toBe(false)
  const base = [...toRules({ read: { "*": "allow", "*.env": "ask" }, bash: { "*": "ask", "rm -rf /*": "deny" } }, "default")]
  expect(standsInTheWay({ permission: "bash", pattern: "rm -rf /tmp", action: "allow" }, base)).toMatchObject({ pattern: "rm -rf /*" })
  expect(standsInTheWay({ permission: "bash", pattern: "*", action: "allow" }, base)).toBeUndefined()
  // A project's config saying `read: allow` (a file a menu wrote, or one somebody typed): .env still asks.
  const rules = [...base, ...toRules({ read: "allow", bash: "allow" }, "project")]
  const ctx = { mode: "manual" as const, rules, hardline: [], root: "/p" }
  expect(evaluate({ permission: "read", class: "read", patterns: [".env"] }, ctx).action).toBe("ask")
  expect(evaluate({ permission: "read", class: "read", patterns: ["a.txt"] }, ctx).action).toBe("allow")
  expect(evaluate({ permission: "bash", class: "execute", patterns: ["rm -rf /"] }, ctx).action).toBe("deny")
  // …unless the project names the narrow thing itself.
  const named = [...base, ...toRules({ read: { "*.env": "allow" } }, "project")]
  expect(evaluate({ permission: "read", class: "read", patterns: [".env"] }, { ...ctx, rules: named }).action).toBe("allow")
})
