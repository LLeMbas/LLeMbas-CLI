// Subagents: the built-in `explore` and `general`, and markdown files in
// ~/.config/lembas/agents/ and (trusted) .agent/agents/ — frontmatter description, model,
// mode, tools (a list of tool names); the body is the agent's instructions.
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"
import { parse } from "yaml"
import { paths } from "../config/paths.ts"
import { asMode, type Mode } from "../config/schema.ts"
import { canonicalToolNames } from "../tool/names.ts"
import { promptText } from "../prompt/assemble.ts"

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

/** Never given to a subagent: it cannot spawn more (so nothing to send to), and it has no user of
 *  its own to ask. */
export const NOT_FOR_SUBAGENTS = new Set(["task", "job_send", "ask_user", "plan_submit", "plan_write", "plan_update", "tasks", "decisions", "memory", "skill_manage", "settings", "note_manage"])

export const BUILTIN_AGENTS: AgentSpec[] = [
  {
    name: "explore",
    description: "read-only research: find where things are, how they work, what a change would touch",
    // The texts are the spec's (harness/prompts/agents), so LLeMbas's helper says the same words.
    instructions: promptText("agents/explore.md"),
    mode: "plan",
    tools: ["read", "glob", "grep", "list", "bash", "job_output", "job_list", "job_stop", "web_search", "web_fetch", "view_image"],
    source: "builtin",
  },
  {
    name: "general",
    description: "a self-contained piece of work with the full toolset, under the same permission mode",
    instructions: promptText("agents/general.md"),
    source: "builtin",
  },
]

function load(dir: string, source: AgentSpec["source"], warnings?: string[]): AgentSpec[] {
  if (!existsSync(dir)) return []
  const out: AgentSpec[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue
    const raw = readFileSync(join(dir, f), "utf8")
    const fm = /^---\n([\s\S]*?)\n---\n?/.exec(raw)
    let meta: Record<string, unknown> = {}
    try {
      meta = fm ? ((parse(fm[1]!) as Record<string, unknown>) ?? {}) : {}
    } catch (e) {
      // The agent is still offered, with its body: said, so a broken frontmatter is not a silent
      // loss of its model, mode or tools.
      warnings?.push(`agent ${join(dir, f)}: frontmatter not read (${(e as Error).message.split("\n")[0]}); its description, model, mode and tools are ignored`)
    }
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

/** `warnings`: where a file that could not be read whole is said (a notice at start). */
export function agents(projectDir: string | undefined, warnings?: string[]): AgentSpec[] {
  const byName = new Map<string, AgentSpec>()
  for (const a of [...BUILTIN_AGENTS, ...load(join(paths.config, "agents"), "global", warnings), ...(projectDir ? load(join(projectDir, "agents"), "project", warnings) : [])]) byName.set(a.name, a)
  return [...byName.values()]
}
