import { expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const script = resolve(import.meta.dir, "../install.sh")

// A stand-in binary: install.sh only needs something that answers --version.
function fakeBinary(dir: string) {
  const bin = join(dir, "lembas-fake")
  writeFileSync(bin, "#!/bin/sh\necho 9.9.9\n")
  chmodSync(bin, 0o755)
  return bin
}

function run(home: string, args: string[], env: Record<string, string> = {}) {
  const r = Bun.spawnSync(["bash", script, ...args], {
    env: { PATH: "/usr/bin:/bin", HOME: home, SHELL: "/bin/bash", ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
}

test("installs, writes one block into both rc files, idempotently; uninstall removes it", () => {
  const home = mkdtempSync(join(tmpdir(), "ph-install-"))
  writeFileSync(join(home, ".bashrc"), "# mine\nexport FOO=1")
  writeFileSync(join(home, ".zshrc"), "# zsh mine\n")
  const bin = fakeBinary(home)
  const first = run(home, ["--binary", bin, "--aliases"])
  expect(first.code).toBe(0)
  expect(existsSync(join(home, ".local/bin/lembas"))).toBe(true)
  run(home, ["--binary", bin, "--aliases"])
  for (const rc of [".bashrc", ".zshrc"]) {
    const text = readFileSync(join(home, rc), "utf8")
    expect(text.split("# >>> lembas >>>").length).toBe(2)
    expect(text).toContain("alias agent='lembas'")
    expect(text).toContain('export PATH="$HOME/.local/bin:$PATH"')
  }
  expect(readFileSync(join(home, ".bashrc"), "utf8").startsWith("# mine\nexport FOO=1\n")).toBe(true)

  // Nobody to ask and no --yes: it says what it would remove, and removes nothing.
  const asked = run(home, ["--uninstall"])
  expect(asked.code).toBe(1)
  expect(asked.out).toContain("This removes:")
  expect(existsSync(join(home, ".local/bin/lembas"))).toBe(true)

  const rm = run(home, ["--uninstall", "--yes"])
  expect(rm.code).toBe(0)
  expect(readFileSync(join(home, ".bashrc"), "utf8")).toBe("# mine\nexport FOO=1\n")
  expect(readFileSync(join(home, ".zshrc"), "utf8")).toBe("# zsh mine\n")
  expect(existsSync(join(home, ".local/bin/lembas"))).toBe(false)
  // Settings stay for a later reinstall; the schemas follow the binary out.
  expect(existsSync(join(home, ".config/lembas/config.yaml"))).toBe(true)
  expect(existsSync(join(home, ".config/lembas/schema"))).toBe(false)
}, 40_000) // four runs of install.sh: fast alone, but the suite shares two cores

test("--uninstall --purge also removes settings, sessions and state; a project's .agent stays", () => {
  const home = mkdtempSync(join(tmpdir(), "ph-install-"))
  writeFileSync(join(home, ".bashrc"), "")
  run(home, ["--binary", fakeBinary(home), "--no-aliases"])
  for (const d of [".local/share/lembas", ".local/state/lembas", "work/.agent"]) mkdirSync(join(home, d), { recursive: true })
  writeFileSync(join(home, ".local/bin/lembas.prev"), "old")
  const r = run(home, ["--uninstall", "--purge", "--yes"])
  expect(r.code).toBe(0)
  for (const gone of [".config/lembas", ".local/share/lembas", ".local/state/lembas", ".local/bin/lembas", ".local/bin/lembas.prev"]) expect(existsSync(join(home, gone))).toBe(false)
  expect(existsSync(join(home, "work/.agent"))).toBe(true)
}, 30_000)

test("an alias name already in use is not taken; --no-aliases adds none", () => {
  const home = mkdtempSync(join(tmpdir(), "ph-install-"))
  writeFileSync(join(home, ".bashrc"), "alias agent='cd ~/work'\n")
  const bin = fakeBinary(home)
  const r = run(home, ["--binary", bin, "--aliases"])
  expect(r.out).toContain("'agent' is already a command or alias")
  const text = readFileSync(join(home, ".bashrc"), "utf8")
  expect(text).not.toContain("alias agent='lembas'")

  const home2 = mkdtempSync(join(tmpdir(), "ph-install-"))
  writeFileSync(join(home2, ".bashrc"), "")
  run(home2, ["--binary", fakeBinary(home2), "--no-aliases"])
  expect(readFileSync(join(home2, ".bashrc"), "utf8")).not.toContain("alias")
})

test("no rc file at all: the one for $SHELL is created; ZDOTDIR is honoured", () => {
  const home = mkdtempSync(join(tmpdir(), "ph-install-"))
  const zdot = join(home, "zdot")
  mkdirSync(zdot)
  run(home, ["--binary", fakeBinary(home), "--no-aliases"], { SHELL: "/usr/bin/zsh", ZDOTDIR: zdot })
  expect(existsSync(join(zdot, ".zshrc"))).toBe(true)
  expect(existsSync(join(home, ".bashrc"))).toBe(false)
})

test("--uninstall stops, disables and removes the service unit first", () => {
  const home = mkdtempSync(join(tmpdir(), "ph-install-"))
  writeFileSync(join(home, ".bashrc"), "")
  run(home, ["--binary", fakeBinary(home), "--no-aliases"])
  const units = join(home, ".config/systemd/user")
  mkdirSync(units, { recursive: true })
  writeFileSync(join(units, "lembas.service"), "[Service]\n")
  // A systemctl that writes down what it was asked, and whether the binary was still there.
  const tools = join(home, "tools")
  mkdirSync(tools)
  const log = join(home, "systemctl.log")
  writeFileSync(join(tools, "systemctl"), `#!/bin/sh\necho "$* $([ -e "$HOME/.local/bin/lembas" ] && echo bin-there)" >>"${log}"\n`)
  chmodSync(join(tools, "systemctl"), 0o755)
  const r = run(home, ["--uninstall", "--yes"], { PATH: `${tools}:/usr/bin:/bin` })
  expect(r.code).toBe(0)
  expect(r.out).toContain("lembas.service (stopped and disabled first)")
  expect(readFileSync(log, "utf8")).toBe("--user disable --now lembas.service bin-there\n--user daemon-reload bin-there\n")
  expect(existsSync(join(units, "lembas.service"))).toBe(false)
  expect(existsSync(join(home, ".local/bin/lembas"))).toBe(false)
}, 30_000)

test("a `lembas` of the LLeMbas server first on PATH is warned about, with the fix", () => {
  const home = mkdtempSync(join(tmpdir(), "ph-install-"))
  writeFileSync(join(home, ".bashrc"), "")
  const venv = join(home, "venv/bin")
  mkdirSync(venv, { recursive: true })
  writeFileSync(join(venv, "lembas"), "#!/home/u/venv/bin/python3\nfrom lembas.cli import main\n")
  chmodSync(join(venv, "lembas"), 0o755)
  // ~/.local/bin already on PATH, after the venv: the rc block adds nothing, and the venv wins.
  const shadowed = run(home, ["--binary", fakeBinary(home), "--no-aliases"], { PATH: `${venv}:${join(home, ".local/bin")}:/usr/bin:/bin` })
  expect(shadowed.code).toBe(0)
  expect(shadowed.out).toContain(`${join(venv, "lembas")} comes before`)
  expect(shadowed.out).toContain("Python console script")
  expect(shadowed.out).toContain(`put ${join(home, ".local/bin")} before ${venv}`)
  // Not on PATH yet: the rc block puts ~/.local/bin first, so nothing shadows it.
  const fine = run(home, ["--binary", fakeBinary(home), "--no-aliases"], { PATH: `${venv}:/usr/bin:/bin` })
  expect(fine.out).not.toContain("comes before")
}, 30_000)
