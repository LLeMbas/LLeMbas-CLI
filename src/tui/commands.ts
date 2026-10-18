// Built-in slash commands; custom markdown commands, skills and MCP prompts join them in the
// palette.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { paths } from "../config/paths.ts"
import { asMode, EFFORTS, MODES, type Effort, type Mode } from "../config/schema.ts"
import { effortsFor } from "../provider/effort.ts"
import { setTrust } from "../project/root.ts"
import { commit, commitPlan, draftMessage } from "../git/commit.ts"
import { doRelease, planRelease } from "../git/release.ts"
import { instructionFiles } from "../prompt/assemble.ts"
import { addDecision, readBoard, readDecisions, renderBoard } from "../project/board.ts"
import { contextBreakdown, renderBreakdown } from "../session/context.ts"
import { changelogPrompt, initPrompt, reviewPrompt } from "../session/commands.ts"
import { git } from "../git/run.ts"
import { branches, deleteBranch, switchBranch } from "../git/branch.ts"
import type { Ctx } from "./context.ts"
import type { DialogSpec } from "./components/dialog.tsx"
import { deleteEverywhere } from "../acp/share.ts"
import { themeNames } from "./theme.ts"
import { render } from "../plan/plan.ts"
import { planTitle } from "../tool/plan_write.ts"
import { findSetting, show, type Scope } from "../config/settings.ts"
import { ingest } from "../library/ingest.ts"
import { findSkill, skillMessage, slug } from "../skill/index.ts"
import { PERSONALITIES, personalityText } from "../prompt/personality.ts"
import { listPrototypes } from "../prototype/store.ts"
import { keyMatcher } from "../voice/index.ts"
import { PLAYER_NAMES, playerFor, recorderFor } from "../voice/audio.ts"

export interface CommandCtx extends Ctx {
  voice: import("../voice/index.ts").VoiceController
  /** Put text into the prompt (e.g. the prompt /undo took back). */
  setInput(text: string): void
  /** Copy to the clipboard (OSC 52 and, on this machine, the system clipboard), and say how it went. */
  copy(text: string): void
  renderer: import("@opentui/core").CliRenderer
  /** Send a prompt as if typed. */
  send?(text: string): void
  /** The session shared with the web UI. */
  share?: import("../acp/share.ts").Share
  /** Carry on: after a stop (esc), or an answer that ended too soon (ctrl+g). */
  continueTask(): void
  /** Send a prompt shown as `shown`, with a model/mode for this prompt only. */
  sendAs?(prompt: string, shown: string, opts?: { model?: string; mode?: string; attachFrom?: string }): void
  openDialog(spec: DialogSpec): void
  setMode(m: Mode): void
  setEffort(e: Effort | null): void
  setTheme(name: string): void
  setIcons(set: import("./theme.ts").IconSet): void
  /** A short word in the status bar that goes by itself. */
  flash(text: string, ms?: number): void
  refresh(): void
  quit(): void
  /** Start again: the binary on disk now, the config read afresh, this session. */
  reload(): void
  /** The status bar's balance, as /usage just read it. */
  setCredits?(text: string): void
}

export interface Command {
  name: string
  aliases?: string[]
  args?: string
  description: string
  run(c: CommandCtx, arg: string): void | Promise<void>
}

const HELP_KEYS = [
  "enter send · shift+enter / ctrl+j new line · ↑↓ history",
  "esc stop the model · ctrl+g continue (after a stop, or to keep going) · ctrl+c clear, twice to quit",
  "shift+tab cycle mode (manual → edit → plan) · ctrl+r show reasoning · ctrl+o expand tool output",
  "pgup/pgdn scroll half a screen · ctrl+↑/↓ three lines · the mouse wheel · ↑ in an empty box takes back a message waiting to go in",
]

/** A sign-in waiting for the user to paste the redirect address (/mcp code). */
const pendingCodes = new Map<string, (text: string) => void>()

const AGENT_TEMPLATE = (name: string) => `---
description: what ${name} is for — the model reads this when it picks a subagent
# model: connection/model      # run it on another model (default: the session's)
# mode: plan                   # plan: read-only; edit; manual (asks you) — never looser than yours
# tools: [read, glob, grep, list, bash, web_search, web_fetch]   # default: every tool a subagent may have
# isolation: worktree          # work in a git checkout and branch of its own
---
You are the ${name} subagent. Say what to do, how to check it, and what to report back — the
report is all the session's model sees of your work.
`

export const COMMANDS: Command[] = [
  {
    name: "agents",
    args: "[new <name> [project] | <name> <task>]",
    description: "subagents: list them, make one, or hand one a task",
    run(c, arg) {
      const [first, ...rest] = arg.trim().split(/\s+/).filter(Boolean)
      const list = c.app.agents
      if (first === "new") {
        const name = (rest[0] ?? "").toLowerCase().replace(/[^a-z0-9_-]/g, "-")
        if (!name) return c.view.info("/agents new <name> [project] — writes a starter file to edit", "warn")
        const inProject = rest[1] === "project"
        if (inProject && !c.app.trusted) return c.view.info("a project's own agents need a trusted project (/trust)", "warn")
        const dir = inProject ? join(c.app.project.dir, "agents") : join(paths.config, "agents")
        const file = join(dir, `${name}.md`)
        if (existsSync(file)) return c.view.info(`${file} already exists`, "warn")
        mkdirSync(dir, { recursive: true })
        writeFileSync(file, AGENT_TEMPLATE(name))
        return c.view.info(`wrote ${file} — fill it in, then /reload so the model is offered it`)
      }
      const named = first ? list.find((a) => a.name === first) : undefined
      if (first && !named) return c.view.info(`no agent "${first}" — ${list.map((a) => a.name).join(", ")}`, "warn")
      if (named && rest.length) {
        if (c.app.turns.current) return c.view.info("wait for the task to finish (esc stops it)", "warn")
        // Handed to the session's model, which runs it through the task tool and gets the report.
        const task = rest.join(" ")
        return c.send?.(`Use the ${named.name} subagent (the task tool, agent: "${named.name}") for this, then tell me what it reported:\n\n${task}`)
      }
      const describe = (a: (typeof list)[number]) =>
        [
          `${a.name} (${a.source}) — ${a.description}`,
          `  model ${a.model ?? "the session's"} · mode ${a.mode ?? "the session's"} · tools ${a.tools?.join(", ") ?? "all a subagent may have"}${a.isolation ? " · own worktree" : ""}`,
        ].join("\n")
      if (named) return c.view.info(describe(named))
      c.view.info(
        [
          ...list.map(describe),
          "",
          "The model hands work to one through its task tool when that helps; you can ask it to (\"use the explore subagent to…\"), or /agents <name> <task>.",
          `Your own: /agents new <name> writes ${join(paths.config, "agents")}/<name>.md (add \`project\` for this project's .agent/agents/).`,
        ].join("\n"),
      )
    },
  },
  {
    name: "continue",
    description: "carry on — after esc stopped it, or when it should keep going (ctrl+g)",
    run: (c) => c.continueTask(),
  },
  {
    name: "help",
    description: "commands and keys",
    run(c) {
      const lines = COMMANDS.map((cmd) => `/${cmd.name}${cmd.args ? " " + cmd.args : ""} — ${cmd.description}`)
      c.view.info([...lines, "", ...HELP_KEYS].join("\n"))
    },
  },
  {
    name: "model",
    args: "[connection/model]",
    description: "switch model",
    run(c, arg) {
      const refs = c.app.modelRefs()
      const pick = (ref: string) => {
        try {
          c.app.settings.set("model", ref)
          c.view.info(`model: ${ref}`)
        } catch (e) {
          c.view.info((e as Error).message, "warn")
        }
      }
      if (arg) return pick(arg)
      c.openDialog({
        title: "Model",
        options: refs.map((r) => {
          const known = c.app.loaded.refs.find((x) => x.ref === r)!
          const spec = c.app.loaded.connections[known.connection]!.models[known.id]!
          const bits = [spec.context ? `${Math.round(spec.context / 1024)}k ctx` : "", spec.vision ? "vision" : "", spec.efforts ? "effort" : ""].filter(Boolean).join(" · ")
          return { label: r, value: r, description: bits, current: r === c.app.engine.model.ref }
        }),
        onSelect: pick,
      })
    },
  },
  {
    name: "effort",
    args: `[${EFFORTS.join("|")}|off]`,
    description: "reasoning effort for this model",
    run(c, arg) {
      const allowed = effortsFor(c.app.engine.model)
      const set = (v: string) => {
        if (v === "off") return c.setEffort(null)
        if (!allowed.includes(v as Effort)) return c.view.info(`${c.app.engine.model.ref} takes ${allowed.join(", ")} or off`, "warn")
        c.setEffort(v as Effort)
      }
      if (arg) return set(arg)
      c.openDialog({
        title: `Effort — ${c.app.engine.model.ref}`,
        options: [...allowed, "off"].map((e) => ({ label: e, value: e, current: (c.app.engine.effort ?? "off") === e })),
        onSelect: set,
      })
    },
  },
  {
    name: "mode",
    args: `[${MODES.join("|")}]`,
    description: "permission mode",
    run(c, arg) {
      const set = (raw: string) => {
        const m = asMode(raw)
        if (!m) return c.view.info(`modes: ${MODES.join(", ")}`, "warn")
        if (m === "auto")
          return c.openDialog({
            title: "Auto: nothing will ask. Sure?",
            options: [
              { label: "No, stay in " + c.app.engine.mode, value: "no" },
              { label: "Yes — no approvals (the hardline still holds)", value: "yes" },
            ],
            onSelect: (v) => v === "yes" && c.setMode("auto"),
          })
        c.setMode(m)
      }
      if (arg) return set(arg)
      c.openDialog({
        title: "Permission mode",
        options: [
          { label: "manual", value: "manual", description: "ask for everything not already allowed" },
          { label: "edit", value: "edit", description: "file changes in the project need no approval" },
          { label: "plan", value: "plan", description: "read and plan only" },
          { label: "auto", value: "auto", description: "nothing asks (hardline still refused)" },
        ].map((o) => ({ ...o, current: o.value === c.app.engine.mode })),
        onSelect: set,
      })
    },
  },
  {
    name: "plan",
    args: "[task | show | clear]",
    description: "plan mode — read, investigate, write a plan for approval; with a task, start on it",
    run(c, arg) {
      if (arg === "show") {
        const plan = c.app.engine.plan
        return c.view.info(plan ? render(plan) : "no plan in this session — the model writes one with plan_write")
      }
      if (arg === "clear") {
        if (!c.app.engine.plan) return c.view.info("no plan in this session")
        c.app.engine.setPlan(null)
        return c.view.info("plan cleared")
      }
      c.setMode("plan")
      if (arg) c.send?.(arg)
      else c.view.info("plan mode: the model reads and plans, then asks you to approve the plan. shift+tab leaves it.")
    },
  },
  {
    name: "plans",
    description: "this project's plans, and this session's",
    run(c) {
      const live = c.app.engine.plan
      const dir = c.app.engine.o.toolCtx.planDir
      const files = dir && existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).sort().reverse() : []
      const here = live ? `this session: ${live.title} (${planTitle(live)}) — /plan show` : "this session has no plan"
      if (!files.length) return c.view.info(`${here}\nno plans saved yet — /plan <task> writes one`)
      c.view.info(here)
      c.openDialog({
        title: "Plans",
        options: files.map((f) => ({ label: f, value: f, description: readFileSync(join(dir!, f), "utf8").split("\n").find((l) => l.startsWith("#"))?.replace(/^#+\s*/, "") ?? "" })),
        onSelect: (f) => c.view.info(`${f}\n\n${readFileSync(join(dir!, f), "utf8")}`),
      })
    },
  },
  {
    name: "prototype",
    args: "[n]",
    description: "this session's prototypes — HTML pages the model wrote, saved as files; with a number, that one's path",
    run(c, arg) {
      const id = c.app.engine.sessionId
      const list = id ? listPrototypes(id) : []
      if (!list.length) return c.view.info("no prototypes in this session yet")
      const wanted = arg.trim()
      if (wanted) {
        const one = list.find((p) => String(p.n) === wanted)
        return one ? c.view.info(one.path) : c.view.info(`no prototype ${wanted} here — ${list.map((p) => p.n).join(", ")}`, "warn")
      }
      c.view.info(list.map((p) => `${p.n}  ${p.path}`).join("\n"))
    },
  },
  {
    name: "review",
    args: "[head | <branch>]",
    description: "a read-only review of this session's changes (or since the last commit, or against a branch)",
    run(c, arg) {
      // The same builder as a /review sent from the web UI (session/commands.ts).
      const r = reviewPrompt(c.app, arg)
      if ("message" in r) return c.view.info(r.message, r.message.startsWith("nothing") ? "info" : "warn")
      // The diff is somebody else's text: an @path in it must not attach a file.
      c.sendAs?.(r.prompt, `/review${arg ? " " + arg : ""}`, { mode: "plan", attachFrom: "" })
    },
  },
  {
    name: "changelog",
    args: "[since]",
    description: "update CHANGELOG.md's Unreleased section from the commits since the last tag",
    run(c, arg) {
      const r = changelogPrompt(c.app, arg)
      if ("message" in r) return c.view.info(r.message, "warn")
      c.sendAs?.(r.prompt, `/changelog${arg ? " " + arg : ""}`, { attachFrom: "" })
    },
  },
  {
    name: "init",
    args: "[what to focus on]",
    description: "make or update the project's AGENTS.md from what the repository says",
    run(c, arg) {
      // A command the web UI offers too, so the TUI has it as well.
      c.sendAs?.(initPrompt(c.app, arg), `/init${arg ? " " + arg : ""}`, { attachFrom: arg })
    },
  },
  {
    name: "release",
    args: "[patch|minor|major|x.y.z]",
    description: "bump the version, date the CHANGELOG, commit and tag (signed if git signs) — push only if you choose",
    run(c, arg) {
      if (!c.app.project.gitRoot) return c.view.info("not a git repository", "warn")
      const p = planRelease(c.app.project.root, arg)
      if ("blocked" in p && !("to" in p)) return c.view.info(`/release: ${p.blocked}`, "warn")
      const plan = p as Exclude<typeof p, { blocked: string }>
      const what = plan.tagOnly ? [`HEAD is already "Release ${plan.to}" but has no tag: only the tag ${plan.tag} is made`] : [
        `${plan.versionFile.file}${plan.versionFile.also?.length ? ` (and ${plan.versionFile.also.map((a) => a.file).join(", ")})` : ""}: ${plan.from} → ${plan.to}`,
        plan.changelog ? `CHANGELOG.md: Unreleased → [${plan.to}] (${plan.changelog.notes.split("\n").length} lines)` : "CHANGELOG.md: nothing under Unreleased — the tag will have no notes (/changelog first?)",
        `commit "Release ${plan.to}", then ${plan.sign ? "a signed" : "an annotated"} tag ${plan.tag}`,
      ]
      const notes = plan.changelog?.notes ?? plan.notes
      c.view.info(`release plan:\n${what.map((w) => `  ${w}`).join("\n")}${notes ? `\n\ntag message:\n${plan.name} ${plan.to}\n\n${notes.slice(0, 1500)}` : ""}`)
      c.openDialog({
        title: `Release ${plan.tag}?`,
        options: [
          { label: "Release", value: "local", description: "commit and tag here; push nothing" },
          { label: "Release and push", value: "push", description: "then push the branch and the tag" },
          { label: "Cancel", value: "no" },
        ],
        onSelect: (v) => {
          if (v === "no") return c.view.info("no release made")
          const r = doRelease(plan, v === "push")
          c.view.info(r.lines.join("\n"), r.ok ? undefined : "warn")
          c.refresh()
        },
      })
    },
  },
  {
    name: "tasks",
    description: "the project's task board (.agent/tasks.md)",
    run(c) {
      if (!existsSync(c.app.project.dir)) return c.view.info("no project directory yet — /trust creates it", "warn")
      c.view.info(`tasks — ${c.app.project.dir.slice(c.app.project.root.length + 1)}/tasks.md\n\n${renderBoard(readBoard(c.app.project.dir))}`)
    },
  },
  {
    name: "decisions",
    description: "the project's decision log",
    run(c) {
      if (!existsSync(c.app.project.dir)) return c.view.info("no project directory yet — /trust creates it", "warn")
      const d = readDecisions(c.app.project.dir)
      c.view.info(d.length ? d.map((x) => `${x.date} · ${x.title}\n${x.text}`).join("\n\n") : "no decisions recorded — /decide <title>: <decision>")
    },
  },
  {
    name: "decide",
    args: "<title>: <decision>",
    description: "record a decision in the project's log",
    run(c, arg) {
      if (!existsSync(c.app.project.dir)) return c.view.info("no project directory yet — /trust creates it", "warn")
      const m = /^([^:]{3,80}):\s*([\s\S]+)$/.exec(arg.trim())
      if (!m) return c.view.info("usage: /decide <title>: <decision> — e.g. /decide Storage: SQLite, one file per project", "warn")
      const d = addDecision(c.app.project.dir, m[1]!, m[2]!)
      c.view.info(`recorded: ${d.date} · ${d.title}`)
    },
  },
  {
    name: "sessions",
    aliases: ["resume"],
    args: "[delete]",
    description: "resume a session in this project; ctrl+d in the list, or /sessions delete, deletes one (here and in the web UI)",
    run(c, arg) {
      if (arg.trim() === "delete") {
        const list = otherSessions(c)
        if (!list.length) return c.view.info("no other sessions in this project")
        return c.openDialog({
          title: "Delete a session",
          options: list.map((s) => sessionOption(c, s)),
          onSelect: (id) => confirmDelete(c, id),
        })
      }
      openResume(c)
    },
  },
  {
    name: "remote",
    args: "[off]",
    description: "share this session with the LLeMbas web UI (through the service, or held by this terminal while it runs); off stops it",
    run(c, arg) {
      if (!c.share) return c.view.info("/remote is not available here", "warn")
      const a = arg.trim().toLowerCase()
      if (a === "status" || a === "?") return c.view.info(c.share.status())
      void c.share.remote(a !== "off").then((m) => (c.view.info(m), c.refresh()))
    },
  },
  {
    name: "delete",
    description: "delete this session (here and in the web UI) and start a new one",
    run(c) {
      const id = c.app.engine.sessionId
      if (!id) return c.view.info("no session to delete", "warn")
      confirmDelete(c, id, true)
    },
  },
  {
    name: "new",
    aliases: ["clear"],
    description: "start a new session",
    run(c) {
      c.app.newSession()
      c.view.clear()
    },
  },
  {
    name: "copy",
    args: "[n]",
    description: "copy the last reply (or the nth from the end) as markdown — for when selecting with the mouse cannot reach your clipboard",
    run(c, arg) {
      const n = Math.max(1, Number.parseInt(arg || "1", 10) || 1)
      const replies = c.app.engine.messages
        .filter((m) => m.role === "assistant")
        .map((m) => (m.role === "assistant" ? m.parts.map((p) => (p.type === "text" ? p.text : "")).join("").trim() : ""))
        .filter(Boolean)
      const text = replies[replies.length - n]
      if (!text) return c.view.info(replies.length ? `there are only ${replies.length} replies` : "no reply to copy yet")
      c.copy(text)
    },
  },
  {
    name: "undo",
    description: "take back the last prompt: its file changes and its conversation",
    run(c) {
      const r = c.app.turns.undo()
      if (!r) return c.view.info("nothing to undo in this session")
      c.view.load(c.app.engine.messages)
      c.setInput(r.prompt)
      c.view.info(r.files.length ? `undone — restored ${r.files.length} file${r.files.length > 1 ? "s" : ""}: ${r.files.join(", ")}` : "undone — no files had changed")
      if (!c.app.snapshots?.enabled && c.app.snapshots?.reason) c.view.info(c.app.snapshots.reason, "warn")
    },
  },
  {
    name: "redo",
    description: "put back what /undo took",
    run(c) {
      const r = c.app.turns.redo()
      if (!r) return c.view.info("nothing to redo")
      c.view.load(c.app.engine.messages)
      c.setInput("")
      c.view.info(r.files.length ? `redone — ${r.files.join(", ")}` : "redone")
    },
  },
  {
    name: "diff",
    args: "[head]",
    description: "what this session changed (or: everything since the last commit)",
    run(c, arg) {
      if (arg === "head") {
        if (!c.app.project.gitRoot) return c.view.info("not a git repository", "warn")
        const tracked = git(c.app.project.gitRoot, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "HEAD"])
        const patch = tracked.code === 0 ? tracked.out : git(c.app.project.gitRoot, ["diff", "--no-color", "--no-ext-diff", "--no-textconv"]).out
        return patch ? c.view.diff("changes since the last commit", patch) : c.view.info("no changes since the last commit")
      }
      const patch = c.app.turns.diff()
      if (patch === undefined) return c.view.info(c.app.snapshots?.reason || "no prompt yet in this session", "warn")
      patch ? c.view.diff("changes in this session", patch) : c.view.info("nothing changed in this session")
    },
  },
  {
    name: "checkpoint",
    args: "[name]",
    description: "save the files as they are now under a name, to come back to later (kept across sessions)",
    run(c, arg) {
      const snaps = c.app.snapshots
      if (!snaps) return c.view.info("checkpoints need snapshots, which are off here", "warn")
      const label = arg.trim() || `checkpoint ${new Date().toISOString().slice(0, 16).replace("T", " ")}`
      const cp = snaps.checkpoint(label)
      if (!cp) return c.view.info(snaps.reason || "the checkpoint could not be saved", "warn")
      c.view.info(`checkpoint saved: ${label} — /checkpoints goes back to it`)
    },
  },
  {
    name: "checkpoints",
    description: "this project's checkpoints: go back to one, see what changed since, or delete it",
    run(c) {
      const snaps = c.app.snapshots
      if (!snaps) return c.view.info("checkpoints need snapshots, which are off here", "warn")
      const list = snaps.checkpoints()
      if (!list.length) return c.view.info(snaps.reason || "no checkpoints yet — /checkpoint [name] saves one", snaps.reason ? "warn" : undefined)
      const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ")
      c.openDialog({
        title: "Checkpoints",
        options: list.map((cp) => ({ label: cp.label, value: cp.ref, description: when(cp.at) })),
        onSelect: (ref) => {
          const cp = list.find((x) => x.ref === ref)!
          const now = snaps.track()
          const files = now ? snaps.changed(cp.tree, now) : []
          c.openDialog({
            title: `${cp.label} — ${files.length ? `${files.length} file${files.length > 1 ? "s" : ""} differ now` : "nothing has changed since"}`,
            options: [
              ...(files.length
                ? [
                    { label: "Go back to it", value: "restore", description: `put ${files.length > 3 ? `${files.length} files` : files.join(", ")} back as they were; what is there now is saved as a checkpoint first` },
                    { label: "Show what changed since", value: "diff" },
                  ]
                : []),
              { label: "Delete the checkpoint", value: "drop", description: "the files are not touched" },
              { label: "Cancel", value: "no" },
            ],
            onSelect: (v) => {
              if (v === "diff") return now && c.view.diff(`changes since "${cp.label}"`, snaps.diff(cp.tree, now))
              if (v === "drop") return c.view.info(snaps.dropCheckpoint(cp.ref) ? `deleted checkpoint: ${cp.label}` : "could not delete it", "warn")
              if (v !== "restore") return
              const r = snaps.restoreCheckpoint(cp)
              if (!r) return c.view.info(snaps.reason || "could not go back to the checkpoint", "warn")
              c.view.info(`back at "${cp.label}" — restored ${r.files.length} file${r.files.length === 1 ? "" : "s"}${r.saved ? `; what was there is the checkpoint "${r.saved.label}"` : ""}`)
              // The conversation is not rewound: the model has to know its files moved under it.
              if (r.files.length) c.app.engine.pendingContext.push(`<note>The user restored the files to the checkpoint "${cp.label}" (${when(cp.at)}). These files changed: ${r.files.join(", ")}. Read a file again before changing it.</note>`)
            },
          })
        },
      })
    },
  },
  {
    name: "branch",
    args: "[name]",
    description: "the git branches: switch to one; with a name, switch to it (made from here if it is new)",
    run(c, arg) {
      const root = c.app.project.gitRoot
      if (!root) return c.view.info("not a git repository", "warn")
      const go = (name: string) => {
        const r = switchBranch(root, name)
        c.view.info(r.text, r.ok ? undefined : "warn")
        if (r.ok && !r.text.startsWith("already")) c.app.engine.pendingContext.push(`<note>The user switched the repository to the branch ${name}.</note>`)
        c.refresh()
      }
      if (arg.trim()) return go(arg.trim())
      const list = branches(root)
      if (!list.length) return c.view.info("no branches yet — the repository has no commit; /branch <name> names the first one", "warn")
      const when = (ms: number) => new Date(ms).toISOString().slice(0, 10)
      c.openDialog({
        title: "Branches",
        options: [
          { label: "New branch…", value: "\0new", description: "type /branch <name>: made from the current commit, uncommitted changes come along" },
          ...list.map((b) => ({ label: b.name, value: b.name, current: b.current, description: `${when(b.at)} · ${b.last}${b.upstream ? ` · ${b.upstream}` : ""}` })),
        ],
        onSelect: (name) => {
          if (name === "\0new") return c.setInput("/branch ")
          const b = list.find((x) => x.name === name)!
          if (b.current) return c.view.info(`already on ${name}`)
          c.openDialog({
            title: name,
            options: [
              { label: "Switch to it", value: "switch", description: "uncommitted changes come along when git can carry them" },
              { label: "Delete it", value: "delete", description: "only if its work is merged (git branch -d)" },
              { label: "Cancel", value: "no" },
            ],
            onSelect: (v) => {
              if (v === "switch") return go(name)
              if (v !== "delete") return
              const r = deleteBranch(root, name)
              c.view.info(r.text, r.ok ? undefined : "warn")
            },
          })
        },
      })
    },
  },
  {
    name: "commit",
    args: "[message | all]",
    description: "commit this session's changes (or what is staged) — the model drafts the message",
    async run(c, arg) {
      const root = c.app.project.gitRoot
      if (!root) return c.view.info("not a git repository — create one with git init", "warn")
      const all = arg === "all"
      const plan = commitPlan(root, c.app.turns.touched(), all)
      if (!plan.files.length) return c.view.info(all ? "nothing to commit" : "nothing this session changed is uncommitted — /commit all takes every change", "warn")
      const confirm = (message: string) =>
        c.openDialog({
          title: `Commit ${plan.files.length} file${plan.files.length > 1 ? "s" : ""}${plan.staged ? " (as staged)" : ""}?`,
          options: [
            { label: "Commit", value: "yes", description: message.split("\n")[0] },
            { label: "Cancel", value: "no", description: "type /commit <your message> to write it yourself" },
          ],
          onSelect: (v) => {
            if (v !== "yes") return c.view.info("not committed")
            const r = commit(root, plan, message)
            r.ok ? c.view.info(`committed ${r.text}`) : c.view.info(`commit failed: ${r.text}`, "warn")
            c.refresh()
          },
        })
      if (arg && !all) return confirm(arg)
      c.view.info(`drafting a message for: ${plan.files.join(", ")}`)
      try {
        const message = await draftMessage(c.app.small().client, root, plan)
        if (!message) return c.view.info("the model returned no message; /commit <message> writes it yourself", "warn")
        c.view.info(`proposed message:\n\n${message}`)
        confirm(message)
      } catch (e) {
        c.view.info(`could not draft a message: ${(e as Error).message}`, "warn")
      }
    },
  },
  {
    name: "context",
    description: "where the context window goes",
    run(c) {
      const e = c.app.engine
      const system = e.o.system(e.mode, e.model)
      const git = /<git>\n([\s\S]*?)\n<\/git>/.exec(system)?.[1]
      c.view.info(renderBreakdown(contextBreakdown(e, system, instructionFiles(e.o.toolCtx.cwd, c.app.project.root, c.app.loaded.instructions), git, e.o.tools)))
    },
  },
  {
    name: "compact",
    description: "summarise the conversation to free context",
    async run(c) {
      c.view.info("compacting…")
      try {
        const summary = await c.app.engine.compact()
        c.view.clear()
        c.view.info(`compacted — the model continues from this summary:\n\n${summary}`)
      } catch (e) {
        c.view.info(`compaction failed: ${(e as Error).message}`, "warn")
      }
    },
  },
  {
    name: "memory",
    description: "what is remembered across sessions — pick an entry to change or forget it",
    run(c) {
      const stores = [
        { key: "user", title: "user", store: c.app.memory, target: "user" as const },
        { key: "memory", title: "notes", store: c.app.memory, target: "memory" as const },
        ...(c.app.projectMemory ? [{ key: "project", title: "project", store: c.app.projectMemory, target: "memory" as const }] : []),
      ]
      const entries = stores.flatMap((s) => s.store.entries(s.target).map((text, i) => ({ s, text, value: `${s.key}:${i}` })))
      const files = stores.map((s) => `${s.title}: ${s.store.file(s.target)} (${s.store.usage(s.target)})`).join("\n")
      if (!entries.length) return c.view.info(`nothing remembered yet — the agent saves facts with its memory tool, or tell it "remember that …"\n${files}`)
      const change = (e: (typeof entries)[number], op: { action: "replace" | "remove"; content?: string }) => {
        const r = e.s.store.apply(e.s.target, [{ ...op, old_text: e.text }])
        c.view.info(r.ok ? `${e.s.title}: ${op.action === "remove" ? "forgotten" : "changed"} — the agent sees it from the next session (${r.usage})` : r.message, r.ok ? "info" : "warn")
      }
      c.openDialog({
        title: "Memory — enter to change or forget",
        filter: true,
        options: entries.map((e) => ({ label: `[${e.s.title}] ${e.text.replace(/\s+/g, " ").slice(0, 90)}`, value: e.value })),
        onSelect: (v) => {
          const e = entries.find((x) => x.value === v)!
          c.openDialog({
            title: e.text.replace(/\s+/g, " ").slice(0, 60),
            options: [
              { label: "Forget it", value: "remove" },
              { label: "Keep it", value: "keep" },
            ],
            onSelect: (a) => a === "remove" && change(e, { action: "remove" }),
            custom: { label: "replace with", onSubmit: (text) => change(e, { action: "replace", content: text }) },
          })
        },
      })
      c.view.info(`the files, which you can also edit by hand (entries are separated by a line with §):\n${files}`)
    },
  },
  {
    name: "skills",
    description: "list the skills; pick one to use it",
    run(c) {
      const all = c.app.skills()
      if (!all.length) return c.view.info(`no skills yet — put a <name>/SKILL.md in ~/.config/lembas/skills/, or ask the agent to save one`)
      c.openDialog({
        title: "Skills",
        options: all.map((s) => ({ label: `${s.name}${s.category ? ` · ${s.category}` : ""}${s.source === "project" ? " · project" : ""}`, value: s.name, description: s.description })),
        // Through /skill: a skill named like a built-in (review, plan…) would run that instead.
        onSelect: (name) => c.setInput(`/skill ${slug(name)} `),
      })
    },
  },
  {
    name: "skill",
    args: "<name> [instruction]",
    description: "use a skill (for one whose name a command already has)",
    run(c, arg) {
      const [name = "", ...rest] = arg.trim().split(/\s+/)
      const s = findSkill(c.app.skills(), name)
      if (!s) return c.view.info(name ? `no skill "${name}" — /skills lists them` : "usage: /skill <name> [instruction]", "warn")
      c.sendAs?.(skillMessage(s, rest.join(" ")), `/skill ${arg.trim()}`, { attachFrom: rest.join(" ") })
    },
  },
  {
    name: "personality",
    args: "[preset|custom|none]",
    description: "how the agent talks: a preset, your own (personality_custom), or none (remembered)",
    run(c, arg) {
      // The presets the web UI has; saved to the global config, so every project and session has it.
      const set = (name: string) => {
        try {
          c.app.settings.set("personality", name, "global")
          const now = c.app.loaded.config.personality
          c.view.info(now ? `personality: ${now}` : "personality: none")
          if (now === "custom" && !c.app.loaded.config.personality_custom?.trim())
            c.view.info("personality_custom is empty, so custom says nothing yet — /settings personality_custom sets it", "warn")
        } catch (e) {
          c.view.info((e as Error).message, "warn")
        }
        c.refresh()
      }
      if (arg.trim()) return set(arg.trim().toLowerCase())
      const now = c.app.loaded.config.personality || "none"
      c.openDialog({
        title: "Personality",
        options: ["none", ...PERSONALITIES].map((n) => ({
          label: n,
          value: n,
          current: n === now,
          description: n === "none" ? "just the agent" : n === "custom" ? "your own words: personality_custom" : (personalityText(n) ?? "").slice(0, 70),
        })),
        onSelect: set,
      })
    },
  },
  {
    name: "voice",
    args: "[test]",
    description: "voice input and output: what is set up; test speaks a sentence",
    async run(c, arg) {
      const v = c.app.loaded.config.voice
      if (arg.trim() === "test") {
        if (!c.voice.canSpeak) return c.view.info("voice output is not set up (voice.tts)", "warn")
        c.view.info("speaking a test sentence — esc stops it")
        return void c.voice.speak("This is LLeMbas. If you can hear this, **voice output works**.")
      }
      const rec = recorderFor(v)
      const play = playerFor(v)
      const key = keyMatcher(v?.record_key)
      const lines = [
        `input:  ${v?.stt ? `${v.stt.provider ?? "openai"} · ${v.stt.base_url ?? "?"}${v.stt.model ? ` · ${v.stt.model}` : ""}${v.stt.language ? ` · ${v.stt.language}` : ""}` : "not set up (voice.stt)"}`,
        `output: ${v?.tts ? `${v.tts.provider ?? "openai"} · ${v.tts.provider === "piper-cli" ? (v.tts.model_path ?? "?") : (v.tts.base_url ?? "?")}${v.tts.voice ? ` · ${v.tts.voice}` : ""}` : "not set up (voice.tts)"}`,
        `record: ${typeof rec === "string" ? `✗ ${rec}` : rec.join(" ")}`,
        `play:   ${typeof play === "string" ? `✗ ${play}` : `${play.join(" ")} — the program that plays speech (${PLAYER_NAMES[play[0]!] ?? "an audio player"})`}`,
        `key:    ${key.label} ${v?.record_mode === "hold" ? "(hold, or press again)" : "(press to start, again — or silence — to stop)"} · esc cancels`,
        `what you say goes ${v?.submit === "send" ? "straight to the model" : "into the prompt, to check and send"}`,
        ...(v?.tts
          ? [
              `replies are ${c.voice.speakReplies ? "spoken" : "not spoken"} — /speak turns reading replies aloud ${c.voice.speakReplies ? "off" : "on"}; /voice test says one sentence now;`,
              `        voice.speak: true in config.yaml speaks from the start · esc or ${key.label} stops speech`,
            ]
          : []),
      ]
      c.view.info(lines.join("\n") + (v ? "" : "\n\nSet it up under voice: in ~/.config/lembas/config.yaml — https://llembas.eu/docs/ has an example."))
    },
  },
  {
    name: "speak",
    args: "[on|off]",
    description: "read replies aloud (this session)",
    run(c, arg) {
      const a = arg.trim()
      if (!c.voice.canSpeak) return c.view.info("voice output is not set up (voice.tts) — /voice shows what is", "warn")
      c.voice.speakReplies = a === "on" ? true : a === "off" ? false : !c.voice.speakReplies
      if (!c.voice.speakReplies) c.voice.stopSpeaking()
      c.view.info(c.voice.speakReplies ? "replies are spoken: each one is read aloud as it arrives — esc stops it, /speak again turns it off" : "replies are not spoken")
      c.refresh()
    },
  },
  {
    name: "mcp",
    args: "[reconnect|on|off|auth|code|logout <server>]",
    description: "MCP servers: status and tools; sign in; switch one on or off",
    async run(c, arg) {
      const mcp = c.app.mcp
      const [sub = "", name = "", ...rest] = arg.trim().split(/\s+/)
      if (!sub) {
        if (!mcp.servers.size) return c.view.info("no MCP servers — add them under mcp: in ~/.config/lembas/config.yaml")
        const mark = { connected: "●", connecting: "…", disabled: "○", failed: "✗", needs_auth: c.theme().icons.locked } as const
        const lines = [...mcp.servers.values()].map((s) => {
          const head = `${mark[s.status]} ${s.name}  ${s.cfg.command !== undefined ? "local" : s.cfg.url}${s.cfg.source === "project" ? " · project" : ""} — ${s.status}${s.error ? `: ${s.error}` : ""}`
          const tools = s.status === "connected" ? s.tools.map((t) => `    ${t.name}${t.annotations?.readOnlyHint ? " (read-only)" : ""}`) : []
          const prompts = s.status === "connected" ? s.prompts.map((pr) => `    /${s.name}:${pr.name}`) : []
          return [head, ...tools, ...prompts].join("\n")
        })
        return c.view.info(`${lines.join("\n\n")}\n\nTools are named mcp__<server>__<tool> and ask before they run unless a permission rule allows them.`)
      }
      if (!name || !mcp.servers.has(name)) return c.view.info(`usage: /mcp ${sub} <server> — servers: ${[...mcp.servers.keys()].join(", ") || "(none)"}`, "warn")
      try {
        if (sub === "reconnect" || sub === "on") {
          c.view.info(`MCP ${name}: connecting…`)
          const s = sub === "on" ? await mcp.setEnabled(name, true) : await mcp.connect(name)
          if (s.status !== "connected") c.view.info(`MCP ${name}: ${s.error ?? s.status}`, "warn")
        } else if (sub === "off") {
          await mcp.setEnabled(name, false)
          c.view.info(`MCP ${name}: off for this session`)
        } else if (sub === "auth") {
          const pasted = new Promise<string>((resolve) => pendingCodes.set(name, resolve))
          const s = await mcp.auth(name, (url) => c.view.info(`Sign in to ${name} at:\n${url}\n\nThe browser is sent back to this machine (127.0.0.1). If it cannot get here, copy the address it ends on and type: /mcp code ${name} <that address>`), pasted)
          pendingCodes.delete(name)
          c.view.info(s.status === "connected" ? `MCP ${name}: signed in` : `MCP ${name}: ${s.error ?? s.status}`, s.status === "connected" ? undefined : "warn")
        } else if (sub === "code") {
          const give = pendingCodes.get(name)
          if (!give) return c.view.info(`no sign-in to ${name} is waiting — /mcp auth ${name} starts one`, "warn")
          give(rest.join(" "))
        } else if (sub === "logout") {
          mcp.logout(name)
          c.view.info(`MCP ${name}: stored sign-in removed`)
        } else c.view.info(`unknown: /mcp ${sub} — reconnect, on, off, auth, code or logout`, "warn")
      } catch (e) {
        pendingCodes.delete(name)
        c.view.info(`MCP ${name}: ${(e as Error).message}`, "warn")
      }
      c.refresh()
    },
  },
  {
    name: "login",
    args: "[address]",
    description: "sign in to a LLeMbas instance: its models, voice and search (again: read them now)",
    async run(c, arg) {
      const { codeInstructions, instances, isWebuiEntry, login, loginSummary, sync } = await import("../lembas/login.ts")
      const known = instances()
      const go = async (address: string) => {
        const again = Object.values(known).find((i) => i.base_url.replace(/^https?:\/\//, "") === address.trim().replace(/^https?:\/\//, "").replace(/\/+$/, ""))
        try {
          if (again && isWebuiEntry(again.connection)) {
            c.view.info(`${again.connection}: reading the models from ${again.base_url}…`)
            const r = await sync(again.connection)
            c.view.info(`${loginSummary(r, false).join("\n")}\n\nStarting again to load them.`)
            return c.reload()
          }
          c.view.info(`Looking for LLeMbas at ${address}…`)
          const r = await login(address, { ca: again?.ca, onCode: (start, d) => c.view.info(codeInstructions(start, d)) })
          c.view.info(`${loginSummary(r, true).join("\n")}\n\nStarting again to load them.`)
          c.reload()
        } catch (e) {
          c.view.info(`login: ${(e as Error).message}`, "warn")
        }
      }
      if (arg.trim()) return go(arg.trim())
      c.openDialog({
        title: "Log in to a LLeMbas instance",
        options: Object.values(known).map((i) => ({ label: i.base_url, value: i.base_url, description: `refresh ${i.connection}${i.email ? ` · ${i.email}` : ""}` })),
        custom: { label: "Log in to", onSubmit: (text) => void go(text) },
        onSelect: (value) => void go(value),
      })
    },
  },
  {
    name: "usage",
    description: "your account's credits on the LLeMbas instance: plan, balance, this month, this device",
    async run(c) {
      // /v1/usage of the account this machine is logged in to.
      const { accountUsage, balanceLabel, usageLines } = await import("../lembas/personal.ts")
      try {
        const r = await accountUsage()
        if (!r) return c.view.info("no usage to show — not logged in to one LLeMbas instance (/login), or it does not keep any")
        c.setCredits?.(balanceLabel(r.usage))
        c.view.info(usageLines(r.connection, r.usage).join("\n"))
      } catch (e) {
        c.view.info(`/usage: ${(e as Error).message}`, "warn")
      }
    },
  },
  {
    name: "logout",
    args: "[connection]",
    description: "sign out of a LLeMbas instance, and remove the connection login wrote",
    async run(c, arg) {
      const { instances, logout } = await import("../lembas/login.ts")
      const known = Object.keys(instances())
      const go = async (name: string) => {
        try {
          const r = await logout(name)
          c.view.info(`Signed out of ${name}${r.revoked ? "" : " here — the instance could not be told; revoke it under User → Security → Devices there"}.${r.modelLeft ? ` config.yaml still starts on ${r.modelLeft}; /model picks another.` : ""}`)
          c.reload()
        } catch (e) {
          c.view.info(`logout: ${(e as Error).message}`, "warn")
        }
      }
      if (arg.trim()) return go(arg.trim())
      if (!known.length) return c.view.info("not logged in to any LLeMbas instance — /login <address>")
      if (known.length === 1) return go(known[0]!)
      c.openDialog({ title: "Sign out of", options: known.map((k) => ({ label: k, value: k })), onSelect: (v) => void go(v) })
    },
  },
  {
    name: "settings",
    args: "[key [value [session|global|project]]]",
    description: "see and change settings — this session, the global config or the project's",
    run(c, arg) {
      const S = c.app.settings
      const set = (key: string, value: string, scope: Scope) => {
        try {
          const r = S.set(key, value, scope)
          c.view.info(r.message)
          c.flash(`${key} = ${show(r.value)}`)
        } catch (e) {
          c.view.info((e as Error).message, "warn")
        }
      }
      const askScope = (key: string, value: string) => {
        const def = findSetting(key)!
        const scopes = def.scopes.filter((sc) => sc !== "project" || c.app.trusted)
        if (scopes.length === 1) return set(key, value, scopes[0]!)
        c.openDialog({
          title: `${key} = ${value} — where?`,
          options: scopes.map((sc) => ({ label: sc, value: sc, description: sc === "session" ? "this session only" : sc === "global" ? "~/.config/lembas/config.yaml" : ".agent/config.yaml" })),
          onSelect: (sc) => set(key, value, sc as Scope),
        })
      }
      const askValue = (key: string) => {
        const e = S.get(key)
        if (e.note) c.view.info(e.note, "warn")
        const values =
          e.def.kind === "model"
            ? c.app.modelRefs()
            : e.def.kind === "effort"
              ? [...effortsFor(c.app.engine.model), "off"]
              : e.def.kind === "boolean"
                ? ["true", "false"]
                : key === "theme"
                  ? themeNames()
                  : e.def.kind === "enum"
                      ? [...(e.def.values ?? [])]
                      : []
        c.openDialog({
          title: `${key} — now ${show(e.value) || e.def.fallback || "unset"}${e.source === "default" ? "" : ` (${e.source})`}`,
          options: values.map((v) => ({ label: v, value: v, current: v === show(e.value) })),
          onSelect: (v) => askScope(key, v),
          custom: e.def.kind === "enum" || e.def.kind === "boolean" || e.def.kind === "effort" ? undefined : { label: "set to", onSubmit: (v) => askScope(key, v) },
        })
      }
      const [key, value, scope] = arg.split(/\s+/).filter(Boolean)
      if (key && !findSetting(key)) return c.view.info(`no setting ${key} — /settings lists them`, "warn")
      if (key && value) return scope ? set(key, value, scope as Scope) : askScope(key, value)
      if (key) return askValue(key)
      c.openDialog({
        title: "Settings",
        filter: true,
        options: S.list().map((e) => ({
          label: e.def.key,
          value: e.def.key,
          description: `${show(e.value) || e.def.fallback || "unset"}${e.source === "default" ? "" : ` · ${e.source}`}${e.def.reload ? " · after restart" : ""}`,
        })),
        onSelect: askValue,
      })
    },
  },
  {
    name: "kb",
    args: "[new <name> | add <name> <path|url>… | search <query>]",
    description: "knowledge bases the agent searches: list, make one, add files, directories or pages",
    async run(c, arg) {
      const lib = c.app.library
      const [verb, name, ...rest] = arg.split(/\s+/).filter(Boolean)
      try {
        if (verb === "new" && name) {
          lib.createBase(name, rest.join(" "))
          return c.view.info(`made ${name} — /kb add ${name} <files, directories, urls>`)
        }
        if (verb === "add" && name && rest.length) {
          c.view.info(`adding to ${name}…`)
          const added = await ingest(lib, name, rest, { cwd: c.app.project.root })
          const bad = added.filter((a) => a.error)
          c.view.info(`${name}: ${added.filter((a) => a.changed).length} added or changed, ${added.filter((a) => !a.changed && !a.error).length} unchanged${bad.length ? `, ${bad.length} with no text (${bad.slice(0, 3).map((a) => `${a.source.split("/").pop()}: ${a.error}`).join("; ")})` : ""}`)
          if (c.app.embedder) {
            const n = await lib.embedAll(c.app.embedder).catch((e) => (c.view.info(`embedding failed: ${(e as Error).message} — searching by words`, "warn"), 0))
            if (n) c.view.info(`embedded ${n} pieces with ${c.app.embedder.model}`)
          }
          return
        }
        if (verb === "search" && name) {
          const q = [name, ...rest].join(" ")
          const hits = await lib.search(q, { bases: c.app.engine.o.toolCtx.library?.bases, embedder: c.app.embedder }).catch(() => lib.search(q, { bases: c.app.engine.o.toolCtx.library?.bases }))
          return c.view.info(hits.length ? hits.map((h) => `[${h.id}] ${h.title} (${h.base})\n  ${h.snippet.replace(/\s+/g, " ").slice(0, 200)}`).join("\n") : "nothing found")
        }
        if (verb) return c.view.info("/kb, /kb new <name>, /kb add <name> <paths or urls>, /kb search <query>", "warn")
        const all = lib.bases()
        c.view.info(
          all.length
            ? `${all.map((b) => `${b.name} — ${b.documents} document${b.documents === 1 ? "" : "s"}${b.description ? `: ${b.description}` : ""}`).join("\n")}\nsearched by ${c.app.embedder ? `words and meaning (${c.app.embedder.model})` : "words"}; the agent uses knowledge_search and knowledge_get. lembas kb in a shell does the rest.`
            : "no knowledge bases yet — /kb new <name>, then /kb add <name> <files, directories, urls>",
        )
      } catch (e) {
        c.view.info((e as Error).message, "warn")
      }
    },
  },
  {
    name: "theme",
    aliases: ["skin"],
    args: "[name]",
    description: "colours: lembas, lembas-light, moria, shire, hermes, mono, or your own",
    run(c, arg) {
      if (arg) return c.setTheme(arg)
      c.openDialog({ title: "Theme", options: themeNames().map((n) => ({ label: n, value: n, current: n === c.theme().name })), onSelect: (n) => c.setTheme(n) })
    },
  },
  {
    name: "terminal",
    description: "what LLeMbas CLI found out about this terminal: synchronized output, clipboard, keyboard, frame rate",
    run(c) {
      const r = c.renderer
      const caps = r.capabilities
      const rate = `frame rate: ${r.targetFps}/s (at most ${r.maxFps}) · mouse: ${r.useMouse ? "LLeMbas CLI's (hold Shift for the terminal's own selection)" : "the terminal's"}`
      if (!caps) return c.view.info(`the terminal has not answered LLeMbas CLI's questions (yet), so it is treated as having none of the extras\n${rate}`)
      const yes = (b: boolean | undefined) => (b ? "yes" : "no")
      const t = caps.terminal as { name?: string; version?: string } | undefined
      c.view.info(
        [
          `terminal: ${t?.name ? `${t.name}${t.version ? ` ${t.version}` : ""}` : "did not say"}${caps.remote ? " · over SSH" : ""}`,
          `synchronized output: ${yes(caps.sync)}${caps.sync ? "" : " — frames are painted as they arrive, so fast scrolling can tear; drawing at most 12 frames a second"}`,
          rate,
          `clipboard (OSC 52): ${caps.osc52_support}`,
          `kitty keyboard: ${yes(caps.kitty_keyboard)} · true colour: ${yes(caps.rgb)}`,
        ].join("\n"),
      )
    },
  },
  {
    name: "icons",
    args: "[emoji|plain]",
    description: "pictures as emoji, or plain symbols for a terminal font without emoji (boxes with codes like 01F3A4 in them)",
    run(c, arg) {
      const set = (v: string) => {
        if (v !== "emoji" && v !== "plain") return c.view.info("/icons emoji or /icons plain", "warn")
        c.setIcons(v)
        c.view.info(`icons: ${v} (saved to config.yaml)`)
      }
      if (arg) return set(arg.trim())
      c.openDialog({
        title: "Icons",
        options: [
          { label: "emoji — 🎤 🔊 📖 💻", value: "emoji", current: c.theme().icons.mic === "🎤" },
          { label: "plain — mic ♪ » $  (for a font without emoji)", value: "plain", current: c.theme().icons.mic !== "🎤" },
        ],
        onSelect: set,
      })
    },
  },
  {
    name: "trust",
    description: "trust this project (its .agent config is then honoured — restart to apply)",
    run(c) {
      setTrust(c.app.project.root, "trusted")
      c.view.info(`${c.app.project.root} is trusted. Restart lembas to load its config.`)
    },
  },
  {
    name: "reload",
    aliases: ["restart"],
    description: "start again on this session — the installed binary (after an update) and every config file read afresh",
    run: (c) => c.reload(),
  },
  { name: "quit", aliases: ["exit", "q"], description: "leave", run: (c) => c.quit() },
]

function firstUserLine(c: CommandCtx, id: string): string {
  const m = c.app.store?.messages(id).find((x) => x.role === "user")
  if (!m || m.role !== "user") return ""
  const t = m.parts.find((p) => p.type === "text")
  return t && t.type === "text" ? t.text.split("\n")[0]!.slice(0, 60) : ""
}

export function findCommand(name: string): Command | undefined {
  return COMMANDS.find((c) => c.name === name || c.aliases?.includes(name))
}

/** The sessions /sessions offers: this project's, newest first, not the one open here — and only
 *  those somebody said something in, as `lembas sessions` and the web UI list them: every
 *  start and /new makes one, and the empty ones crowded out the rest as rows named by their id. */
function otherSessions(c: CommandCtx) {
  return c.app.store?.sessions(40, c.app.project.root, true).filter((s) => s.id !== c.app.engine.sessionId) ?? []
}

function sessionOption(c: CommandCtx, s: { id: string; title: string; updated: number; model: string }) {
  return { label: s.title || firstUserLine(c, s.id) || s.id, value: s.id, description: `${new Date(s.updated).toISOString().slice(0, 16).replace("T", " ")} · ${s.model}` }
}

/** The Resume picker. ctrl+d or Delete deletes the session under the cursor, after asking, and the
 *  picker comes back without it — so a session can be deleted where it is seen, not only with
 *  `/sessions delete`. */
function openResume(c: CommandCtx) {
  const list = otherSessions(c)
  if (!list.length) return c.view.info("no other sessions in this project")
  c.openDialog({
    title: "Resume",
    options: list.map((s) => sessionOption(c, s)),
    hint: "↑↓ move · enter resume · ctrl+d delete · esc close",
    keys: [{ when: (k) => (k.ctrl === true && k.name === "d") || k.name === "delete", run: (id) => confirmDelete(c, id, false, () => openResume(c)) }],
    onSelect: async (id) => {
      // A session the web UI runs here (the service) is let go of first, so it is carried on
      // rather than forked — or it says why it cannot be, now.
      const why = await (c.share?.release(id) ?? Promise.resolve(undefined))
      if (why) return c.view.info(`not resumed: ${why}`, "warn")
      const shown = c.app.resume(id)
      c.view.load(shown)
      c.view.info(`resumed ${id}`)
    },
  })
}

/** Delete a session after asking. The hub lets go of it first and the web UI deletes the chat
 *  it is; `current`: the one open here, so a new session takes its place. `then`: what follows,
 *  asked or not — the Resume picker opens again. */
function confirmDelete(c: CommandCtx, id: string, current = false, then?: () => void) {
  const title = c.app.store?.session(id)?.title || id
  c.openDialog({
    title: `Delete “${title.slice(0, 60)}”?`,
    options: [
      { label: "Delete", value: "yes", description: "its conversation goes, here and in the web UI; the files it changed stay" },
      { label: "Cancel", value: "no" },
    ],
    onSelect: async (v) => {
      if (v !== "yes") return then?.()
      if (current) {
        c.app.cancel()
        c.app.newSession()
        c.view.clear()
      }
      // Without a share (none in tests), the same way `lembas sessions delete` goes: the
      // instance hears of it through the hub, or later from the pending list.
      const store = c.app.store
      const why = c.share ? await c.share.deleted(id) : store ? await deleteEverywhere(store, id) : undefined
      c.view.info(why ? `not deleted: ${why}` : "deleted", why ? "warn" : "info")
      then?.()
    },
  })
}
