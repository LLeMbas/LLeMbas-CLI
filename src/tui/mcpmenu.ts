// The /mcp menu: the servers with their state and where each comes from; one server's tools with
// what the permission rules say of each (changeable here), its prompts, and what can be done with
// it — reconnect, switch off or on, sign in or out, read the last error in full. Built on the
// shared menu (components/dialog.tsx), so it looks and answers to keys as every other one does.
import type { CommandCtx } from "./commands.ts"
import type { Option } from "./components/dialog.tsx"
import type { Mark } from "./notices.ts"
import { applyRule } from "./menus.ts"
import type { ServerState } from "../mcp/index.ts"
import { persistProjectMcpEnabled, projectMcpEnabled } from "../project/root.ts"
import { promptCommand } from "../mcp/index.ts"
import { clean, errorLine, redactUrls } from "../mcp/clean.ts"
import { offers, sourceOf, SOURCE_WORDS, STATE_WORDS, whereOf } from "../mcp/text.ts"

const MARK_OF: Record<ServerState["status"], Mark> = { connected: "on", connecting: "busy", failed: "failed", needs_auth: "attention", disabled: "off" }
/** What the rules say of a tool, as the menu words it. */
const RULE_WORDS = { ask: "asks", allow: "always allowed", deny: "denied" } as const
const RULE_MARK: Record<keyof typeof RULE_WORDS, Mark> = { ask: "off", allow: "on", deny: "failed" }

const ADD_HINT = "No MCP servers are configured. Add one under mcp: in ~/.config/lembas/config.yaml (or this project's .agent/config.yaml), then /reload."
const SECTION = { library: "From the LLeMbas server", project: "This project (.agent/config.yaml)", user: "Your config" } as const

/** Where switching a server on or off holds: the session, and — in a trusted project, for a
 *  server that is not the login's own — the project's config, so it starts that way next time. */
const persists = (c: CommandCtx, s: ServerState) => c.app.trusted && sourceOf(s) !== "library" && !offByUser(c, s)
const scope = (c: CommandCtx, s: ServerState) => (persists(c, s) ? "for this project" : "for this session")
/** Why "on" is the session's only for a server the person's own config switches off. */
const OFF_BY_USER = "Your own config switches this server off (mcp: enabled: false). A project cannot switch it on, so this holds for the session; change your config to keep it on."
/** Switched off in the person's own config (not by this project): a project's `enabled: true`
 *  would be ignored at the next start, so switching it on is the session's only. */
const offByUser = (c: CommandCtx, s: ServerState) => s.cfg.enabled === false && s.cfg.source === "global" && projectMcpEnabled(c.app.project, s.name) === undefined

/** A sign-in waiting for the person to paste the address the browser ended on (/mcp code). */
export const pendingCodes = new Map<string, (text: string) => void>()

/** What one server's row says after its name. */
function rowWords(s: ServerState): string {
  if (s.status === "connected") return offers(s)
  if (s.status === "failed") return `${STATE_WORDS.failed}: ${errorLine(s.error) || "no reason given"}`
  return STATE_WORDS[s.status]
}

/** The list of servers. Enter opens one. */
export function openMcpMenu(c: CommandCtx, select?: string) {
  const mcp = c.app.mcp
  const order = { library: 0, project: 1, user: 2 }
  const servers = [...mcp.servers.values()].sort((a, b) => order[sourceOf(a)] - order[sourceOf(b)] || a.name.localeCompare(b.name))
  const options: Option[] = servers.map((s) => ({ label: clean(s.name), value: s.name, mark: MARK_OF[s.status], description: rowWords(s), section: SECTION[sourceOf(s)], detail: whereOf(s) }))
  c.openDialog({
    title: `MCP servers${servers.length ? ` — ${servers.filter((s) => s.status === "connected").length} of ${servers.length} connected` : ""}`,
    options,
    empty: ADD_HINT,
    ...(select ? { select } : {}),
    hint: "↑↓ move · enter open · esc close",
    onSelect: (name) => openMcpServer(c, name),
  })
}

const ACTION = "\u0000action:"
const TOOL = "\u0000tool:"
const PROMPT = "\u0000prompt:"

/** One server: what can be done with it, its tools (type to search), its prompts. */
export function openMcpServer(c: CommandCtx, name: string, select?: string) {
  const mcp = c.app.mcp
  const s = mcp.servers.get(name)
  if (!s) return openMcpMenu(c)
  const remote = s.cfg.url !== undefined
  const signIn = remote && s.cfg.oauth !== false && sourceOf(s) !== "library"
  const act = (id: string, label: string, description: string): Option => ({ label, value: `${ACTION}${id}`, description, section: "Actions" })
  const actions: Option[] = [
    ...(s.status === "disabled"
      ? [{ ...act("on", "Switch on", `connect it — ${scope(c, s)}`), ...(offByUser(c, s) && c.app.trusted ? { detail: OFF_BY_USER } : {}) }]
      : [act("reconnect", s.status === "connected" ? "Reconnect" : "Connect again", "close the connection and make it anew"), act("off", "Switch off", `its tools are withdrawn — ${scope(c, s)}`)]),
    ...(signIn ? [act("auth", s.status === "needs_auth" ? "Sign in" : "Sign in again", "opens the server's sign-in page in your browser")] : []),
    ...(signIn ? [act("logout", "Sign out", "forget the stored sign-in for this server (asks first)")] : []),
    ...(s.error ? [act("error", "Read the last error in full", errorLine(s.error))] : []),
  ]
  const tools: Option[] =
    s.status === "connected"
      ? s.tools.map((t) => {
          const called = mcp.nameOf(s.name, t.name)
          const rule = c.app.engine.ruleFor(called) ?? "ask"
          const first = clean((t.description ?? "").trim().split("\n")[0])
          return {
            label: clean(t.name),
            value: `${TOOL}${t.name}`,
            mark: RULE_MARK[rule],
            description: `${RULE_WORDS[rule]}${t.annotations?.readOnlyHint ? " · read-only" : ""}${first ? ` · ${first}` : ""}`,
            section: `Tools (${s.tools.length}) — enter changes what a tool may do`,
            detail: `${clean(called)}\n${clean(t.description ?? "No description.", true).trim()}`,
          }
        })
      : []
  const prompts: Option[] =
    s.status === "connected"
      ? // By the name the command is registered under (mcp/index.ts promptCommand), which is what the box understands.
        s.prompts.map((p) => ({ label: `/${promptCommand(s.name, p.name)}`, value: `${PROMPT}${p.name}`, description: clean((p.description ?? "").split("\n")[0]), section: `Prompts (${s.prompts.length}) — enter puts one in the box`, detail: clean(p.description ?? "", true) }))
      : []
  c.openDialog({
    title: `MCP · ${clean(s.name)}`,
    body: [`${STATE_WORDS[s.status]}${s.status === "connected" ? ` — ${offers(s)}` : ""} · from ${SOURCE_WORDS[sourceOf(s)]}`, whereOf(s), ...(s.status === "failed" && s.error ? [`failed: ${errorLine(s.error)}`] : [])],
    options: [...actions, ...tools, ...prompts],
    // Searchable as soon as there is more than a handful of tools.
    filter: tools.length + prompts.length > 6,
    ...(select ? { select } : {}),
    hint: "↑↓ move · enter choose · esc back",
    onBack: () => openMcpMenu(c, s.name),
    onSelect: (v) => {
      if (v.startsWith(TOOL)) return openToolRule(c, s.name, v.slice(TOOL.length))
      if (v.startsWith(PROMPT)) return c.setInput(`/${promptCommand(s.name, v.slice(PROMPT.length))} `)
      void runAction(c, s.name, v.slice(ACTION.length))
    },
  })
}

/** What a tool may do: ask each time, always allowed, denied — the permission rule for it. */
function openToolRule(c: CommandCtx, server: string, tool: string) {
  const mcp = c.app.mcp
  const called = mcp.nameOf(server, tool)
  const now = c.app.engine.ruleFor(called) ?? "ask"
  const remote = mcp.servers.get(server)?.tools.find((t) => t.name === tool)
  const where = c.app.trusted ? "this session, and saved to this project's .agent/config.yaml" : "this session (the project is not trusted, so nothing is saved)"
  c.openDialog({
    title: `${clean(server)} · ${clean(tool)}`,
    body: [clean(called), ...(remote?.description ? [clean(remote.description.trim().split("\n")[0])] : []), `Applies to ${where}. A narrower, stricter rule — and your own config — keeps winning.`],
    options: [
      { label: "Ask each time", value: "ask", current: now === "ask", description: "a card before every call" },
      { label: "Always allow", value: "allow", current: now === "allow", description: "runs without asking" },
      { label: "Deny", value: "deny", current: now === "deny", description: "never runs; the model is told" },
    ],
    filter: false,
    onBack: () => openMcpServer(c, server, `${TOOL}${tool}`),
    onSelect: (action) => {
      applyRule(c, { permission: called, pattern: "*", action: action as "ask" | "allow" | "deny" }, clean(tool))
      openMcpServer(c, server, `${TOOL}${tool}`)
    },
  })
}

/** A server's last error, every line of it, as a list to scroll. */
function openError(c: CommandCtx, server: string) {
  const s = c.app.mcp.servers.get(server)
  const width = Math.max(20, Math.min(72, c.renderer.width - 4) - 6)
  // In full, here on the person's own screen — cleaned, and without the credentials an address may carry.
  const lines = [...redactUrls(clean(s?.error ?? "no error", true)).split("\n"), ...(s?.stderr.length ? ["", "What the program wrote before it stopped:", ...s.stderr.map((l) => redactUrls(clean(l)))] : [])].flatMap((l) => (l.length <= width ? [l] : Array.from({ length: Math.ceil(l.length / width) }, (_, i) => l.slice(i * width, (i + 1) * width))))
  c.openDialog({
    title: `MCP · ${server} · the last error`,
    options: lines.map((l, i) => ({ label: l || " ", value: String(i), inert: true })),
    filter: false,
    hint: "↑↓ pgup/pgdn scroll · esc back",
    onBack: () => openMcpServer(c, server, `${ACTION}error`),
    onSelect: () => {},
  })
}

/** Do one thing to a server, say how it went in a line, and show the server again. */
export async function runAction(c: CommandCtx, name: string, action: string, o: { menu?: boolean; code?: string; confirmed?: boolean } = { menu: true }): Promise<void> {
  const mcp = c.app.mcp
  const back = () => (o.menu ? openMcpServer(c, name) : undefined)
  if (action === "error") return openError(c, name)
  /** Whether the transcript got a line about this server since `mark` — a server that fails or
   *  needs a sign-in is announced once, by whoever watches the servers (app.ts); it is not said twice. */
  const mark = c.view.state.items.length
  const announced = () => c.view.state.items.slice(mark).some((i) => i.kind === "notice" && i.text.startsWith(`MCP ${clean(name)} `))
  /** Keep a switch for the project, where that holds; what to say when it could not be written. */
  const keep = (s: ServerState, on: boolean): string => {
    if (!persists(c, s)) return offByUser(c, s) && c.app.trusted ? "for this session — your own config switches it off, and a project cannot switch it on" : scope(c, s)
    try {
      persistProjectMcpEnabled(c.app.project, name, on)
      return "for this project"
    } catch (e) {
      return `for this session only — it could not be saved to the project: ${(e as Error).message.split("\n")[0]}`
    }
  }
  try {
    if (action === "reconnect" || action === "on") {
      c.flash(`MCP ${clean(name)}: connecting…`)
      // Read before it is switched on: what the configs said of it decides where "on" can be kept.
      const where = action === "on" ? keep(mcp.servers.get(name)!, true) : ""
      const s = action === "on" ? await mcp.setEnabled(name, true) : await mcp.connect(name)
      if (s.status === "connected") c.view.info(`MCP ${clean(name)}: connected — ${offers(s)}${where ? ` · switched on ${where}` : ""}`, "success")
      else if (!announced()) c.view.info(`MCP ${clean(name)} did not connect: ${errorLine(s.error) || STATE_WORDS[s.status]}`, "warn")
    } else if (action === "off") {
      const where = keep(mcp.servers.get(name)!, false)
      await mcp.setEnabled(name, false)
      c.view.info(`MCP ${clean(name)}: switched off ${where} — /mcp ${clean(name)} switches it on again`, where.includes("could not") ? "warn" : "info")
    } else if (action === "auth") {
      const pasted = new Promise<string>((resolve) => pendingCodes.set(name, resolve))
      const s = await mcp.auth(
        name,
        (url) => c.view.info(`Sign in to ${name} at:\n${url}\n\nThe browser is sent back to this machine (127.0.0.1). If it cannot get here, copy the address it ends on and type: /mcp code ${name} <that address>`),
        pasted,
      )
      pendingCodes.delete(name)
      if (s.status === "connected") c.view.info(`MCP ${clean(name)}: signed in — ${offers(s)}`, "success")
      else if (!announced()) c.view.info(`MCP ${clean(name)}: ${errorLine(s.error) || STATE_WORDS[s.status]}`, "warn")
      // The sign-in page was read meanwhile: the menu is not put back over it.
      return c.refresh()
    } else if (action === "code") {
      const give = pendingCodes.get(name)
      if (!give) return c.view.info(`no sign-in to ${name} is waiting — /mcp auth ${name} starts one`, "warn")
      return give(o.code ?? "")
    } else if (action === "logout") {
      // Asked once in the menu: signing in again means the browser and the server's page.
      if (o.menu && !o.confirmed)
        return c.openDialog({
          title: `Sign out of ${clean(name)}?`,
          body: ["The stored sign-in for this server is forgotten; using it again means signing in in the browser."],
          options: [
            { label: "Sign out", value: "yes" },
            { label: "Keep the sign-in", value: "no", current: true },
          ],
          select: "no",
          filter: false,
          onBack: () => openMcpServer(c, name, `${ACTION}logout`),
          onSelect: (v) => (v === "yes" ? void runAction(c, name, "logout", { ...o, confirmed: true }) : openMcpServer(c, name, `${ACTION}logout`)),
        })
      mcp.logout(name)
      c.view.info(`MCP ${clean(name)}: the stored sign-in is removed`)
    } else return c.view.info(`unknown: /mcp ${action} — reconnect, on, off, auth, code or logout`, "warn")
  } catch (e) {
    pendingCodes.delete(name)
    if (!announced()) c.view.info(`MCP ${clean(name)}: ${errorLine((e as Error).message)}`, "warn")
  }
  c.refresh()
  back()
}
