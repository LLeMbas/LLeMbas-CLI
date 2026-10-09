// Custom slash commands: markdown files in ~/.config/lembas/commands/ and (in a trusted
// project) .agent/commands/. The file name is the command; YAML frontmatter may give a
// description, a model and a mode; the body is the prompt. In the body:
//   $ARGUMENTS   everything after the command     $1 … $9   the arguments one by one
//   !`command`   replaced by that command's output (run in the project, the hardline applies)
//   @path        attached like any @reference
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"
import { parse } from "yaml"
import { paths } from "../config/paths.ts"
import { hardlineCommand, type HardlineRule } from "../permission/hardline.ts"
import { words } from "../permission/bash.ts"

export interface CustomCommand {
  name: string
  description: string
  model?: string
  mode?: string
  body: string
  source: "global" | "project"
  file: string
}

function load(dir: string, source: CustomCommand["source"]): CustomCommand[] {
  if (!existsSync(dir)) return []
  const out: CustomCommand[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue
    const file = join(dir, f)
    const raw = readFileSync(file, "utf8")
    const fm = /^---\n([\s\S]*?)\n---\n?/.exec(raw)
    let meta: Record<string, unknown> = {}
    try {
      meta = fm ? ((parse(fm[1]!) as Record<string, unknown>) ?? {}) : {}
    } catch {}
    const body = fm ? raw.slice(fm[0].length) : raw
    out.push({
      name: basename(f, ".md").toLowerCase().replace(/[^a-z0-9_-]/g, "-"),
      description: String(meta.description ?? body.trim().split("\n")[0]!.slice(0, 60)),
      model: typeof meta.model === "string" ? meta.model : undefined,
      mode: typeof meta.mode === "string" ? meta.mode : undefined,
      body,
      source,
      file,
    })
  }
  return out
}

/** Global commands, then the project's (a project command overrides a global one of that name). */
export function customCommands(projectDir: string | undefined): CustomCommand[] {
  const byName = new Map<string, CustomCommand>()
  for (const c of load(join(paths.config, "commands"), "global")) byName.set(c.name, c)
  if (projectDir) for (const c of load(join(projectDir, "commands"), "project")) byName.set(c.name, c)
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** The prompt a command sends. */
export function expandCommand(cmd: CustomCommand, args: string, root: string, hardline: HardlineRule[]): string {
  const list = words(args)
  let text = cmd.body.replaceAll("$ARGUMENTS", args).replace(/\$(\d)/g, (_, n: string) => list[Number(n) - 1] ?? "")
  text = text.replace(/!`([^`]+)`/g, (_, command: string) => {
    const hit = hardlineCommand(command, hardline)
    if (hit) return `[not run — ${hit.description}]`
    const r = Bun.spawnSync(["bash", "-c", command], { cwd: root, stdout: "pipe", stderr: "pipe" })
    return (r.stdout.toString() + r.stderr.toString()).trim()
  })
  return text.trim()
}
