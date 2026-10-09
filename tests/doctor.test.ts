// The `lembas` first on PATH is not this one: the LLeMbas server's console script, which
// was also called `lembas`, shadows the CLI when its directory comes first. `lembas config check`
// says so (src/doctor.ts); install.sh says so when it installs (install.test.ts).
import { expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { firstOnPath, isPythonScript, lembasShadowed } from "../src/doctor.ts"

function bin(dir: string, name: string, text: string) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), text)
  chmodSync(join(dir, name), 0o755)
  return join(dir, name)
}

test("a Python `lembas` first on PATH is named, with the fix", () => {
  const root = mkdtempSync(join(tmpdir(), "ph-doctor-"))
  const venv = join(root, "venv/bin")
  const ours = join(root, "local/bin")
  const server = bin(venv, "lembas", "#!/srv/venv/bin/python3\n# -*- coding: utf-8 -*-\nfrom lembas.cli import main\n")
  const self = bin(ours, "lembas", "\x7fELF")
  const path = `${venv}:${ours}`
  expect(firstOnPath("lembas", path)).toBe(server)
  expect(isPythonScript(server)).toBe(true)
  expect(isPythonScript(self)).toBe(false)
  const said = lembasShadowed({ path, self })
  expect(said).toContain(server)
  expect(said).toContain("Python console script")
  expect(said).toContain(`Put ${ours} before ${venv}`)
  expect(said).toContain("lembas-server")
  // Ours first: nothing to say. A link to ours is ours.
  expect(lembasShadowed({ path: `${ours}:${venv}`, self })).toBeUndefined()
  const linked = join(root, "links")
  mkdirSync(linked)
  symlinkSync(self, join(linked, "lembas"))
  expect(lembasShadowed({ path: `${linked}:${venv}`, self })).toBeUndefined()
  // Run from source (no binary of ours to compare): only a Python script is recognised.
  expect(lembasShadowed({ path, self: undefined })).toContain("Python console script")
  const other = join(root, "other")
  bin(other, "lembas", "#!/bin/sh\necho hi\n")
  expect(lembasShadowed({ path: `${other}:${ours}`, self: undefined })).toBeUndefined()
  expect(lembasShadowed({ path: `${other}:${ours}`, self })).toContain("another program")
  // Nothing called lembas at all: nothing to say.
  expect(lembasShadowed({ path: join(root, "empty"), self })).toBeUndefined()
})
