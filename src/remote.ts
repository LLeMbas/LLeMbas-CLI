// `lembas remote`: the global `remote:` block — what a LLeMbas instance may ask of this machine over
// the link — managed without editing YAML, for people and for programs (LLeMbas Desktop) alike.
//
//   lembas remote list [--json]                    what is in force, defaults applied
//   lembas remote add <dir>… [--json]              allow remote sessions there (turns remote work on)
//   lembas remote remove <dir>… [--json]           stop allowing them there
//   lembas remote enable | disable [--json]        remote.enabled
//   lembas remote mode <manual|edit|auto|plan>     remote.max_mode
//   lembas remote terminal <on|off>                remote.terminal
//
// Every change goes through the global config writer, which keeps the file's comments. A running
// `lembas service` reads the block again whenever it uses it, so a change applies to it within a few
// seconds, no restart (acp/link.ts). --json prints one object: {enabled, roots, max_mode, terminal}.
import { resolve } from "node:path"
import { ConfigError } from "./config/load.ts"
import { expandHome } from "./config/paths.ts"
import { coveredBy, realOrResolved, remoteBlock, remoteState, rootFor, type RemoteState } from "./config/remote.ts"
import { MODES, type Mode } from "./config/schema.ts"
import { updateGlobalConfig } from "./config/write.ts"

export const REMOTE_USAGE = `usage: lembas remote list | add <dir>… | remove <dir>… | enable | disable | mode <${MODES.join("|")}> | terminal <on|off>  [--json]`

export interface Io {
  out: (line: string) => void
  err: (line: string) => void
  cwd?: string
}

const stdio: Io = { out: (l) => console.log(l), err: (l) => process.stderr.write(`lembas: ${l}\n`) }

function describe(s: RemoteState): string[] {
  return [
    `remote work: ${s.enabled ? "on" : "off"}`,
    s.roots.length ? `roots:\n${s.roots.map((r) => `  ${r}`).join("\n")}` : "roots: (none: no directory accepts remote work)",
    `max mode: ${s.max_mode}`,
    `terminal: ${s.terminal ? "on" : "off"}`,
  ]
}

/** Runs one `lembas remote …` command; the exit status. */
export function remoteCommand(argv: string[], io: Io = stdio): number {
  const json = argv.includes("--json")
  const args = argv.filter((a) => a !== "--json")
  const [sub = "list", ...rest] = args
  const said: string[] = []
  let wrote = false
  const show = () => {
    const s = remoteState(remoteBlock())
    if (json) io.out(JSON.stringify(s))
    else for (const l of [...said, ...describe(s), ...(wrote ? ["(a running lembas service applies this within seconds)"] : [])]) io.out(l)
    return 0
  }
  let block
  try {
    block = remoteBlock({ strict: true })
  } catch (e) {
    if (e instanceof ConfigError) return io.err(e.message), 1
    throw e
  }
  const write = (edits: [string[], unknown][]) => {
    updateGlobalConfig(edits.map(([k, v]) => [["remote", ...k], v]))
    wrote = true
  }

  if (sub === "list") {
    if (rest.length) return io.err(REMOTE_USAGE), 2
    return show()
  }

  if (sub === "add") {
    if (!rest.length) return io.err("usage: lembas remote add <dir>…"), 2
    const roots = [...(block.roots ?? [])]
    const added: string[] = []
    const bad: string[] = []
    for (const dir of rest) {
      const r = rootFor(dir, io.cwd)
      if (typeof r !== "string") {
        bad.push(r.error)
        continue
      }
      const by = coveredBy(r, roots)
      if (by) {
        said.push(realOrResolved(by) === r ? `${r}: already a root` : `${r}: already covered by ${by}`)
        continue
      }
      roots.push(r)
      added.push(r)
    }
    // All or nothing: a program that asked for three directories never gets two of them.
    if (bad.length) {
      for (const b of bad) io.err(b)
      return 1
    }
    const edits: [string[], unknown][] = []
    if (added.length) {
      edits.push([["roots"], roots])
      for (const r of added) said.push(`added ${r}`)
    }
    if (block.enabled !== true) {
      edits.push([["enabled"], true])
      said.push("remote work is now on (remote.enabled)")
    }
    if (edits.length) write(edits)
    return show()
  }

  if (sub === "remove") {
    if (!rest.length) return io.err("usage: lembas remote remove <dir>…"), 2
    const roots = block.roots ?? []
    const gone = new Set<string>()
    const bad: string[] = []
    for (const dir of rest) {
      const want = realOrResolved(resolve(io.cwd ?? process.cwd(), expandHome(dir)))
      const match = roots.filter((r) => realOrResolved(r) === want)
      if (!match.length) bad.push(`${dir}: not one of the remote roots${roots.length ? ` (${roots.join(", ")})` : ""}`)
      for (const m of match) gone.add(m)
    }
    if (bad.length) {
      for (const b of bad) io.err(b)
      return 1
    }
    write([[["roots"], roots.filter((r) => !gone.has(r))]])
    for (const r of gone) said.push(`removed ${r}`)
    if (gone.size === roots.length && block.enabled === true) said.push("no roots are left: remote sessions cannot be opened anywhere until one is added")
    return show()
  }

  if (sub === "enable" || sub === "disable") {
    if (rest.length) return io.err(REMOTE_USAGE), 2
    write([[["enabled"], sub === "enable"]])
    if (sub === "enable" && !(block.roots ?? []).length) said.push("no roots yet: lembas remote add <dir> to say where remote sessions may work")
    return show()
  }

  if (sub === "mode") {
    const m = rest[0] as Mode | undefined
    if (rest.length !== 1 || !(MODES as readonly string[]).includes(m!)) return io.err(`usage: lembas remote mode <${MODES.join("|")}>`), 2
    write([[["max_mode"], m]])
    return show()
  }

  if (sub === "terminal") {
    const v = rest[0]
    if (rest.length !== 1 || (v !== "on" && v !== "off")) return io.err("usage: lembas remote terminal <on|off>"), 2
    write([[["terminal"], v === "on"]])
    return show()
  }

  io.err(REMOTE_USAGE)
  return 2
}
