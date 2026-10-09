// `lembas uninstall`: what install.sh --uninstall does, from the binary itself. It says what
// it will remove and asks. The binary, the one an update kept, the editor schemas and the block
// in the shell's rc files go; settings, sessions and memory stay for a later reinstall, unless
// --purge. A project's own .agent/ is never touched. The service goes first.
import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { paths } from "./config/paths.ts"
import { installedUnits, removeUnits, type Systemctl } from "./service.ts"
import { installedBinary } from "./update/index.ts"

/** Our block's markers (install.sh writes them). */
const BLOCKS: [string, string][] = [["# >>> lembas >>>", "# <<< lembas <<<"]]

/** Whether a file's text has every block it starts whole: a start line, then its end line. */
export function wholeBlock(text: string): boolean {
  const lines = text.split("\n")
  return BLOCKS.every(([begin, end]) => {
    const b = lines.indexOf(begin)
    return b < 0 || lines.indexOf(end, b + 1) > b
  })
}

/** The rc files with a block in them; `broken`: a start without its end, left alone (stripping
 *  it would take everything after the start with it). */
export function rcFiles(home = homedir()): { whole: string[]; broken: string[] } {
  const all = [join(home, ".bashrc"), join(process.env.ZDOTDIR || home, ".zshrc")].filter((f) => existsSync(f) && BLOCKS.some(([begin]) => readFileSync(f, "utf8").split("\n").includes(begin)))
  return { whole: all.filter((f) => wholeBlock(readFileSync(f, "utf8"))), broken: all.filter((f) => !wholeBlock(readFileSync(f, "utf8"))) }
}

/** The file without our blocks, everything else byte for byte (install.sh's strip_block). */
export function stripBlock(text: string): string {
  const out: string[] = []
  let end: string | undefined
  const lines = text.split("\n")
  for (const [i, line] of lines.entries()) {
    const opens = BLOCKS.find(([begin]) => begin === line)
    if (!end && opens) end = opens[1]
    else if (end && line === end) end = undefined
    else if (!end && !(i === lines.length - 1 && line === "")) out.push(line)
  }
  return out.length ? `${out.join("\n")}\n` : ""
}

/** There, or a link (a dangling one included). */
const present = (f: string) => {
  try {
    lstatSync(f)
    return true
  } catch {
    return false
  }
}

export interface Plan {
  /** The systemd user unit (lembas.service): stopped and disabled, then removed. */
  units: string[]
  remove: string[]
  rc: string[]
  /** rc files whose block has lost its end marker: not touched. */
  brokenRc: string[]
  kept: string[]
}

export function plan(o: { purge?: boolean; binary?: string; home?: string } = {}): Plan {
  const bin = o.binary ?? installedBinary() ?? join(o.home ?? homedir(), ".local/bin/lembas")
  // `lembas` beside it too, when the binary itself goes by another name.
  const named = (n: string) => join(dirname(bin), n)
  const remove = [...new Set([bin, `${bin}.prev`, named("lembas"), `${named("lembas")}.prev`, join(paths.config, "schema")])].filter(present)
  const dirs = [paths.config, paths.data, paths.state].filter((d) => existsSync(d))
  const rc = rcFiles(o.home)
  return { units: installedUnits(), remove: o.purge ? [...remove.filter((f) => !f.startsWith(paths.config)), ...dirs] : remove, rc: rc.whole, brokenRc: rc.broken, kept: o.purge ? [] : dirs }
}

export function apply(p: Plan, systemctl?: Systemctl) {
  // The service first: with its binary gone, a unit left running restart-loops (203/EXEC).
  if (p.units.length) removeUnits(systemctl)
  for (const f of p.rc) writeFileSync(f, stripBlock(readFileSync(f, "utf8")))
  for (const f of p.remove) rmSync(f, { recursive: true, force: true })
}

export async function uninstall(o: { purge?: boolean; yes?: boolean }): Promise<number> {
  const p = plan(o)
  if (!p.units.length && !p.remove.length && !p.rc.length && !p.brokenRc.length) {
    console.log("Nothing of LLeMbas CLI's to remove here.")
    return 0
  }
  console.log("This removes:")
  for (const f of p.units) console.log(`  ${f} (the service: stopped and disabled first)`)
  for (const f of p.remove) console.log(`  ${f}`)
  for (const f of p.rc) console.log(`  the LLeMbas CLI block in ${f}`)
  for (const f of p.brokenRc) console.log(`(${f} has the start of the LLeMbas CLI block but not its end — left as it is; remove it by hand)`)
  if (p.kept.length) {
    console.log("and keeps your settings, sessions and memory (--purge removes them too):")
    for (const d of p.kept) console.log(`  ${d}`)
  }
  if (!o.yes) {
    if (!process.stdin.isTTY) {
      console.log("Nothing removed: run it in a terminal to answer, or add --yes.")
      return 1
    }
    process.stdout.write("Uninstall? [y/N] ")
    const answer = await new Promise<string>((resolve) => process.stdin.once("data", (d) => resolve(d.toString().trim())))
    process.stdin.pause()
    if (!/^y/i.test(answer)) {
      console.log("Nothing removed.")
      return 1
    }
  }
  apply(p)
  console.log("LLeMbas CLI is uninstalled. A project's own .agent/ directory is left as it is.")
  return 0
}
