// Subagents: the built-in `explore` and `general`, and markdown files in
// ~/.config/lembas/agents/ and (trusted) .agent/agents/ — frontmatter description, model,
// mode, tools (a list of tool names); the body is the agent's instructions.
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"
import { parse } from "yaml"
import { paths } from "../config/paths.ts"
import { asMode, type Mode } from "../config/schema.ts"
import { canonicalToolNames } from "../tool/names.ts"

export interface AgentSpec {
  name: string
  description: string
  instructions: string
  model?: string
  /** A fixed permission mode; absent = the parent's. */
  mode?: Mode
  /** Tool names; absent = everything a subagent may have. */
  tools?: string[]
  /** `worktree`: always work in a checkout and branch of its own. */
  isolation?: "worktree"
  source: "builtin" | "global" | "project"
}

/** Never given to a subagent: it cannot spawn more, and it has no user of its own to ask. */
export const NOT_FOR_SUBAGENTS = new Set(["task", "ask_user", "plan_submit", "todo", "tasks", "decisions", "memory", "skill_manage", "settings", "note_manage"])

export const BUILTIN_AGENTS: AgentSpec[] = [
  {
    name: "explore",
    description: "read-only research: find where things are, how they work, what a change would touch",
    instructions:
      "You can read, search and fetch, but not change anything. Look widely — several searches in one step when they are independent — then report what you found, not what you did: the answer first, then the evidence as file:line references.",
    mode: "plan",
    tools: ["read", "glob", "grep", "list", "bash", "web_search", "web_fetch", "view_image"],
    source: "builtin",
  },
  {
    name: "general",
    description: "a self-contained piece of work with the full toolset, under the same permission mode",
    instructions: "Do the task completely, check it, and report what you changed and how you verified it.",
    source: "builtin",
  },
]

function load(dir: string, source: AgentSpec["source"]): AgentSpec[] {
  if (!existsSync(dir)) return []
  const out: AgentSpec[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue
    const raw = readFileSync(join(dir, f), "utf8")
    const fm = /^---\n([\s\S]*?)\n---\n?/.exec(raw)
    let meta: Record<string, unknown> = {}
    try {
      meta = fm ? ((parse(fm[1]!) as Record<string, unknown>) ?? {}) : {}
    } catch {}
    const body = (fm ? raw.slice(fm[0].length) : raw).trim()
    out.push({
      name: basename(f, ".md").toLowerCase().replace(/[^a-z0-9_-]/g, "-"),
      description: String(meta.description ?? body.split("\n")[0]!.slice(0, 80)),
      instructions: body,
      model: typeof meta.model === "string" ? meta.model : undefined,
      mode: asMode(meta.mode),
      tools: Array.isArray(meta.tools) ? canonicalToolNames(meta.tools.map(String)) : undefined,
      isolation: meta.isolation === "worktree" ? "worktree" : undefined,
      source,
    })
  }
  return out
}

export function agents(projectDir: string | undefined): AgentSpec[] {
  const byName = new Map<string, AgentSpec>()
  for (const a of [...BUILTIN_AGENTS, ...load(join(paths.config, "agents"), "global"), ...(projectDir ? load(join(projectDir, "agents"), "project") : [])]) byName.set(a.name, a)
  return [...byName.values()]
}
