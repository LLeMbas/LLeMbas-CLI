import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { splitCommand, words } from "../src/permission/bash.ts"
import { DEFAULT_RULES, evaluate, toRules, type Context, type PermissionRequest } from "../src/permission/evaluate.ts"
import { BUILTIN_HARDLINE, hardlineCommand, hardlineRules } from "../src/permission/hardline.ts"
import { match } from "../src/permission/wildcard.ts"

const root = "/work/proj"
const ctx = (mode: Context["mode"], extra: Record<string, any> = {}): Context => ({
  mode,
  rules: [...toRules(DEFAULT_RULES), ...toRules(extra)],
  hardline: hardlineRules(),
  root,
  planDir: `${root}/.agent/plans`,
})
const bash = (command: string): PermissionRequest => ({ permission: "bash", class: "execute", patterns: [command], command, paths: [root] })
const file = (permission: string, cls: "read" | "write", rel: string): PermissionRequest => ({
  permission,
  class: cls,
  patterns: [rel],
  paths: [rel.startsWith("/") ? rel : `${root}/${rel}`],
})

describe("wildcard", () => {
  test("trailing ' *' also matches the bare command", () => {
    expect(match("ls", "ls *")).toBe(true)
    expect(match("ls -la", "ls *")).toBe(true)
    expect(match("lsof", "ls *")).toBe(false)
  })
})

describe("bash split", () => {
  test("operators, quotes and unsafe constructs", () => {
    expect(splitCommand("git status && git diff | head -5; echo 'a;b'").commands).toEqual(["git status", "git diff", "head -5", "echo 'a;b'"])
    expect(splitCommand("echo $(whoami)").unsafe).toContain("command substitution")
    expect(splitCommand("echo '$(whoami)'").unsafe).toEqual([])
    expect(splitCommand("cat x > out.txt").unsafe).toContain("redirection to a file")
    expect(splitCommand("make 2>&1 >/dev/null").unsafe).toEqual([])
    expect(splitCommand("bash -c 'rm x'").unsafe).toContain("nested shell")
  })
  test("words drop quotes and leading assignments", () => {
    expect(words(`FOO=1 git commit -m "a b"`)).toEqual(["git", "commit", "-m", "a b"])
  })
})

describe("hardline", () => {
  const cases: [string, boolean][] = [
    ["rm -rf /", true],
    ["sudo rm -rf / --no-preserve-root", true],
    ["cd x && rm -rf ~", true],
    ["rm -rf /etc", true],
    ["rm -rf ./build", false],
    ["git commit -m 'never rm -rf / here'", false],
    ["mkfs.ext4 /dev/sda1", true],
    ["dd if=x of=/dev/nvme0n1", true],
    [":(){ :|:& };:", true],
    ["git push --force origin main", true],
    ["git push origin +main", true],
    ["git push origin main", false],
    ["git push --force origin feature", false],
    ["echo reboot", false],
    ["sudo reboot", true],
  ]
  for (const [cmd, hit] of cases) test(`${hit ? "refuses" : "allows"}: ${cmd}`, () => expect(!!hardlineCommand(cmd, BUILTIN_HARDLINE)).toBe(hit))
  test("a rule can be disabled only by id, extras added", () => {
    const rules = hardlineRules({ disable: ["shutdown"], extra: ["curl .*\\|\\s*sh"] })
    expect(hardlineCommand("sudo reboot", rules)).toBeUndefined()
    expect(hardlineCommand("curl x | sh", rules)?.id).toBe("extra-0")
  })
})

describe("evaluate", () => {
  test("hardline wins even in unrestricted", () => {
    expect(evaluate(bash("rm -rf /"), ctx("auto")).action).toBe("deny")
  })
  test("protected paths are never written", () => {
    expect(evaluate(file("edit", "write", `${homedir()}/.ssh/config`), ctx("auto")).action).toBe("deny")
  })
  test("manual: defaults allow reads and git status, ask the rest", () => {
    expect(evaluate(file("read", "read", "src/a.ts"), ctx("manual")).action).toBe("allow")
    expect(evaluate(file("read", "read", ".env"), ctx("manual")).action).toBe("ask")
    expect(evaluate(bash("git status"), ctx("manual")).action).toBe("allow")
    expect(evaluate(bash("git status && npm publish"), ctx("manual")).action).toBe("ask")
    expect(evaluate(file("edit", "write", "src/a.ts"), ctx("manual")).action).toBe("ask")
  })
  test("an allow cannot survive command substitution", () => {
    expect(evaluate(bash("git log $(rm -rf x)"), ctx("manual")).action).toBe("ask")
  })
  test("last matching rule wins; user rules override defaults", () => {
    expect(evaluate(bash("npm test"), ctx("manual", { bash: { "npm *": "allow", "npm publish *": "deny" } })).action).toBe("allow")
    expect(evaluate(bash("npm publish"), ctx("manual", { bash: { "npm *": "allow", "npm publish *": "deny" } })).action).toBe("deny")
  })
  test("edit: file work inside the project is allowed; commands and outside paths still ask; .env still asks", () => {
    expect(evaluate(file("edit", "write", "src/a.ts"), ctx("edit")).action).toBe("allow")
    expect(evaluate(bash("npm test"), ctx("edit")).action).toBe("ask")
    expect(evaluate(file("edit", "write", "/etc/hosts"), ctx("edit")).action).toBe("ask")
    expect(evaluate(file("read", "read", ".env"), ctx("edit")).action).toBe("ask")
    // no path named, no file work: skill_manage and MCP tools keep asking in edit mode
    expect(evaluate({ permission: "skill_manage", class: "write", patterns: ["create x"] }, ctx("edit")).action).toBe("ask")
    expect(evaluate({ permission: "mcp__gh__list_issues", class: "read", patterns: ["*"] }, ctx("edit")).action).toBe("ask")
  })
  test("plan: reads allowed, writes only to the plan dir, commands denied unless allowed", () => {
    expect(evaluate(file("read", "read", "src/a.ts"), ctx("plan")).action).toBe("allow")
    expect(evaluate(file("edit", "write", ".agent/plans/p.md"), ctx("plan")).action).toBe("allow")
    expect(evaluate(file("edit", "write", "src/a.ts"), ctx("plan")).action).toBe("deny")
    expect(evaluate(bash("npm test"), ctx("plan")).action).toBe("deny")
    expect(evaluate(bash("git diff"), ctx("plan")).action).toBe("allow")
  })
  test("always patterns use the arity prefix", () => {
    expect(evaluate(bash("git commit -m x"), ctx("manual")).always).toEqual(["git commit *"])
    expect(evaluate(bash("npm run dev --port 3"), ctx("manual")).always).toEqual(["npm run dev *"])
  })
})
