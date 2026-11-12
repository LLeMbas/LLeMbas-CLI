// What is said about the MCP servers in words: the states, where a server comes from, and the
// plain list `/mcp` prints where there is no menu (`lembas run`, a prompt sent over the link —
// the web UI shows it as a reply). Lines of a list begin with "- ": they read as they are in a
// terminal and stay one to a line where the reply is drawn as markdown (indented lines would run
// together there). The TUI's menu (tui/mcpmenu.ts) reads the same words.
import type { McpManager, ServerState } from "./index.ts"
import { LIBRARY_SERVER } from "./index.ts"

export const STATE_WORDS: Record<ServerState["status"], string> = {
  connected: "connected",
  connecting: "connecting",
  failed: "failed",
  needs_auth: "needs sign-in",
  disabled: "switched off",
}

/** Where a server is configured: the LLeMbas server's own library (it comes with the login), the
 *  project's .agent/config.yaml, or the person's own config. */
export function sourceOf(s: Pick<ServerState, "name" | "cfg">): "library" | "project" | "user" {
  return s.name === LIBRARY_SERVER ? "library" : s.cfg.source === "project" ? "project" : "user"
}

export const SOURCE_WORDS = { library: "the LLeMbas server's library", project: "this project", user: "your config" } as const

/** `3 tools, 1 prompt, resources` — what a connected server offers. */
export function offers(s: Pick<ServerState, "tools" | "prompts" | "resources">): string {
  const n = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`
  return [n(s.tools.length, "tool"), ...(s.prompts.length ? [n(s.prompts.length, "prompt")] : []), ...(s.resources ? ["resources"] : [])].join(", ")
}

/** One server's state in a line: `connected — 3 tools`, `failed: <why, one line>`. */
export function stateLine(s: ServerState): string {
  if (s.status === "connected") return `${STATE_WORDS.connected} — ${offers(s)}`
  if (s.status === "failed") return `${STATE_WORDS.failed}: ${(s.error ?? "no reason given").split("\n")[0]}`
  if (s.status === "needs_auth") return `${STATE_WORDS.needs_auth} — /mcp auth ${s.name}`
  return STATE_WORDS[s.status]
}

/** Where a server is reached: its address, or `local` and the program it runs. */
export function whereOf(s: Pick<ServerState, "cfg">): string {
  return s.cfg.command !== undefined ? `local: ${(Array.isArray(s.cfg.command) ? s.cfg.command : [s.cfg.command]).join(" ")}` : (s.cfg.url ?? "")
}

/** The servers as a plain table, or one server with its tools and prompts (`name` given). `rule`:
 *  what the permission rules say of a tool by its name here (allow, ask, deny), where they speak. */
export function mcpText(mcp: McpManager, name = "", rule: (tool: string) => string | undefined = () => undefined): string {
  const servers = [...mcp.servers.values()]
  if (!servers.length) return "No MCP servers are configured. Add one under mcp: in ~/.config/lembas/config.yaml (or this project's .agent/config.yaml)."
  if (name) {
    const s = mcp.servers.get(name)
    if (!s) return `No MCP server "${name}" — the servers: ${servers.map((x) => x.name).join(", ")}.`
    const lines = [`${s.name} — ${stateLine(s)}`, "", `From ${SOURCE_WORDS[sourceOf(s)]} · ${whereOf(s)}`]
    if (s.error && s.error.includes("\n")) lines.push("", "The error in full:", "", ...s.error.split("\n").map((l) => `    ${l}`))
    if (s.status === "connected") {
      if (s.tools.length) lines.push("", "Tools:")
      for (const t of s.tools) {
        const called = mcp.nameOf(s.name, t.name)
        const said = { allow: "always allowed", deny: "denied", ask: "asks" }[rule(called) ?? "ask"] ?? "asks"
        lines.push(`- ${called} — ${said}${t.annotations?.readOnlyHint ? ", read-only" : ""}${t.description ? ` — ${t.description.trim().split("\n")[0]}` : ""}`)
      }
      if (s.prompts.length) lines.push("", "Prompts:", ...s.prompts.map((p) => `- /${s.name}:${p.name}${p.description ? ` — ${p.description.split("\n")[0]}` : ""}`))
    }
    return lines.join("\n")
  }
  return [
    "MCP servers:",
    ...servers.map((s) => `- ${s.name} — ${stateLine(s)} (${SOURCE_WORDS[sourceOf(s)]})`),
    "",
    "/mcp <name> lists one server's tools. A tool asks before it runs unless a permission rule allows it.",
  ].join("\n")
}
