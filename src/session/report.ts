// What two of the menus say as plain text, where there is no menu (`lembas run`, a prompt over
// the link): the permission rules in force, and the state of this installation in one place.
import type { App } from "../app.ts"
import type { Rule } from "../permission/evaluate.ts"
import { VERSION } from "../version.ts"
import { sourceOf, stateLine } from "../mcp/text.ts"

export type RuleFrom = "session" | "project" | "user" | "builtin"

export const RULE_FROM: Record<RuleFrom, string> = { session: "This session", project: "This project (.agent/config.yaml)", user: "Your config", builtin: "Built in" }

/** Where a rule was made. */
export function ruleFrom(rule: Rule, own: readonly Rule[]): RuleFrom {
  if (own.includes(rule)) return "session"
  return rule.source === "project" ? "project" : rule.source === "global" ? "user" : "builtin"
}

/** Every rule in force, the most specific place first: this session's, the project's, the
 *  person's own, the built-in ones. A later rule of the same permission and pattern wins, so only
 *  the one that speaks is listed. */
export function rulesInForce(app: App): { rule: Rule; from: RuleFrom }[] {
  const own = app.engine.ownRules
  const seen = new Set<string>()
  const out: { rule: Rule; from: RuleFrom }[] = []
  for (const rule of [...app.engine.rules].reverse()) {
    const key = `${rule.permission}\u0000${rule.pattern}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ rule, from: ruleFrom(rule, own) })
  }
  const order: RuleFrom[] = ["session", "project", "user", "builtin"]
  return out.sort((a, b) => order.indexOf(a.from) - order.indexOf(b.from) || a.rule.permission.localeCompare(b.rule.permission) || a.rule.pattern.localeCompare(b.rule.pattern))
}

export const ruleLine = (r: Rule) => `${r.permission}${r.pattern === "*" ? "" : ` ${r.pattern}`}`

export function permissionsText(app: App): string {
  const rules = rulesInForce(app)
  const lines = [`Mode: ${app.engine.mode}. A call no rule speaks of is asked about or allowed by its kind and the mode.`]
  let from: RuleFrom | undefined
  for (const { rule, from: f } of rules) {
    if (f !== from) lines.push("", `${RULE_FROM[f]}:`)
    from = f
    lines.push(`  ${rule.action.padEnd(5)}  ${ruleLine(rule)}`)
  }
  return lines.join("\n")
}

/** One fact of the status screen: what it is, what it says, whether it needs attention, and the
 *  command that changes it. */
export interface StatusRow {
  label: string
  value: string
  attention?: boolean
  command?: string
  section: string
}

export function statusRows(app: App): StatusRow[] {
  const e = app.engine
  const conns = Object.entries(app.loaded.connections)
  const servers = [...app.mcp.servers.values()]
  const troubled = servers.filter((s) => s.status === "failed" || s.status === "needs_auth")
  const rows: StatusRow[] = [
    { section: "This program", label: "version", value: VERSION },
    {
      section: "The LLeMbas server",
      label: "signed in to",
      value: conns.length ? conns.map(([name, c]) => `${name}${c.webui?.url ? ` (${c.webui.url})` : ""}`).join(", ") : "nothing — /login <address>",
      attention: !conns.length,
      command: "login",
    },
    { section: "The LLeMbas server", label: "model", value: `${e.model.ref}${e.model.spec.context ? ` · context ${e.model.spec.context}` : ""}`, command: "model" },
    { section: "This session", label: "mode", value: e.mode, command: "mode" },
    { section: "This session", label: "session", value: e.sessionId ? `${e.sessionId}${app.store?.session(e.sessionId)?.title ? ` — ${app.store.session(e.sessionId)!.title}` : ""}` : "not kept", command: "sessions" },
    { section: "This project", label: "folder", value: app.project.root },
    { section: "This project", label: "trusted", value: app.trusted ? "yes: its .agent config, commands and servers are used" : "no: its .agent config is ignored — /trust", attention: !app.trusted, command: app.trusted ? undefined : "trust" },
    {
      section: "MCP servers",
      label: "servers",
      value: servers.length ? `${servers.filter((s) => s.status === "connected").length} of ${servers.length} connected${troubled.length ? ` — ${troubled.map((s) => s.name).join(", ")} not` : ""}` : "none configured",
      attention: troubled.length > 0,
      command: "mcp",
    },
    ...troubled.map((s) => ({ section: "MCP servers", label: s.name, value: `${stateLine(s)} (${sourceOf(s) === "library" ? "the server's library" : sourceOf(s)})`, attention: true, command: `mcp ${s.name}` })),
  ]
  return rows
}

export function statusText(app: App): string {
  const rows = statusRows(app)
  const width = Math.max(...rows.map((r) => r.label.length))
  const out: string[] = []
  let section = ""
  for (const r of rows) {
    if (r.section !== section) out.push(...(out.length ? [""] : []), `${r.section}:`)
    section = r.section
    out.push(`  ${r.label.padEnd(width)}  ${r.value}${r.attention ? "  (needs attention)" : ""}`)
  }
  return out.join("\n")
}
