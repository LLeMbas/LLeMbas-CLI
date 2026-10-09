import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Every test run gets its own config/data/state root, so nothing touches ~/.config/lembas.
process.env.LEMBAS_HOME = mkdtempSync(join(tmpdir(), "lembas-test-"))
// And its own XDG_CONFIG_HOME, which only the systemd unit's directory is taken from: `lembas
// uninstall` stops and removes the units it finds there, and a test must never find the real ones.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "lembas-test-xdg-"))
