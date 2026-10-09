import { stat } from "node:fs/promises"
import { join, relative } from "node:path"
import { z } from "zod"
import { absPath, defineTool, showPath, ToolError, truncate, type ToolContext } from "./tool.ts"
import { described } from "../harness.ts"

const IGNORED = ["node_modules", ".git", "dist", "build", ".venv", "venv", "__pycache__", "target", ".next", ".cache"]
const hasRg = Bun.which("rg") !== null

async function run(cmd: string[], cwd: string, signal: AbortSignal): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", signal })
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  return { code, out, err }
}

/** Files under `dir`, honouring .gitignore when ripgrep is present. */
async function listFiles(dir: string, glob: string | undefined, ctx: ToolContext): Promise<string[]> {
  // Spawning in a directory that does not exist fails as "posix_spawn 'rg' ENOENT", which reads
  // as ripgrep missing.
  const st = await stat(dir).catch(() => undefined)
  if (!st) throw new ToolError(`${showPath(dir, ctx)} does not exist.`)
  if (!st.isDirectory()) throw new ToolError(`${showPath(dir, ctx)} is a file, not a directory.`)
  if (hasRg) {
    const args = ["rg", "--files", "--hidden", "--glob", "!.git"]
    if (glob) args.push("--glob", glob)
    const r = await run(args, dir, ctx.signal)
    if (r.code > 1) throw new ToolError(r.err.trim())
    return r.out.split("\n").filter(Boolean)
  }
  const out: string[] = []
  for await (const f of new Bun.Glob(glob ?? "**/*").scan({ cwd: dir, dot: true, onlyFiles: true })) {
    if (f.split("/").some((seg) => IGNORED.includes(seg))) continue
    out.push(f)
  }
  return out
}

export const globTool = defineTool({
  ...described("glob"),
  access: "glob",
  schema: z.object({
    pattern: z.string(),
    path: z.string().optional(),
  }),
  permission: (a, ctx) => {
    const abs = absPath(a.path ?? ".", ctx)
    return { permission: "glob", class: "read", patterns: [a.pattern], paths: [abs] }
  },
  async run(a, ctx) {
    const dir = absPath(a.path ?? ".", ctx)
    const files = await listFiles(dir, a.pattern, ctx)
    const withTime = await Promise.all(files.map(async (f) => ({ f, t: (await stat(join(dir, f)).catch(() => undefined))?.mtimeMs ?? 0 })))
    withTime.sort((x, y) => y.t - x.t)
    const shown = withTime.slice(0, 200).map((x) => showPath(join(dir, x.f), ctx))
    const more = files.length > 200 ? `\n(${files.length - 200} more — narrow the pattern)` : ""
    return { output: (shown.join("\n") || "No files found.") + more, title: `${a.pattern} · ${files.length} files`, meta: { hits: files.length } }
  },
})

export const grepTool = defineTool({
  ...described("grep"),
  access: "grep",
  schema: z.object({
    pattern: z.string(),
    path: z.string().optional(),
    include: z.string().optional(),
    ignore_case: z.boolean().optional(),
    literal: z.boolean().optional(),
  }),
  permission: (a, ctx) => {
    const abs = absPath(a.path ?? ".", ctx)
    return { permission: "grep", class: "read", patterns: [a.pattern], paths: [abs] }
  },
  async run(a, ctx) {
    const target = absPath(a.path ?? ".", ctx)
    const lines: string[] = []
    if (hasRg) {
      const args = ["rg", "--line-number", "--no-heading", "--color", "never", "--hidden", "--glob", "!.git", "--max-columns", "400", "--max-columns-preview"]
      if (a.ignore_case) args.push("-i")
      if (a.literal) args.push("-F")
      if (a.include) args.push("--glob", a.include)
      args.push("-e", a.pattern, target)
      const r = await run(args, ctx.cwd, ctx.signal)
      if (r.code > 1) throw new ToolError(r.err.trim() || `rg exited ${r.code}`)
      for (const l of r.out.split("\n")) if (l) lines.push(l.startsWith(target) ? showPath(target, ctx) + l.slice(target.length) : l)
    } else {
      let re: RegExp
      try {
        re = new RegExp(a.literal ? a.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : a.pattern, a.ignore_case ? "i" : "")
      } catch (e) {
        throw new ToolError(`invalid regex: ${(e as Error).message}`)
      }
      const st = await stat(target).catch(() => undefined)
      if (!st) throw new ToolError(`${a.path} does not exist`)
      const files = st.isDirectory() ? (await listFiles(target, a.include, ctx)).map((f) => join(target, f)) : [target]
      for (const f of files) {
        const text = await Bun.file(f).text().catch(() => "")
        if (text.includes("\0")) continue
        text.split("\n").forEach((l, i) => {
          if (re.test(l)) lines.push(`${showPath(f, ctx)}:${i + 1}:${l.slice(0, 400)}`)
        })
        if (lines.length > 1000) break
      }
    }
    const more = lines.length > 200 ? `\n(${lines.length - 200} more matches — narrow the search)` : ""
    // The commonest miss: searching for code text like `len(x)` as a regex, where ( ) are a group.
    const hint = !lines.length && !a.literal && /[()[\]{}.*+?|\\^$]/.test(a.pattern) ? " The pattern is a regular expression; to search for the text as written, set literal: true." : ""
    return { output: truncate(lines.slice(0, 200).join("\n") || "No matches." + hint) + more, title: `/${a.pattern}/ · ${lines.length} matches`, meta: { hits: lines.length } }
  },
})

export const listTool = defineTool({
  ...described("list"),
  access: "list",
  schema: z.object({
    path: z.string().optional(),
    depth: z.number().int().min(1).max(6).optional(),
  }),
  permission: (a, ctx) => {
    const abs = absPath(a.path ?? ".", ctx)
    return { permission: "list", class: "read", patterns: [showPath(abs, ctx)], paths: [abs] }
  },
  async run(a, ctx) {
    const dir = absPath(a.path ?? ".", ctx)
    const depth = a.depth ?? 2
    const files = await listFiles(dir, undefined, ctx)
    const tree = new Map<string, Set<string>>()
    for (const f of files) {
      const segs = f.split("/")
      for (let i = 0; i < Math.min(segs.length, depth); i++) {
        const parent = segs.slice(0, i).join("/")
        const name = segs[i]! + (i < segs.length - 1 ? "/" : "")
        if (!tree.has(parent)) tree.set(parent, new Set())
        tree.get(parent)!.add(name)
      }
    }
    const out: string[] = []
    const walk = (parent: string, indent: string) => {
      const kids = [...(tree.get(parent) ?? [])].sort((x, y) => Number(y.endsWith("/")) - Number(x.endsWith("/")) || x.localeCompare(y))
      for (const k of kids) {
        if (out.length >= 400) return
        out.push(indent + k)
        if (k.endsWith("/")) walk(parent ? `${parent}/${k.slice(0, -1)}` : k.slice(0, -1), indent + "  ")
      }
    }
    walk("", "")
    return { output: out.join("\n") || "(empty)", title: `${relative(ctx.root, dir) || "."}/ · ${files.length} files`, meta: { hits: files.length } }
  },
})
