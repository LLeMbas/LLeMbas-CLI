// What a review of the permission system found, one test per way out.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { stricterMode } from "../src/app.ts"
import { DEFAULT_RULES, evaluate, shadowsDeny, toRules, type Context, type PermissionRequest, type Rule } from "../src/permission/evaluate.ts"
import { BUILTIN_HARDLINE, hardlineCommand } from "../src/permission/hardline.ts"
import { replace } from "../src/tool/replace-text.ts"

const root = realpathSync(mkdtempSync(join(tmpdir(), "ph-perm-")))
const outside = realpathSync(mkdtempSync(join(tmpdir(), "ph-out-")))
writeFileSync(join(outside, "secret"), "x")
mkdirSync(join(root, ".agent"), { recursive: true })
symlinkSync(outside, join(root, "link"))
symlinkSync(outside, join(root, ".agent", "plans"))

const ctx = (mode: Context["mode"], extra: Rule[] = []): Context => ({
  mode,
  rules: [...toRules(DEFAULT_RULES), ...extra],
  hardline: BUILTIN_HARDLINE,
  root,
  planDir: join(root, ".agent", "plans"),
  projectDir: join(root, ".agent"),
})
const bash = (command: string): PermissionRequest => ({ permission: "bash", class: "execute", patterns: [command], command, paths: [root] })
const file = (permission: string, cls: "read" | "write", abs: string): PermissionRequest => ({ permission, class: cls, patterns: [abs], paths: [abs] })

describe("the default allow list", () => {
  test("options that write files or run programs ask", () => {
    for (const c of ["rg --pre ./x foo", "git diff --output=/tmp/x", "git log --output=x", "git branch -v -D main", "git branch --list -D x", "tree -o out.txt", "file -C -m magic"])
      expect([c, evaluate(bash(c), ctx("manual")).action]).toEqual([c, "ask"])
    for (const c of ["rg foo src", "git diff HEAD~1", "git branch -v", "git branch --list feat*", "tree src", "git log --oneline"])
      expect([c, evaluate(bash(c), ctx("manual")).action]).toEqual([c, "allow"])
  })

  test("and in plan mode (what a read-only project gets) they are refused", () => {
    expect(evaluate(bash("rg --pre ./x foo"), ctx("plan")).action).toBe("deny")
  })
})

describe("symlinks are judged by where they point", () => {
  test("a link out of the project is outside it", () => {
    expect(evaluate(file("read", "read", join(root, "link", "secret")), ctx("manual")).action).toBe("ask")
    expect(evaluate(file("edit", "write", join(root, "link", "secret")), ctx("edit")).action).toBe("ask")
  })

  test("a plans directory that points elsewhere is not the plans directory", () => {
    expect(evaluate(file("edit", "write", join(root, ".agent", "plans", "p.md")), ctx("plan")).action).toBe("deny")
  })

  test("a link to ~/.ssh is ~/.ssh", () => {
    const home = realpathSync(homedir())
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ph-ssh-")))
    try {
      symlinkSync(join(home, ".ssh"), join(dir, "keys"))
    } catch {}
    const r = evaluate(file("edit", "write", join(dir, "keys", "authorized_keys")), { ...ctx("auto"), root: dir })
    expect(r.action).toBe("deny")
  })
})

describe("edit mode", () => {
  test("git's files and the project's own config, agents, commands and skills still ask", () => {
    for (const p of [".git/config", ".git/hooks/pre-commit", ".agent/config.yaml", ".agent/agents/a.md", ".agent/commands/c.md", ".agent/skills/s/SKILL.md", "sub/.git/config"])
      expect([p, evaluate(file("edit", "write", join(root, p)), ctx("edit")).action]).toEqual([p, "ask"])
    expect(evaluate(file("edit", "write", join(root, "src/a.ts")), ctx("edit")).action).toBe("allow")
    expect(evaluate(file("edit", "write", join(root, ".gitignore")), ctx("edit")).action).toBe("allow")
  })
})

describe("the hardline floor", () => {
  test("another spelling of the same command is still refused", () => {
    const home = homedir()
    for (const c of ["X=1 rm -rf /", "/bin/rm -rf /", "\\rm -rf /", "'rm' -rf /", "rm -rf /etc/", `rm -rf ${home}`, "rm -rf ~/.", "sudo -u root rm -rf /", "env -i rm -rf /", "sh -c 'rm -rf /'", "{ rm -rf /; }", "if x; then rm -rf /; fi", "nice -n 5 rm -rf /", "timeout 5 rm -rf /etc", "find / -delete", "find /etc -exec rm {} +", "git push -uf origin main", "git -C . push -f origin main"])
      expect([c, hardlineCommand(c, BUILTIN_HARDLINE) !== undefined]).toEqual([c, true])
  })

  test("and ordinary commands are not", () => {
    for (const c of ["rm -rf build", "git push origin main", "git push --force origin feature", "find . -name '*.o' -delete", "echo 'rm -rf /'", "timeout 5 ls /", "rm -rf ~/proj/tmp"])
      expect([c, hardlineCommand(c, BUILTIN_HARDLINE)?.id]).toEqual([c, undefined])
  })
})

describe("always-allow answers", () => {
  const deny: Rule = { permission: "bash", pattern: "git push --force *", action: "deny" }
  const learned: Rule = { permission: "bash", pattern: "git push *", action: "allow", learned: true }
  test("never override a deny somebody wrote", () => {
    expect(evaluate(bash("git push --force origin dev"), ctx("manual", [deny, learned])).action).toBe("deny")
    expect(evaluate(bash("git push origin dev"), ctx("manual", [deny, learned])).action).toBe("allow")
    expect(shadowsDeny(learned, [deny])).toBe(true)
    expect(shadowsDeny({ ...learned, pattern: "git status *" }, [deny])).toBe(false)
  })

  test("a command that runs another command is approved exactly, never with *", () => {
    for (const c of ["sudo apt update", "env X=1 make", "xargs rm", "find . -name x"]) expect(evaluate(bash(c), ctx("manual")).always).toEqual([c])
  })
})

describe("the files a command names", () => {
  test("follow the read rules and the project boundary", () => {
    writeFileSync(join(root, ".env"), "K=v")
    expect(evaluate(bash("cat .env"), ctx("manual")).action).toBe("ask")
    expect(evaluate(bash("cat ~/.ssh/id_ed25519"), ctx("manual")).action).toBe("ask")
    expect(evaluate(bash(`grep -r key ${outside}`), ctx("manual")).action).toBe("ask")
    expect(evaluate(bash("cat README.md"), ctx("manual")).action).toBe("allow")
    expect(evaluate(bash("grep -r /api src"), ctx("manual")).action).toBe("allow")
    expect(evaluate(bash("ls src 2> /dev/null"), ctx("manual")).action).toBe("allow")
  })

  test("so do grep and glob on a path", () => {
    expect(evaluate(file("grep", "read", join(root, ".env")), ctx("manual")).action).toBe("ask")
    expect(evaluate(file("grep", "read", join(root, "src")), ctx("manual")).action).toBe("allow")
  })
})

describe("subagents", () => {
  test("an agent's own mode can only make it stricter", () => {
    expect(stricterMode("auto", "manual")).toBe("manual")
    expect(stricterMode("edit", "plan")).toBe("plan")
    expect(stricterMode("plan", "auto")).toBe("plan")
    expect(stricterMode(undefined, "edit")).toBe("edit")
  })
})

describe("edits", () => {
  test("replace-all puts $ in literally", () => {
    expect(replace("a x a", "a", "$$HOME $&", true)).toBe("$$HOME $& x $$HOME $&")
  })
})

// Audit: what bash reads differently from the splitter is never trusted.
import { splitCommand as split13 } from "../src/permission/bash.ts"
test("a comment is skipped, so a quote in it cannot hide the next line's command", () => {
  const line = "ls # it's here\nrm -rf build # '"
  expect(split13(line).commands).toEqual(["ls", "rm -rf build"])
  expect(split13("ls -la # list").commands).toEqual(["ls -la"])
  expect(split13("echo a#b $#").commands).toEqual(["echo a#b $#"])
})
test("here-documents, $'…', ${…} and quoted strings across lines are not trusted", () => {
  expect(split13("cat <<EOF\nit's\nEOF").unsafe).toContain("here-document")
  expect(split13("cat <<< word").unsafe).not.toContain("here-document")
  expect(split13("echo $'a\\'b'").unsafe).toContain("$'…' quoting")
  expect(split13("ls ${HOME}").unsafe).toContain("parameter expansion")
  expect(split13("echo 'a\nb'").unsafe).toContain("a quoted string across lines")
})

// Audit, the second pass.
import { evaluate as ev13, DEFAULT_RULES as D13, toRules as tr13, realPath as rp13 } from "../src/permission/evaluate.ts"
describe("audit: reads the rules did not see", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ph-a13-")))
  writeFileSync(join(root, ".env"), "SECRET=1")
  writeFileSync(join(root, "a.txt"), "a")
  symlinkSync(join(root, ".env"), join(root, "notes.txt"))
  const ctx = { mode: "manual" as const, rules: tr13(D13, "default"), hardline: [], root }
  const bash = (command: string) => ev13({ permission: "bash", class: "execute", patterns: [command], command, paths: [root] }, ctx).action
  test("an input redirection reads its file: .env and outside the project ask", () => {
    expect(bash("cat < .env")).toBe("ask")
    expect(bash("cat <.env")).toBe("ask")
    expect(bash("cat 0< .env")).toBe("ask")
    expect(bash("cat < /etc/hostname")).toBe("ask")
    expect(bash("cat < a.txt")).toBe("allow")
  })
  test("a glob is judged by what it expands to", () => {
    expect(bash("cat .e*")).toBe("ask")
    expect(bash("cat a.*")).toBe("allow")
  })
  test("rg --files names a directory, not a pattern", () => {
    expect(bash("rg --files /etc")).toBe("ask")
  })
  test("read through a link to .env is judged as .env", () => {
    expect(ev13({ permission: "read", class: "read", patterns: ["notes.txt"], paths: [join(root, "notes.txt")] }, ctx).action).toBe("ask")
  })
  test("a link whose target does not exist yet is followed", () => {
    const away = mkdtempSync(join(tmpdir(), "ph-away-"))
    symlinkSync(join(away, "new.txt"), join(root, "dangling.txt"))
    expect(rp13(join(root, "dangling.txt"))).toBe(join(realpathSync(away), "new.txt"))
    const edit = { ...ctx, mode: "edit" as const }
    expect(ev13({ permission: "edit", class: "write", patterns: ["dangling.txt"], paths: [join(root, "dangling.txt")] }, edit).action).toBe("ask")
  })
})
