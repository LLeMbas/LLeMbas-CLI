// What is said about the MCP servers in words: the states, where a server comes from, and the
// plain list `/mcp` prints where there is no menu (`lembas run`, a prompt sent over the link —
// the web UI shows it as a reply). Lines of a list begin with "- ": they read as they are in a
// terminal and stay one to a line where the reply is drawn as markdown (indented lines would run
// together there). The TUI's menu (tui/mcpmenu.ts) reads the same words.
import { basename } from "node:path"
import type { McpManager, ServerState } from "./index.ts"
import { LIBRARY_SERVER, promptCommand } from "./index.ts"
import { clean, errorLine, mdEscape, redactUrl } from "./clean.ts"

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

/** One server's state in a line: `connected — 3 tools`, `failed: <why, one line>`. The reason is
 *  somebody else's text and may carry what the config resolved to: one line, cleaned, with what
 *  looks like a secret taken out (clean.ts). */
export function stateLine(s: ServerState): string {
  if (s.status === "connected") return `${STATE_WORDS.connected} — ${offers(s)}`
  if (s.status === "failed") return `${STATE_WORDS.failed}: ${errorLine(s.error) || "no reason given"}`
  if (s.status === "needs_auth") return `${STATE_WORDS.needs_auth} — /mcp auth ${clean(s.name)}`
  return STATE_WORDS[s.status]
}

/** Where a server is reached, without what the config may hold that is secret: an address with
 *  no user, password or query; for a local server the program's name alone — its arguments and
 *  environment are where tokens are put. */
export function whereOf(s: Pick<ServerState, "cfg">): string {
  if (s.cfg.command === undefined) return redactUrl(s.cfg.url ?? "")
  const program = Array.isArray(s.cfg.command) ? s.cfg.command[0]! : s.cfg.command.trim().split(/\s+/)[0]!
  return `local: ${clean(basename(program))}`
}

/** The servers as a plain list, or one server with its tools and prompts (`name` given) — what
 *  `/mcp` says where there is no menu. It may leave this machine (a reply in the web UI), so an
 *  error is its first line only, and never what a local server wrote to stderr. `rule`: what the
 *  permission rules say of a tool by its name here. `markdown`: the text will be drawn as
 *  markdown, so names are code and a server's descriptions are escaped — a description cannot
 *  put a link or an image into the chat. */
export function mcpText(mcp: McpManager, name = "", rule: (tool: string) => string | undefined = () => undefined, o: { markdown?: boolean } = {}): string {
  const said = (text: string) => (o.markdown ? mdEscape(text) : text)
  const code = (text: string) => (o.markdown ? `\`${text.replace(/`/g, "'")}\`` : text)
  const servers = [...mcp.servers.values()]
  if (!servers.length) return "No MCP servers are configured. Add one under mcp: in ~/.config/lembas/config.yaml (or this project's .agent/config.yaml)."
  if (name) {
    const s = mcp.servers.get(name)
    if (!s) return `No MCP server "${clean(name)}" — the servers: ${servers.map((x) => clean(x.name)).join(", ")}.`
    const lines = [`${said(clean(s.name))} — ${said(stateLine(s))}`, "", `From ${SOURCE_WORDS[sourceOf(s)]} · ${said(whereOf(s))}`]
    if (s.status === "connected") {
      if (s.tools.length) lines.push("", "Tools:")
      for (const t of s.tools) {
        const called = mcp.nameOf(s.name, t.name)
        const does = { allow: "always allowed", deny: "denied", ask: "asks" }[rule(called) ?? "ask"] ?? "asks"
        const about = clean((t.description ?? "").split("\n")[0])
        lines.push(`- ${code(clean(called))} — ${does}${t.annotations?.readOnlyHint ? ", read-only" : ""}${about ? ` — ${said(about)}` : ""}`)
      }
      if (s.prompts.length)
        lines.push(
          "",
          "Prompts:",
          ...s.prompts.map((p) => {
            const about = clean((p.description ?? "").split("\n")[0])
            return `- ${code(`/${promptCommand(s.name, p.name)}`)}${about ? ` — ${said(about)}` : ""}`
          }),
        )
    }
    return lines.join("\n")
  }
  return [
    "MCP servers:",
    ...servers.map((s) => `- ${said(clean(s.name))} — ${said(stateLine(s))} (${SOURCE_WORDS[sourceOf(s)]})`),
    "",
    "/mcp <name> lists one server's tools. A tool asks before it runs unless a permission rule allows it.",
  ].join("\n")
}
