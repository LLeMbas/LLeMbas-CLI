// Menus that used to be dumps of text, or did not exist: /help, /permissions, /status, /agents.
// All on the shared menu (components/dialog.tsx). What each says without a menu is in
// session/report.ts and session/commands.ts.
import { join } from "node:path"
import { paths } from "../config/paths.ts"
import type { Rule } from "../permission/evaluate.ts"
import { RULE_FROM, ruleFrom, ruleLine, rulesInForce, statusRows, type StatusRow } from "../session/report.ts"
import type { Command, CommandCtx } from "./commands.ts"
import type { Option } from "./components/dialog.tsx"
import { hostCopier, isRemote } from "./clipboard.ts"
import { kittyClipboardLikely } from "./kitty-clipboard.ts"
import type { Mark } from "./notices.ts"

// ---- /help ----

/** Where each command stands in /help. A command not named here is under "More". */
const GROUPS: [string, string[]][] = [
  ["This session", ["new", "sessions", "search", "rename", "delete", "continue", "undo", "redo", "compact", "context", "copy", "remote"]],
  ["Model and how it works", ["model", "effort", "mode", "permissions", "plan", "plans", "personality", "team", "agents", "jobs"]],
  ["The project", ["diff", "commit", "branch", "checkpoint", "checkpoints", "review", "init", "changelog", "release", "tasks", "decisions", "decide", "prototype", "trust"]],
  ["What it knows and can use", ["memory", "skills", "skill", "kb", "mcp", "schedule"]],
  ["Account and settings", ["status", "login", "logout", "usage", "settings", "voice", "speak"]],
  ["Look", ["theme", "icons", "terminal"]],
]
const KEY = "\u0000key:"

/** /help: every command under a heading, found by typing; enter runs one, or puts it in the box
 *  when it takes words. The keys are its last section. */
export function openHelp(c: CommandCtx, commands: Command[], keys: string[], run: (cmd: Command) => void) {
  const placed = new Set(GROUPS.flatMap(([, names]) => names))
  const groups: [string, string[]][] = [...GROUPS, ["More", commands.filter((cmd) => !placed.has(cmd.name)).map((cmd) => cmd.name)]]
  const options: Option[] = groups.flatMap(([section, names]) =>
    names.flatMap((name) => {
      const cmd = commands.find((x) => x.name === name)
      if (!cmd) return []
      const also = cmd.aliases?.length ? ` (also /${cmd.aliases.join(", /")})` : ""
      return [{ label: `/${cmd.name}`, value: cmd.name, description: cmd.description, section, detail: `/${cmd.name}${cmd.args ? ` ${cmd.args}` : ""}${also}\n${cmd.description}` }]
    }),
  )
  // A key line is "keys what they do · keys what they do": one row each, so they can be found too.
  const keyRows: Option[] = keys.flatMap((line) => line.split(" · ")).map((k, i) => ({ label: k, value: `${KEY}${i}`, section: "Keys" }))
  c.openDialog({
    title: "Help — commands and keys",
    options: [...options, ...keyRows],
    filter: true,
    width: 84,
    hint: "type to find · ↑↓ move · enter run (or put in the box) · esc close",
    onSelect: (v) => {
      if (v.startsWith(KEY)) return
      const cmd = commands.find((x) => x.name === v)!
      // A command that takes words goes into the box to be finished; one that takes none runs.
      if (cmd.args && !cmd.args.startsWith("[")) return c.setInput(`/${cmd.name} `)
      run(cmd)
    },
  })
}

// ---- /permissions ----

const ACTION_MARK: Record<Rule["action"], Mark> = { allow: "on", ask: "off", deny: "failed" }
const ACTION_WORDS: Record<Rule["action"], string> = { allow: "always allowed", ask: "asks", deny: "denied" }
const ADD = "\u0000add"

/** A rule as typed: `<permission> [pattern] <allow|ask|deny>` — `bash git status* allow`,
 *  `mcp__files__read allow`. The pattern is everything between; none is `*`. */
export function parseRule(text: string): Pick<Rule, "permission" | "pattern" | "action"> | string {
  const words = text.trim().split(/\s+/).filter(Boolean)
  const action = words.at(-1)
  if (words.length < 2 || (action !== "allow" && action !== "ask" && action !== "deny")) return "a rule is: <permission> [pattern] <allow|ask|deny> — for example: bash git status* allow"
  return { permission: words[0]!, pattern: words.slice(1, -1).join(" ") || "*", action }
}

function applyRule(c: CommandCtx, rule: Pick<Rule, "permission" | "pattern" | "action">) {
  const r = c.app.engine.setRule(rule)
  if ("refused" in r) return c.view.info(`${ruleLine(rule as Rule)}: your own config says ${r.refused.action} — change it there (~/.config/lembas/config.yaml, permission:); a rule made here cannot loosen it`, "warn")
  c.flash(`${ruleLine(rule as Rule)}: ${ACTION_WORDS[rule.action]}${r.saved === "project" ? " — saved to the project" : " for this session"}`)
}

/** /permissions: the rules in force by where they were made; enter changes one, the first row adds one. */
export function openPermissions(c: CommandCtx, select?: string) {
  const rules = rulesInForce(c.app)
  const key = (r: Rule) => `${r.permission}\u0000${r.pattern}`
  const where = c.app.trusted ? "this session, and saved to this project's .agent/config.yaml" : "this session only (the project is not trusted)"
  c.openDialog({
    title: `Permissions — mode ${c.app.engine.mode}`,
    body: [`A call no rule speaks of is asked about or allowed by its kind and the mode (/mode). A change made here holds for ${where}.`],
    options: [
      { label: "Add a rule…", value: ADD, description: "<permission> [pattern] <allow|ask|deny>" },
      ...rules.map(({ rule, from }) => ({ label: ruleLine(rule), value: key(rule), mark: ACTION_MARK[rule.action], description: ACTION_WORDS[rule.action], section: RULE_FROM[from], detail: `${rule.permission} · pattern ${rule.pattern} · ${rule.action}${rule.learned ? " · from an \"always\" answer" : ""}` })),
    ],
    filter: true,
    width: 84,
    ...(select ? { select } : {}),
    hint: "type to find · ↑↓ move · enter change · esc close",
    onSelect: (v) => {
      if (v === ADD)
        return c.openDialog({
          title: "Add a permission rule",
          options: [],
          empty: "Type the rule and press enter: <permission> [pattern] <allow|ask|deny> — bash git status* allow · edit src/** ask · mcp__files__write deny",
          custom: {
            label: "add",
            onSubmit: (text) => {
              const rule = parseRule(text)
              if (typeof rule === "string") c.view.info(rule, "warn")
              else applyRule(c, rule)
              openPermissions(c, typeof rule === "string" ? undefined : key(rule as Rule))
            },
          },
          onBack: () => openPermissions(c),
          onSelect: () => {},
        })
      const hit = rules.find((r) => key(r.rule) === v)
      if (!hit) return
      const own = ruleFrom(hit.rule, c.app.engine.ownRules) === "session"
      c.openDialog({
        title: ruleLine(hit.rule),
        body: [`${RULE_FROM[hit.from]} says: ${ACTION_WORDS[hit.rule.action]}. A change holds for ${where}.`],
        options: [
          { label: "Ask each time", value: "ask", current: hit.rule.action === "ask" },
          { label: "Always allow", value: "allow", current: hit.rule.action === "allow" },
          { label: "Deny", value: "deny", current: hit.rule.action === "deny" },
          ...(own ? [{ label: "Remove this session's rule", value: "remove", description: "what stood before it holds again" }] : []),
        ],
        filter: false,
        onBack: () => openPermissions(c, v),
        onSelect: (action) => {
          if (action === "remove") {
            c.app.engine.dropSessionRule(hit.rule.permission, hit.rule.pattern)
            c.flash(`${ruleLine(hit.rule)}: this session's rule is removed`)
          } else applyRule(c, { permission: hit.rule.permission, pattern: hit.rule.pattern, action: action as Rule["action"] })
          openPermissions(c, v)
        },
      })
    },
  })
}

// ---- /status ----

/** What only the terminal knows: the terminal itself, and how copying and pasting images go. */
export function terminalRows(c: CommandCtx): StatusRow[] {
  const caps = c.renderer.capabilities as { terminal?: { name?: string; version?: string }; remote?: boolean; osc52_support?: string } | null
  const remote = isRemote(c.renderer as never)
  const name = caps?.terminal?.name ? `${caps.terminal.name}${caps.terminal.version ? ` ${caps.terminal.version}` : ""}` : "did not say"
  const copy = caps?.osc52_support === "supported" ? "through the terminal (OSC 52)" : !remote && hostCopier() ? "this machine's clipboard" : caps?.osc52_support === "unsupported" ? "not possible here — hold Shift and select with the terminal" : "through the terminal, if it takes OSC 52 (it did not say)"
  const images = !remote
    ? "ctrl+v reads this machine's clipboard"
    : process.env.DISPLAY
      ? "ctrl+v reads the forwarded X clipboard (ssh -X)"
      : c.app.loaded.config.kitty_clipboard === true && kittyClipboardLikely()
        ? "ctrl+v asks the terminal for its clipboard (kitty)"
        : "over SSH: paste a data URL, or use @path"
  return [
    { section: "This terminal", label: "terminal", value: `${name}${remote ? " · over SSH" : ""}`, command: "terminal" },
    { section: "This terminal", label: "copying", value: copy, attention: caps?.osc52_support === "unsupported" && (remote || !hostCopier()) },
    { section: "This terminal", label: "pasting images", value: images, command: "settings" },
  ]
}

/** /status: the server, the session, the project, the MCP servers and the terminal on one screen.
 *  A row that needs attention is marked; enter on a row opens what changes it. */
export function openStatus(c: CommandCtx, run: (line: string) => void) {
  const share = c.share?.status()
  const rows: StatusRow[] = [...statusRows(c.app), ...(share ? [{ section: "This session", label: "web UI", value: share, command: "remote" } satisfies StatusRow] : []), ...terminalRows(c)]
  // Sections in the order they first appear, each one's rows together.
  const sections = [...new Set(rows.map((r) => r.section))]
  const ordered = sections.flatMap((s) => rows.filter((r) => r.section === s))
  const width = Math.max(...ordered.map((r) => r.label.length))
  c.openDialog({
    title: "Status",
    options: ordered.map((r, i) => ({ label: `${r.label.padEnd(width)}  ${r.value}`, value: String(i), section: r.section, mark: r.attention ? "attention" : "on", detail: `${r.value}${r.command ? `\nenter: /${r.command}` : ""}` })),
    filter: false,
    width: 96,
    hint: "↑↓ move · enter open what changes it · esc close",
    onSelect: (v) => {
      const r = ordered[Number(v)]
      if (r?.command) run(r.command)
    },
  })
}

// ---- /agents ----

const NEW_AGENT = "\u0000new"

/** /agents: the subagents the model may hand work to; enter puts `/agents <name> ` in the box, to
 *  be finished with the task. */
export function openAgents(c: CommandCtx) {
  const list = c.app.agents
  c.openDialog({
    title: `Subagents — ${list.length} the model may hand work to`,
    body: ["The model hands work to one through its task tool when that helps; enter a name to hand one a task yourself."],
    options: [
      ...list.map((a) => ({
        label: a.name,
        value: a.name,
        description: a.description,
        section: a.source === "builtin" ? "Built in" : a.source === "project" ? "This project (.agent/agents)" : "Your own",
        detail: `mode ${a.mode ?? "the session's"} · tools ${a.tools?.join(", ") ?? "all a subagent may have"}\n${a.description}`,
      })),
      { label: "New subagent…", value: NEW_AGENT, description: `writes a starter file under ${join(paths.config, "agents")} to edit`, section: "Make one" },
    ],
    empty: "No subagents.",
    hint: "↑↓ move · enter hand it a task · esc close",
    onSelect: (v) => c.setInput(v === NEW_AGENT ? "/agents new " : `/agents ${v} `),
  })
}
