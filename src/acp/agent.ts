// LLeMbas CLI as an ACP agent (Agent Client Protocol, protocol version 1): `lembas serve --stdio`
// for an editor that speaks it, and — the same code — the far end of the LLeMbas link, where the
// web UI is the client.
//
// A session is an ordinary LLeMbas CLI session (createApp): the same tools, permissions, prompts and
// hardline as the TUI. What ACP adds is the plumbing: the client opens a session in a directory,
// sends prompts, and is streamed `session/update` notifications; an approval is a
// `session/request_permission` request to the client. A client that says it is LLeMbas
// (`clientCapabilities._meta.lembas`) also gets every engine event as a `_lembas/event`
// notification, so the web UI can draw what ACP has no words for (progress, usage, notices).
//
// **Limits are the device's.** On the link, `limits` comes from the device's own global `remote:`
// block: a directory outside `roots` is refused, a mode beyond `max_mode` is lowered to it, an
// untrusted project is refused, and an approval nobody answers in time is a denial. The hardline
// applies in every mode, as everywhere.
import { existsSync, readdirSync, statSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { createApp, type App, type SessionContext } from "../app.ts"
import type { AskReply, Asker, Event } from "../bus/index.ts"
import { FileIndex } from "../project/files.ts"
import { loadSkills } from "../skill/index.ts"
import { commandSet, sourcesOf, type CommandInfo } from "../session/commands.ts"
import { loadConfig } from "../config/load.ts"
import { NOBODY_TO_ASK, type Answer, type QuestionReply, type QuestionRequest } from "../tool/ask_user.ts"
import { nobodyToApprove, type PlanReply, type PlanRequest } from "../tool/plan_submit.ts"
import { realPath } from "../permission/evaluate.ts"
import type { Plan } from "../plan/plan.ts"
import type { JobInfo } from "../jobs/registry.ts"
import { PLAN_META } from "../session/engine.ts"
import { ToolError } from "../tool/tool.ts"
import { dropAttachments, preparePrompt, storedAttachments } from "./prompt.ts"
import { addPendingDeleted, clearPendingDeleted, pendingDeleted } from "./pending.ts"
import { shellLaunch } from "./shellrc.ts"
import { sessionTurnFile, sessionTurns, TurnLog } from "./turns.ts"
import { expandHome } from "../config/paths.ts"
import { asMode, EFFORTS, MODES, type Effort, type Mode } from "../config/schema.ts"
import { HARNESS_VERSION } from "../harness.ts"
import { findProject, trustedRoots, trustedWithin, trustOf } from "../project/root.ts"
import { VERSION } from "../version.ts"
import { CWD_META, REMOTE_META, Store } from "../session/store.ts"
import type { Message } from "../provider/types.ts"
import type { Hub } from "./hub.ts"
import { INVALID_PARAMS, METHOD_NOT_FOUND, RpcError, type Peer } from "./rpc.ts"
import { jobList, jobOutput, jobSend, jobStop, jobTranscript, storedJobs } from "./jobs.ts"

export const ACP_VERSION = 1
/** The `_lembas/*` extension's version (LLeMbas `api/devices.py:PROTOCOL`). 2: every
 *  feature beyond 1 is also named in `capabilities`, so a protocol 1 peer keeps working with
 *  what it knows (harness/acp.md). */
export const LEMBAS_PROTOCOL = 2

export interface Limits {
  /** Directories a session may be opened in (and anything under them). Empty: none at all. */
  roots: string[]
  /** The most permissive mode a session may run in. */
  maxMode: Mode
  /** How long an approval waits before it counts as a denial. */
  approvalTimeoutMs: number
  /** Only trusted projects (their .agent config honoured). */
  requireTrust: boolean
  /** A terminal may be opened from the web UI (`remote.terminal`). Absent: no. */
  terminal?: boolean
  /** Its shell marks prompts, commands and the directory (`remote.terminal_integration`).
   *  Absent: yes. */
  terminalIntegration?: boolean
  /** `remote.enabled`, where the limits are the device's (the link, the service's hub). False:
   *  nothing new is opened or shared, whatever the roots say. Absent: not judged here. */
  enabled?: boolean
  /** The link a terminal holds for /remote on a machine whose remote work is off: only
   *  the sessions shared from that terminal can be reached; the web UI opens none of its own. */
  sharedOnly?: boolean
}

/** Why a remote session may not be opened in `dir` under these limits, or undefined when it may. */
export function refusalFor(L: Limits | undefined, dir: string): string | undefined {
  if (!L) return undefined
  if (L.sharedOnly) return "remote work is off on this machine (remote.enabled); only the sessions its terminal shares (/remote) can be reached"
  if (L.enabled === false) return "remote work is off on this machine — lembas remote enable there (remote.enabled)"
  if (!L.roots.length) return "this device allows no folders for remote work yet — lembas remote add <dir> there (remote.roots)"
  if (!underRoots(dir, L.roots)) return `${dir} is outside the directories this device accepts remote work in (remote.roots)`
  if (L.requireTrust && trustOf(findProject(dir).root) !== "trusted" && !trustedWithin(realPath(dir)))
    return `${dir} is not in a trusted project on this device — trust it there first (lembas trust)`
  return undefined
}

/** The session_meta key saying a session has been in the web UI's hands: made by the link,
 *  opened by it from the store, or shared to it from a terminal. Such a session stays deletable
 *  from the web UI whatever becomes of its directory's trust — see deletableFor. */
export { REMOTE_META }

/** Why the instance may not delete this session, or undefined when it may.
 *
 *  Not `refusalFor`, the rule for *opening* a session: that rule asks for trust
 *  (remote.require_trust), which a delete has no use for — deleting a session's rows runs nothing in
 *  its directory, reads none of its project's config, starts none of its MCP servers. Judged by it,
 *  a delete would be refused for exactly the sessions the web UI had shown as chats: one shared by
 *  name (/remote) from a directory that is not trusted, once its terminal had let go of it; or one
 *  the web UI started in a trusted subdirectory of an untrusted project, whose stored root is that
 *  project's. The chat would be deleted, the refusal go nowhere, and the session stay in /sessions.
 *
 *  So: a session the web UI holds or a terminal shares now, or one marked as having been in its
 *  hands (REMOTE_META), may be deleted. Any other — from before the mark, or never shown — only
 *  inside remote.roots, and never on a machine whose remote work is off: the instance cannot list
 *  sessions, and is not given a way to reach one it has never been shown outside where it works. */
export function deletableFor(L: Limits | undefined, root: string, shown: boolean): string | undefined {
  if (!L || shown) return undefined
  if (L.sharedOnly) return "remote work is off on this machine (remote.enabled); only the sessions its terminal shares (/remote) can be reached"
  if (L.enabled === false) return "remote work is off on this machine — lembas remote enable there (remote.enabled)"
  if (!underRoots(root, L.roots)) return `${root} is outside the directories this device accepts remote work in (remote.roots)`
  return undefined
}

/** Mark a session as having been in the web UI's hands (REMOTE_META). Never in the way of what
 *  is being done: a store that cannot be written to only loses the mark. */
export function markRemote(store: Store | undefined, id: string | undefined) {
  if (!store || !id) return
  try {
    store.setMeta(id, REMOTE_META, true)
  } catch {}
}

/** One shell the web UI opened here. */
interface Terminal {
  proc: ReturnType<typeof Bun.spawn>
  pty: { write(d: string | Uint8Array): void; resize(cols: number, rows: number): void; close?(): void }
  /** The rc files its shell integration was given, removed with it. */
  cleanup(): void
}

/** Most terminals one link may hold at once. */
const MAX_TERMINALS = 4

/** An effort as the instance sends it: a level, or "off"; anything else is not one. */
export function effortOf(v: unknown): Effort | "off" | undefined {
  if (v === "off" || v === "" || v === null) return "off"
  return typeof v === "string" && (EFFORTS as readonly string[]).includes(v) ? (v as Effort) : undefined
}

const MODE_RANK: Record<Mode, number> = { auto: 0, edit: 1, manual: 2, plan: 3 }
export function clampMode(wanted: Mode, max: Mode): Mode {
  return MODE_RANK[wanted] < MODE_RANK[max] ? max : wanted
}

export function underRoots(dir: string, roots: string[]): boolean {
  // Symlinks followed (realPath), so a link inside a root that points out of it is outside.
  const target = realPath(dir)
  return roots.some((r) => {
    const root = realPath(expandHome(r))
    const rel = relative(root, target)
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
  })
}

/** The ACP tool kind for a LLeMbas CLI tool, for the client's icon. */
export function toolKind(name: string): string {
  if (["read", "list", "view_image"].includes(name)) return "read"
  if (["write", "edit", "multiedit", "apply_patch"].includes(name)) return "edit"
  if (["glob", "grep", "session_search", "knowledge_search", "notes_search"].includes(name)) return "search"
  if (["bash", "job_stop"].includes(name)) return "execute"
  if (["job_output", "job_list"].includes(name)) return "read"
  if (["web_fetch", "web_search"].includes(name)) return "fetch"
  // A message between agents (job_send, report) is nothing the kinds name.
  return "other"
}

export interface Session {
  id: string
  app: App
  cwd: string
  prompting: boolean
  /** The link's agent passing its events on and asking its approvals now: with the hub,
   *  a session outlives the link it was started on, and the next link takes it over. */
  agent?: AcpAgent
  off?: () => void
  /** Prompts that came while it worked: they wait their turn instead of being refused. */
  queue?: Promise<unknown>
  /** Its turns by id: a prompt sent twice runs once. */
  turns: TurnLog<PromptResult>
  /** The command set last sent to the client, to send it again only when it changed. */
  commands?: string
}

/** What `session/prompt` answers. */
export type PromptResult = { stopReason: string; _meta?: { lembas: Record<string, unknown> } }

/** A prompt's text only, for a terminal of an older build that takes no blocks. */
function promptText(blocks: unknown): string {
  if (!Array.isArray(blocks)) throw new RpcError(INVALID_PARAMS, "prompt must be an array of content blocks")
  return (blocks as any[])
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n\n")
    .trim()
}

/** A session's turn log: one file, the service's and every terminal's. */
const turnStore = (sessionId: string) => sessionTurnFile<PromptResult>(sessionId)
const turnLog = (sessionId: string) => sessionTurns<PromptResult>(sessionId)

/** `Context` (harness/acp.md): what the client holds for a session, read from `_meta.lembas` of
 *  `session/new` and `session/prompt`. Undefined when none of its fields is there (a prompt's
 *  `_meta.lembas` with a turnId alone changes nothing); fields the client leaves out are unset. */
export function contextOf(meta: any): SessionContext | undefined {
  const m = meta?.lembas
  if (!m || typeof m !== "object") return undefined
  const out: SessionContext = {}
  const str = (v: unknown) => (typeof v === "string" ? v : "")
  if (typeof m.system_prompt === "string") out.instructions = m.system_prompt
  if (m.personalization === null) out.personalization = null
  else if (m.personalization && typeof m.personalization === "object")
    out.personalization = { personality: str(m.personalization.personality), personality_custom: str(m.personalization.personality_custom), instructions: str(m.personalization.instructions) }
  // `library` (an instance's knowledge bases, 1.1.0) is not read: the CLI's knowledge bases are its
  // own (spec 3.0.0), and a 3.0.0 instance sends none.
  if (m.prototypes && typeof m.prototypes === "object") out.prototypes = { offered: m.prototypes.offered === true, sources: str(m.prototypes.sources) }
  return Object.keys(out).length ? out : undefined
}

/** The `plan` session update: ACP's flat entries for an editor, the structure for the web UI
 *  (`_meta.lembas.plan`, null when cleared). */
export function planUpdate(plan: Plan | null | undefined) {
  const entries = (plan?.phases.flatMap((p) => p.tasks) ?? []).map((t) => ({
    content: t.text,
    status: t.status === "done" || t.status === "dropped" ? "completed" : t.status === "doing" ? "in_progress" : "pending",
    priority: "medium",
  }))
  return { sessionUpdate: "plan", entries, _meta: { lembas: { plan: plan ?? null } } }
}

/** The turn id the web UI gave a prompt, or a new one. */
export function turnIdOf(p: any): string {
  const id = p?._meta?.lembas?.turnId
  return typeof id === "string" && id.trim() ? id.trim().slice(0, 100) : crypto.randomUUID()
}

/** What every client is told this build answers of the `_lembas/*` extension — the web UI offers
 *  only what works here instead of finding out from a method-not-found. */
export const CAPABILITIES = [
  "directories",
  "configure",
  "steer",
  // A session id lasts — across a restart here or there it is opened from the store again — and
  // the terminals' sessions are announced and reachable.
  "sessions",
  // The session's own state is asked here rather than guessed from the instance's rows; deleting,
  // compacting and naming it reach the one session both sides show.
  "status",
  "delete",
  "compact",
  "title",
  // Protocol 2: @ file search, the command set, images and files in a prompt, ask_user and
  // plan_submit answered from the web, the model event, turn ids.
  "files",
  "commands",
  "attachments",
  "ask",
  "plan",
  "model",
  "turns",
  // Harness spec 1.1.0: what only the client knows comes with the session (its instructions,
  // personalization, library scope, prototypes), the plan travels as a structure, library calls
  // carry the chat's scope, and a client may rewind a session.
  "context",
  "library",
  "prototypes",
  "plan_state",
  "rewind",
  // Harness spec 2.0.0: the session's background jobs — the `job` and `job_note` events, the
  // `_lembas/jobs` and `_lembas/job/*` methods, `jobs` in `status`, `job` on an approval, and a
  // note's turn marked `machine`.
  "jobs",
  // Harness spec 3.0.0: the show tool, offered in a session the client opened when the client
  // said it can show files; the device sends the file with `_lembas/show`.
  "show",
] as const
export const STOP: Record<string, string> = { stop: "end_turn", steps: "max_turn_requests", budget: "max_tokens", cancelled: "cancelled", error: "end_turn" }

type AskRequest = Parameters<Asker["ask"]>[0]

/** `session/request_permission`'s params for an approval — the same card whichever process asks
 *  (the hub for a session a terminal runs). `patient`: a person may answer at the terminal
 *  too, so the instance waits rather than timing the card out. */
export function permissionParams(sessionId: string, req: AskRequest, o: { patient?: boolean; toolCallId?: string } = {}) {
  const offerAlways = !req.request.alwaysAsk
  return {
    sessionId,
    toolCall: {
      toolCallId: o.toolCallId ?? crypto.randomUUID(),
      title: req.request.command ?? req.tool,
      kind: toolKind(req.tool),
      status: "pending",
      rawInput: req.args,
      ...(req.preview?.diff ? { content: [{ type: "content", content: { type: "text", text: req.preview.diff } }] } : {}),
    },
    options: [
      { optionId: "once", kind: "allow_once", name: "Allow once" },
      ...(offerAlways ? [{ optionId: "session", kind: "allow_always", name: "Always, this session" }] : []),
      { optionId: "deny", kind: "reject_once", name: "Deny" },
    ],
    _meta: {
      lembas: {
        reason: req.decision.reason,
        purpose: req.purpose,
        always: req.decision.always ?? req.request.always,
        ...(o.patient ? { patient: true } : {}),
        // Which subagent asks (capability jobs), so the card can say — it may ask while the session itself is idle.
        ...(req.source ? { job: { id: req.source.jobId, agent: req.source.agent, description: req.source.description } } : {}),
      },
    },
  }
}

/** The client's answer to that, as the engine's reply. */
export function replyFrom(answer: any, offerAlways: boolean): AskReply {
  const chosen = answer?.outcome?.outcome === "selected" ? String(answer.outcome.optionId) : "deny"
  const command = typeof answer?._meta?.lembas?.command === "string" ? answer._meta.lembas.command : undefined
  if (chosen === "once") return command ? { kind: "once", command } : { kind: "once" }
  if (chosen === "session" && offerAlways) return { kind: "session" }
  const feedback = typeof answer?._meta?.lembas?.feedback === "string" ? answer._meta.lembas.feedback : undefined
  return feedback ? { kind: "deny", feedback } : { kind: "deny" }
}

/** `_lembas/question`'s params: the ask_user card, keyed by its tool call. */
/** The longest option label LLeMbas shows (it cuts the rest); the card gets labels this long, the
 *  model's answer the whole of each one chosen (questionReplyFrom). */
export const LABEL_MAX = 240

export function questionParams(sessionId: string, req: QuestionRequest, toolCallId: string | undefined, o: { patient?: boolean } = {}) {
  const questions = req.questions.map((q) => ({ ...q, options: q.options.map((x) => ({ ...x, label: x.label.slice(0, LABEL_MAX) })) }))
  return { sessionId, toolCallId: toolCallId ?? crypto.randomUUID(), ...(req.why ? { why: req.why } : {}), questions, _meta: { lembas: o.patient ? { patient: true } : {} } }
}

/** `_lembas/plan`'s params: the plan_submit card, with the plan's markdown and its structure
 *  (capability `plan_state`; a client without it draws `text`). */
export function planParams(sessionId: string, req: PlanRequest, toolCallId: string | undefined, o: { patient?: boolean } = {}) {
  return { sessionId, toolCallId: toolCallId ?? crypto.randomUUID(), path: req.path, text: req.text, plan: req.plan, _meta: { lembas: o.patient ? { patient: true } : {} } }
}

/** The client's answer to `_lembas/question`, as the tool's reply. Anything else is a dismissal. */
export function questionReplyFrom(answer: any, req: QuestionRequest): QuestionReply {
  if (answer?.outcome !== "answered" || !Array.isArray(answer.answers)) return { dismissed: true }
  const answers: Answer[] = []
  for (const [i, a] of (answer.answers as any[]).entries()) {
    if (i >= req.questions.length) break
    if (a?.kind === "options" && Array.isArray(a.labels)) {
      // A label cut for the card is the option's whole label again.
      const full = (l: string) => req.questions[i]!.options.find((x) => x.label === l)?.label ?? req.questions[i]!.options.find((x) => x.label.slice(0, LABEL_MAX) === l)?.label ?? l
      answers[i] = { kind: "options", labels: a.labels.filter((l: unknown): l is string => typeof l === "string").map(full) }
    }
    else if ((a?.kind === "custom" || a?.kind === "back") && typeof a.text === "string") answers[i] = { kind: a.kind, text: a.text }
    // A question left blank (the card says one may be): a hole, which the tool's reply reads as
    // "(no answer)" -- not the whole card dismissed, which lost the answers given beside it.
    // `null` is read the same way, from a LLeMbas that sent that before `skipped` was agreed.
    else if (a === null || a?.kind === "skipped") continue
    else return { dismissed: true }
  }
  return { answers }
}

/** The client's answer to `_lembas/plan`. `maxMode`: the device's limit — an approval cannot put
 *  the session in a mode beyond it; where even manual is beyond it, nothing is decided. */
export function planReplyFrom(answer: any, maxMode?: Mode): PlanReply {
  if (answer?.outcome === "approve") {
    const wanted: Mode = answer.mode === "manual" ? "manual" : "edit"
    const mode = maxMode ? clampMode(wanted, maxMode) : wanted
    return mode === "edit" || mode === "manual" ? { kind: "approve", mode } : { kind: "dismissed" }
  }
  if (answer?.outcome === "revise" && typeof answer.feedback === "string" && answer.feedback.trim()) return { kind: "revise", feedback: answer.feedback.trim() }
  return { kind: "dismissed" }
}

/** Text the expander added to a user message (an @file, an image, a listing, a `!` command's output). */
const ATTACHMENT = /^<(file|directory|shell|image) /

/** A stored session as turns the web UI can draw: each person's message, then what the
 *  model said, thought and ran in answer, up to the next one. A message's attachments are chips,
 *  not text. */
export function historyTurns(messages: Message[], cwd = "") {
  type Tool = { id: string; name: string; args: string; output?: string; isError?: boolean }
  type Turn = { role: "user"; text: string; turnId?: string; attachments?: ReturnType<typeof storedAttachments> } | { role: "assistant"; text: string; reasoning: string; tools: Tool[] }
  const turns: Turn[] = []
  let reply: Extract<Turn, { role: "assistant" }> | undefined
  const calls = new Map<string, Tool>()
  for (const m of messages) {
    if (m.role === "user") {
      reply = undefined
      const texts = m.parts.map((p) => (p.type === "text" ? p.text : ""))
      const text = texts.filter((t) => !ATTACHMENT.test(t)).join("\n").trim()
      const attachments = storedAttachments(texts, cwd)
      if (text || attachments.length) turns.push({ role: "user", text, ...(m.turnId ? { turnId: m.turnId } : {}), ...(attachments.length ? { attachments } : {}) })
      continue
    }
    if (!reply) {
      reply = { role: "assistant", text: "", reasoning: "", tools: [] }
      turns.push(reply)
    }
    if (m.role === "assistant") {
      for (const p of m.parts) {
        if (p.type === "text") reply.text += p.text
        else if (p.type === "reasoning") reply.reasoning += p.text
        else if (p.type === "tool_call") {
          const t: Tool = { id: p.id, name: p.name, args: p.args }
          calls.set(p.id, t)
          reply.tools.push(t)
        }
      }
    } else {
      const t = calls.get(m.callId)
      if (t) {
        t.output = m.content.slice(0, 20_000)
        t.isError = m.isError === true
      }
    }
  }
  return turns
}

export class AcpAgent {
  private sessions: Map<string, Session>
  private terminals = new Map<string, Terminal>()
  private lembas = false
  /** The `_lembas` protocol the client says it speaks (`clientCapabilities._meta.lembas.protocol`):
   *  question and plan cards only for 2 or later — a client may say `lembas` and have neither. */
  private clientProtocol = 1
  private get cards() {
    return this.lembas && this.clientProtocol >= 2
  }
  /** The client shows files (`show: true` in `clientCapabilities._meta.lembas`, spec 3.0.0): the
   *  show tool is offered in the sessions it opens, and nowhere else. */
  private shows = false
  /** initialize has been answered: notifications about sessions may go out from now on. */
  private ready = false

  constructor(
    private peer: Peer,
    private limits?: Limits,
    /** On the link: the connection that is the instance on the other end (the login's webui
     *  connection), so a model the instance names (`deepseek-flash`) is `example/deepseek-flash`
     *  here. */
    private instanceConnection?: string,
    /** The hub: sessions the terminals here run, reached through it. */
    private hub?: Hub,
    /** The `_lembas` protocol this link says: 2 where the instance speaks it, else 1. */
    private protocol: number = LEMBAS_PROTOCOL,
  ) {
    peer.handle("initialize", (p) => this.initialize(p))
    peer.handle("authenticate", () => ({}))
    peer.handle("session/new", (p) => this.newSession(p))
    peer.handle("session/prompt", (p) => this.prompt(p))
    peer.handle("session/set_mode", (p) => this.setMode(p))
    peer.handle("_lembas/directories", (p) => this.directories(p))
    peer.handle("_lembas/configure", (p) => this.configure(p))
    peer.handle("_lembas/steer", (p) => this.steer(p))
    peer.handle("_lembas/session/history", (p) => this.history(p))
    peer.handle("_lembas/session/status", (p) => this.status(p))
    peer.handle("_lembas/session/delete", (p) => this.deleteSession(p))
    peer.handle("_lembas/session/compact", (p) => this.compact(p))
    peer.handle("_lembas/session/title", (p) => this.retitle(p))
    peer.handle("_lembas/session/rewind", (p) => this.rewind(p))
    peer.handle("_lembas/terminal/open", (p) => this.terminalOpen(p))
    peer.handle("_lembas/files/search", (p) => this.filesSearch(p))
    peer.handle("_lembas/commands", (p) => this.commands(p))
    peer.handle("_lembas/jobs", (p) => this.jobs(p))
    peer.handle("_lembas/job/output", (p) => this.job("output", p))
    peer.handle("_lembas/job/stop", (p) => this.job("stop", p))
    peer.handle("_lembas/job/send", (p) => this.job("send", p))
    peer.handle("_lembas/job/transcript", (p) => this.job("transcript", p))
    peer.on("_lembas/terminal/input", (p) => this.terminalInput(p))
    peer.on("_lembas/terminal/resize", (p) => this.terminalResize(p))
    peer.on("_lembas/terminal/close", (p) => this.terminalClose(String(p?.terminalId ?? "")))
    peer.on("session/cancel", (p) => this.cancel(p))
    // With the hub (the service), the sessions are its, not this link's: a link that drops
    // and comes back -- the instance updated, the network blinked -- finds them still working, and
    // the instance follows them again instead of losing the turn. Without it (`serve --stdio`), the
    // sessions end with the client.
    this.sessions = hub?.held ?? new Map()
    for (const s of this.sessions.values()) this.adopt(s)
    hub?.attach(this)
    peer.onClose(() => {
      hub?.detach(this)
      if (!hub) for (const s of this.sessions.values()) s.app.cancel()
      for (const id of [...this.terminals.keys()]) this.terminalClose(id)
    })
  }

  private initialize(p: any) {
    const said = p?.clientCapabilities?._meta?.lembas
    this.lembas = Boolean(said)
    this.clientProtocol = typeof said?.protocol === "number" ? said.protocol : 1
    this.shows = said?.show === true
    for (const s of this.sessions.values()) if (s.agent === this) this.equipShow(s)
    // The sessions this link took over (the hub's) get their command set once the client
    // knows the agent — after this answer, not before it.
    setTimeout(() => {
      this.ready = true
      for (const s of this.sessions.values()) if (s.agent === this) this.sendCommands(s, true)
      for (const t of this.hub?.shared.values() ?? []) if (t.commands) this.commandsShared(t.sessionId, t.commands)
      this.flushDeleted()
    }, 0)
    return {
      protocolVersion: ACP_VERSION,
      agentCapabilities: {
        // Not ACP's session/load (that replays the history as updates): a session id the instance
        // kept is simply prompted again, and opened from the store here when it is not in memory.
        loadSession: false,
        // Images and files in a prompt, stored as the TUI stores a paste.
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        mcpCapabilities: { http: false, sse: false },
      },
      authMethods: [],
      agentInfo: { name: "LLeMbas CLI", version: VERSION },
      _meta: {
        lembas: {
          protocol: this.protocol,
          harness_spec: HARNESS_VERSION,
          limits: this.limits ? { roots: this.limits.roots, max_mode: this.limits.maxMode } : null,
          // The login's connection: a `model` event's ref `<connection>/<name>` is the
          // instance's own model `<name>`; any other ref is one only this device has.
          connection: this.instanceConnection ?? null,
          // "terminal" and "shell" (a terminal says its shell and whether its prompts
          // are marked) only where remote.terminal allows a terminal at all.
          capabilities: [...CAPABILITIES, ...(this.limits?.terminal ? ["terminal", "shell"] : [])],
        },
      },
    }
  }

  /** Why a remote session may not be opened in `dir`, or undefined when it may. */
  refusal(dir: string): string | undefined {
    return refusalFor(this.limits, dir)
  }

  /** `_lembas/directories`: what the web UI offers when a chat is pointed at this device.
   *  Without a path: the places — the remote roots and every trusted directory inside them. With one:
   *  its subdirectories. Each says whether a session may be opened there, by the same rule
   *  session/new applies; the device still decides when the session is asked for. */
  private directories(p: any) {
    const L = this.limits
    if (!L) throw new RpcError(INVALID_PARAMS, "directories are offered on the LLeMbas link only")
    const describe = (dir: string) => {
      const why = this.refusal(dir)
      return { path: dir, name: basename(dir) || dir, accepted: !why, ...(why ? { reason: why } : {}) }
    }
    const wanted = typeof p?.path === "string" ? p.path.trim() : ""
    if (!wanted) {
      const roots = L.roots.map((r) => resolve(expandHome(r)))
      const places = [...new Set([...roots, ...trustedRoots().filter((t) => underRoots(t, L.roots))])].filter((d) => existsSync(d) && statSync(d).isDirectory())
      return { path: "", places: places.sort().map(describe) }
    }
    if (!isAbsolute(expandHome(wanted))) throw new RpcError(INVALID_PARAMS, "an absolute path, please")
    const dir = resolve(expandHome(wanted))
    if (!underRoots(dir, L.roots)) throw new RpcError(INVALID_PARAMS, `${dir} is outside the directories this device accepts remote work in (remote.roots)`)
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new RpcError(INVALID_PARAMS, `${dir} is not a directory on this machine`)
    let entries: ReturnType<typeof describe>[] = []
    let error: string | undefined
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        // Hidden directories and node_modules are left out of the list; a path typed by hand still works.
        .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules")
        .map((d) => d.name)
        .sort((a, b) => a.localeCompare(b))
        .slice(0, 300)
        .map((name) => describe(resolve(dir, name)))
    } catch (e) {
      error = (e as Error).message
    }
    const up = dirname(dir)
    return { ...describe(dir), parent: up !== dir && underRoots(up, L.roots) ? up : "", entries, ...(error ? { error } : {}) }
  }

  private newSession(p: any) {
    const cwd = typeof p?.cwd === "string" ? expandHome(p.cwd) : ""
    if (!cwd || !isAbsolute(cwd)) throw new RpcError(INVALID_PARAMS, "cwd must be an absolute path")
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new RpcError(INVALID_PARAMS, `${cwd} is not a directory on this machine`)
    const refused = this.refusal(cwd)
    if (refused) throw new RpcError(INVALID_PARAMS, refused)
    const L = this.limits
    const wanted = asMode(p?._meta?.mode) ?? undefined
    const mode = L ? clampMode(wanted ?? L.maxMode, L.maxMode) : wanted
    const session: Session = { id: "", cwd, prompting: false, app: undefined as unknown as App, turns: new TurnLog() }
    // No model-made title: the client names its own conversations (LLeMbas has its chat's), and a
    // title request would be a second call on the account's credits for nothing.
    // The chat's model and effort: `lembas_model` is the instance's own name for it, the
    // one its /v1 serves; `model` a ref of this machine's, for an editor that knows them.
    const model = this.refFor(p?._meta?.lembas_model) ?? (typeof p?._meta?.model === "string" ? p._meta.model : undefined)
    const effort = effortOf(p?._meta?.effort)
    session.app = createApp({ cwd, mode, asker: this.asker(session), modelTitles: false, model, ...(effort !== undefined ? { effort } : {}) })
    // The store's id: the same session the terminals here list and can open.
    const id = session.app.engine.sessionId ?? crypto.randomUUID()
    session.id = id
    session.turns = turnLog(id)
    markRemote(session.app.store, id)
    // The client's chat: its memory calls land in that chat's data group (acp.md *Memory*).
    session.app.setScope(id)
    this.takeContext(session, p)
    this.sessions.set(id, session)
    this.adopt(session)
    // After the answer that names the session, so the client knows whose commands they are
    // (and whose plan, where the session has one).
    setTimeout(() => (this.sendCommands(session, true), this.sendPlan(session)), 0)
    return {
      sessionId: id,
      modes: { currentModeId: session.app.engine.mode, availableModes: this.modes().map((m) => ({ id: m, name: m })) },
      _meta: { lembas: { model: session.app.engine.model.ref, mode: session.app.engine.mode, effort: session.app.engine.effort ?? "off" } },
    }
  }

  /** Whether a model spoken to through `connection` is this link's instance's. */
  isInstance(connection: string | undefined): boolean {
    return Boolean(connection && this.instanceConnection && connection === this.instanceConnection)
  }

  /** A model the instance names, as a ref on its connection here; undefined when there is none.
   *  `<login>/<served>` resolves to the served model under its ref now (`deepseek/x` for the
   *  served `deepseek/x`; the instance's `<login>/<served>` where a connection of the user's own
   *  has the provider's name), and to the same model for a bare id from an instance that does not speak protocol 2. */
  private refFor(served: unknown): string | undefined {
    if (typeof served !== "string" || !served.trim() || !this.instanceConnection) return undefined
    return `${this.instanceConnection}/${served.trim()}`
  }

  /** `_lembas/configure`: the chat's model or effort changed on the instance between two
   *  prompts. The model first, since switching sets the new model's default effort. */
  private configure(p: any) {
    const t = this.terminalFor(p)
    if (t) return t.client.request("hub/configure", { sessionId: t.sessionId, model: this.refFor(p?.model), effort: p?.effort }, 30_000)
    const s = this.get(p)
    const ref = this.refFor(p?.model)
    if (ref && s.app.canonicalRef(ref) !== s.app.engine.model.ref) s.app.switchModel(ref)
    const effort = effortOf(p?.effort)
    if (effort !== undefined) s.app.engine.effort = effort === "off" ? null : effort
    return { model: s.app.engine.model.ref, effort: s.app.engine.effort ?? "off" }
  }

  private modes(): Mode[] {
    const max = this.limits?.maxMode
    return max ? MODES.filter((m) => MODE_RANK[m] >= MODE_RANK[max]) : [...MODES]
  }

  private get(p: any): Session {
    const id = String(p?.sessionId ?? "")
    const s = this.sessions.get(id) ?? this.load(id)
    if (!s) throw new RpcError(INVALID_PARAMS, "no such session")
    return s
  }

  /** A session this machine has in its store but not in memory: after a restart of either
   *  side, or one a terminal had open and let go of. Opened under the same rules as a new one. */
  private load(id: string): Session | undefined {
    if (!id || !this.lembas) return undefined
    let row: ReturnType<Store["session"]>
    try {
      row = (this.store ??= new Store()).session(id)
    } catch {
      return undefined
    }
    if (!row || !existsSync(row.root)) return undefined
    // Where it was started, not its project's root: judged by the rule a new session there
    // was, so one started in a trusted subdirectory of an untrusted project opens again.
    const dir = this.workdirOf(row)
    const refused = this.refusal(dir)
    if (refused) throw new RpcError(INVALID_PARAMS, refused)
    const L = this.limits
    const session: Session = { id, cwd: dir, prompting: false, app: undefined as unknown as App, turns: turnLog(id) }
    session.app = createApp({ cwd: dir, ...(L ? { mode: L.maxMode } : {}), asker: this.asker(session), modelTitles: false, resuming: id })
    session.app.resume(id)
    markRemote(session.app.store, id)
    session.app.setScope(id)
    if (L) session.app.engine.mode = clampMode(session.app.engine.mode, L.maxMode)
    this.sessions.set(id, session)
    this.adopt(session)
    setTimeout(() => (this.sendCommands(session, true), this.sendPlan(session)), 0)
    return session
  }

  /** The client's context for the session (`_meta.lembas` of session/new or session/prompt),
   *  the newer replacing the older. */
  private takeContext(s: Session, p: any) {
    const ctx = contextOf(p?._meta)
    if (ctx) s.app.setContext(ctx, this.instanceConnection)
  }

  /** The session's plan, as a `plan` update — after session/new and after opening from the
   *  store, when it has one (a change is forwarded as it happens). */
  private sendPlan(s: Session) {
    if (!this.ready || this.peer.isClosed || s.agent !== this) return
    const plan = s.app.engine.plan
    if (plan) this.update(s, planUpdate(plan))
  }

  /** This link passes the session's events on, and asks its approvals. */
  private adopt(s: Session) {
    s.off?.()
    s.agent = this
    this.equipShow(s)
    s.off = s.app.bus.on((e) => {
      if (s.agent !== this) return
      this.forward(s, e)
      // A turn can change the set (skill_manage made a skill, a command file was written).
      if (e.type === "task" && e.state === "end") this.sendCommands(s)
    })
  }

  /** The show tool's display, for a session this link holds: the client's viewer, reached with
   *  `_lembas/show`, where the client said it shows files; otherwise none, and show is not offered. */
  private equipShow(s: Session) {
    const ctx = s.app.engine.o.toolCtx
    if (!this.shows) return void delete ctx.show
    ctx.show = async (req, callId) => {
      if (s.agent !== this || this.peer.isClosed) return { shown: false, reason: "the client is not connected" }
      const r = (await this.peer.request("_lembas/show", { sessionId: s.id, toolCallId: callId ?? "", ...req }, 30_000)) as { shown?: unknown; reason?: unknown } | undefined
      return r?.shown === true ? { shown: true } : { shown: false, reason: typeof r?.reason === "string" && r.reason ? r.reason : "the client did not show it" }
    }
  }

  /** `available_commands_update`: the session's command set, when it changed (or always). */
  private sendCommands(s: Session, always = false) {
    if (!this.ready || this.peer.isClosed || s.agent !== this) return
    let list: CommandInfo[]
    try {
      list = commandSet(sourcesOf(s.app))
    } catch {
      return
    }
    const key = JSON.stringify(list)
    if (!always && key === s.commands) return
    s.commands = key
    this.update(s, { sessionUpdate: "available_commands_update", availableCommands: list })
  }

  /** A terminal's command set, passed on by the hub. */
  commandsShared(sessionId: string, list: CommandInfo[]) {
    if (!this.ready) return
    this.update({ id: sessionId } as Session, { sessionUpdate: "available_commands_update", availableCommands: list })
  }

  /** `_lembas/commands`: the command set for a composer that has a directory, or a
   *  session, and nothing sent yet. */
  private commands(p: any) {
    const t = this.terminalFor(p)
    if (t?.commands) return { commands: t.commands }
    const id = typeof p?.sessionId === "string" ? p.sessionId : ""
    const held = id ? this.sessions.get(id) : undefined
    if (held) return { commands: commandSet(sourcesOf(held.app)) }
    const dir = id ? (t?.workdir ?? this.rootOf(id)) : this.directoryOf(p)
    const project = findProject(dir)
    const trusted = trustOf(project.root) === "trusted"
    const config = loadConfig({ projectConfigDir: project.dir, trusted }).config
    const projectDir = trusted && existsSync(project.dir) ? project.dir : undefined
    return { commands: commandSet({ projectDir, skills: () => loadSkills({ projectDir, external: config.skills?.external_dirs, disabled: config.skills?.disabled }) }) }
  }

  /** `cwd` from a request: absolute, a directory here, and one a session could be opened in. */
  private directoryOf(p: any): string {
    const cwd = typeof p?.cwd === "string" ? expandHome(p.cwd.trim()) : ""
    if (!cwd || !isAbsolute(cwd)) throw new RpcError(INVALID_PARAMS, "a sessionId, or a cwd that is an absolute path")
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new RpcError(INVALID_PARAMS, `${cwd} is not a directory on this machine`)
    const refused = this.refusal(cwd)
    if (refused) throw new RpcError(INVALID_PARAMS, refused)
    return resolve(cwd)
  }

  /** Where a session works: held here, a terminal's, or one in the store (under the same rules). */
  private rootOf(id: string): string {
    const held = this.sessions.get(id)
    if (held) return held.app.engine.o.toolCtx.cwd
    const shared = this.hub?.shared.get(id)
    if (shared) return shared.workdir
    const row = (this.store ??= new Store()).session(id)
    if (!row) throw new RpcError(INVALID_PARAMS, "no such session")
    const dir = this.workdirOf(row)
    const refused = this.refusal(dir)
    if (refused) throw new RpcError(INVALID_PARAMS, refused)
    return dir
  }

  /** The directory a stored session works in: the one it was started in (CWD_META), while
   *  that still exists, is inside the session's project and inside the remote roots; otherwise its
   *  project's root. Not always the root: a session started in a subdirectory would come back at
   *  the root, and its @path mentions and its terminal's directory with it. */
  workdirOf(row: { id: string; root: string }): string {
    let cwd: unknown
    try {
      cwd = (this.store ??= new Store()).meta<string>(row.id, CWD_META)
    } catch {}
    if (typeof cwd !== "string" || !isAbsolute(cwd)) return row.root
    try {
      if (!statSync(cwd).isDirectory()) return row.root
    } catch {
      return row.root
    }
    if (!underRoots(cwd, [row.root])) return row.root
    if (this.limits && !underRoots(cwd, this.limits.roots)) return row.root
    return cwd
  }

  private indexes = new Map<string, FileIndex>()
  private indexFor(root: string): FileIndex {
    let i = this.indexes.get(root)
    if (!i) {
      i = new FileIndex(root)
      this.indexes.set(root, i)
    }
    return i
  }

  /** `_lembas/files/search`: what the TUI's @ picker finds for `query` — the same index,
   *  ranking and frecency, gitignored files left out. Paths are relative to `root`, the directory
   *  @path mentions in a prompt are read from. */
  private filesSearch(p: any) {
    const id = typeof p?.sessionId === "string" ? p.sessionId : ""
    const root = id ? this.rootOf(id) : this.directoryOf(p)
    const limit = Math.max(1, Math.min(50, Number(p?.limit) || 20))
    const query = typeof p?.query === "string" ? p.query : ""
    const found = this.indexFor(root).search(query, limit)
    return { root, files: found.map((f) => ({ path: f.replace(/\/$/, ""), kind: f.endsWith("/") ? "dir" : "file" })) }
  }
  private store?: Store

  /** Whether a session runs here, and whether it is working (the hub, before a terminal opens it). */
  holding(id: string): "busy" | "idle" | undefined {
    const s = this.sessions.get(id)
    return s ? (s.prompting ? "busy" : "idle") : undefined
  }

  /** Whether any session this link runs is working, or has prompts waiting. */
  anyBusy(): boolean {
    return [...this.sessions.values()].some((s) => s.prompting || s.queue)
  }

  /** Let go of an idle session: a terminal carries it on from the store. */
  drop(id: string) {
    const s = this.sessions.get(id)
    if (!s || s.prompting) return
    this.sessions.delete(id)
    void s.app.close()
  }

  notifyInstance(method: string, params: unknown) {
    this.peer.notify(method, params)
  }

  /** Whether the instance can be told about a session now: the link is up, initialized,
   *  and its client said it is LLeMbas. Before that a word sent is a word lost. */
  canNotify(): boolean {
    return this.ready && this.lembas && !this.peer.isClosed && this.limits !== undefined
  }

  /** A session deleted on this machine, to the instance; kept in the pending list
   *  (pending.ts) for the next link when it cannot be told now. */
  notifyDeleted(id: string) {
    if (this.canNotify()) this.notifyInstance("_lembas/session/deleted", { sessionId: id })
    else addPendingDeleted([id])
  }

  /** The deletes nobody could pass on while there was no link: sent once the link's client
   *  is known to be LLeMbas, then forgotten. Only on the LLeMbas link — `serve --stdio` speaks to an
   *  editor, which has no chats to delete and must not empty the list. */
  private flushDeleted() {
    if (!this.canNotify()) return
    const ids = pendingDeleted()
    for (const id of ids) this.notifyInstance("_lembas/session/deleted", { sessionId: id })
    clearPendingDeleted(ids)
  }

  /** An event of a session a terminal runs, passed on as if it ran here. */
  emitShared(sessionId: string, e: Event) {
    this.forward({ id: sessionId } as Session, e)
  }

  /** An approval of a session a terminal runs: the same card, answered by whoever comes first. */
  askInstance(params: unknown) {
    return this.peer.request("session/request_permission", params)
  }

  /** A question or a plan of a session a terminal runs — only to a client that said it is
   *  LLeMbas; any other has no such card, and the terminal's answers alone. */
  askInstanceCard(method: "_lembas/question" | "_lembas/plan", params: unknown) {
    if (!this.cards) return Promise.reject(new RpcError(INVALID_PARAMS, "the client shows no such card"))
    return this.peer.request(method, params).catch((e) => {
      // A client that said 2 and has no such method after all: no more cards on this link.
      if (e instanceof RpcError && e.code === METHOD_NOT_FOUND) this.clientProtocol = 1
      throw e
    })
  }

  /** `_lembas/session/history`: a session's turns, for the web UI to draw one it has not
   *  seen yet — a terminal's, shared after it began. */
  private history(p: any) {
    const id = String(p?.sessionId ?? "")
    const store = (this.store ??= new Store())
    const row = store.session(id)
    if (!row) throw new RpcError(INVALID_PARAMS, "no such session")
    const dir = this.hub?.shared.get(id)?.workdir ?? this.sessions.get(id)?.app.engine.o.toolCtx.cwd ?? this.workdirOf(row)
    const refused = this.hub?.shared.has(id) ? undefined : this.refusal(dir)
    if (refused) throw new RpcError(INVALID_PARAMS, refused)
    return { sessionId: id, title: row.title, root: row.root, turns: historyTurns(store.messages(id), dir) }
  }

  /** The terminal running a session, when one does. Its mode beyond the device's limit stops a
   *  prompt from the web UI unless the session was shared by name (/remote). */
  private terminalFor(p: any) {
    const s = this.hub?.shared.get(String(p?.sessionId ?? ""))
    if (!s || s.client.isClosed) return undefined
    return s
  }

  private async prompt(p: any): Promise<PromptResult> {
    const turnId = turnIdOf(p)
    const t = this.terminalFor(p)
    if (t) {
      const L = this.limits
      if (L && !t.explicit && MODE_RANK[t.mode] < MODE_RANK[L.maxMode])
        throw new RpcError(INVALID_PARAMS, `this session runs in ${t.mode} in the terminal, beyond what remote work may use here (${L.maxMode}) — change its mode there, or share it by name with /remote`)
      // The blocks themselves: the terminal expands commands, @files and attachments as
      // its own keyboard would; `text` for a terminal of a build before that.
      const context = contextOf(p?._meta)
      return t.client.request("session/prompt", { sessionId: t.sessionId, text: promptText(p.prompt), prompt: p.prompt, turnId, ...(context ? { context, instance: this.instanceConnection } : {}) })
    }
    const s = this.get(p)
    // A turn id this session has taken already: not run again — the original's answer,
    // now or when it is done.
    if (s.turns.has(turnId)) return s.turns.run(turnId, () => Promise.reject(new Error("unreachable")))
    this.takeContext(s, p)
    const prepared = preparePrompt(s.app, s.id, p.prompt, { roots: this.limits?.roots })
    // Working already: the prompt waits for the turn to end and runs next. It used to be
    // refused, and a web UI that had misjudged the session as idle lost its message to an error.
    const run = async (started: () => void): Promise<PromptResult> => {
      s.prompting = true
      started()
      try {
        return await this.runPrepared(s, prepared, turnId)
      } finally {
        s.prompting = false
      }
    }
    return s.turns.run(turnId, (started) => {
      // Idle: it starts now, in this tick — a steer sent right after it must find the session working.
      const next = s.queue ? s.queue.then(() => run(started), () => run(started)) : run(started)
      const tail = next.catch(() => {})
      s.queue = tail
      void tail.then(() => {
        if (s.queue === tail) s.queue = undefined
      })
      return next
    })
  }

  /** One prompt of a session held here, as the TUI would run it: a command's action, or
   *  the expanded prompt with its attachments, under the command's model and mode for this turn. */
  private async runPrepared(s: Session, prepared: ReturnType<typeof preparePrompt>, turnId: string): Promise<PromptResult> {
    const app = s.app
    const done = (meta: Record<string, unknown>): PromptResult => ({ stopReason: "end_turn", _meta: { lembas: { turnId, ...meta } } })
    if (prepared.kind === "message") {
      app.bus.emit({ type: "notice", message: `/${prepared.name}: ${prepared.text}` })
      return done({ command: prepared.name, message: prepared.text })
    }
    if (prepared.kind === "action") {
      if (prepared.name === "compact") {
        try {
          return done({ command: "compact", summary: await app.engine.compact() })
        } catch (e) {
          throw new RpcError(INVALID_PARAMS, `compaction failed: ${(e as Error).message}`)
        }
      }
      if (prepared.name === "undo") {
        const r = app.turns.undo()
        app.bus.emit({ type: "notice", message: r ? (r.files.length ? `undone — restored ${r.files.join(", ")}` : "undone — no files had changed") : "nothing to undo in this session" })
        return done({ command: "undo", undone: r ?? null })
      }
      const mode = this.limits ? clampMode("plan", this.limits.maxMode) : "plan"
      app.engine.mode = mode
      app.bus.emit({ type: "mode", mode })
      return done({ command: "plan", mode })
    }
    for (const a of prepared.atPaths) this.indexFor(app.engine.o.toolCtx.cwd).used(a.replace(/\/$/, ""))
    const prev = { model: app.engine.model.ref, mode: app.engine.mode, effort: app.engine.effort }
    try {
      if (prepared.model) app.switchModel(prepared.model)
      if (prepared.mode) app.engine.mode = this.limits ? clampMode(prepared.mode, this.limits.maxMode) : prepared.mode
      const reason = await app.turns.prompt(prepared.prompt, prepared.extra, prepared.shown, { turnId, attachments: prepared.attachments })
      // Messages sent mid-task (`_lembas/steer`) that the task ended before taking in: handed back,
      // so the web UI sends them as the next turn rather than losing them.
      const unsent = app.engine.takeInbox()
      return { stopReason: STOP[reason] ?? "end_turn", _meta: { lembas: { turnId, ...(unsent.length ? { unsent } : {}), ...(prepared.command ? { command: prepared.command } : {}) } } }
    } finally {
      // A command's model and mode hold for its prompt only — unless the turn itself changed the
      // mode (a plan approved), which then stays.
      // The model back, and the effort the person had on it — not the model's default.
      if (prepared.model && app.engine.model.ref !== prev.model) {
        app.switchModel(prev.model)
        app.engine.effort = prev.effort
      }
      if (prepared.mode && app.engine.mode === (this.limits ? clampMode(prepared.mode, this.limits.maxMode) : prepared.mode)) app.engine.mode = prev.mode
    }
  }

  /** `_lembas/session/status`: whether the session is working, and where it runs — asked
   *  after a restart or a dropped link, so the instance follows a turn still running instead of
   *  sending its prompt a second time. */
  private async status(p: any) {
    const id = String(p?.sessionId ?? "")
    const t = this.terminalFor(p)
    if (t) {
      // The terminal knows its turns; what the hub saw of them, when it cannot be asked.
      const turns = await t.client
        .request<{ turnId?: string; queued?: string[]; lastTurnId?: string; plan?: Plan | null; jobs?: JobInfo[] }>("hub/status", { sessionId: t.sessionId }, 3000)
        .catch(() => ({ ...(t.turnId ? { turnId: t.turnId } : {}), queued: [], ...(t.lastTurnId ? { lastTurnId: t.lastTurnId } : {}), plan: this.storedPlan(id), jobs: this.storedJobsOf(id) }))
      return { sessionId: id, exists: true, held: "terminal", busy: t.busy, title: t.title, ...turns, queued: turns.queued ?? [], plan: turns.plan ?? null, jobs: turns.jobs ?? [] }
    }
    const s = this.sessions.get(id)
    if (s)
      return {
        sessionId: id,
        exists: true,
        held: "here",
        busy: s.prompting,
        title: (this.store ??= new Store()).session(id)?.title ?? "",
        ...(s.turns.running ? { turnId: s.turns.running } : {}),
        queued: s.turns.queued(),
        ...(s.turns.last ? { lastTurnId: s.turns.last } : {}),
        plan: s.app.engine.plan ?? null,
        jobs: jobList(s.app),
      }
    const row = (this.store ??= new Store()).session(id)
    // Not open: the last turn it finished, as kept across a restart, its plan and its jobs as stored.
    const last = row ? turnStore(id).load().at(-1)?.[0] : undefined
    return { sessionId: id, exists: Boolean(row), held: "none", busy: false, title: row?.title ?? "", queued: [], ...(last ? { lastTurnId: last } : {}), plan: row ? this.storedPlan(id) : null, jobs: row ? this.storedJobsOf(id) : [] }
  }

  /** A stored session's jobs (capability `jobs`), or none. */
  private storedJobsOf(id: string): JobInfo[] {
    try {
      return storedJobs((this.store ??= new Store()), id)
    } catch {
      return []
    }
  }

  /** `_lembas/jobs`: the session's background jobs, running first — the terminal's through the
   *  hub when a terminal has it, as `status` goes. */
  private async jobs(p: any) {
    const t = this.terminalFor(p)
    if (t) return t.client.request("hub/job", { sessionId: t.sessionId, op: "list" }, 15_000)
    return { jobs: jobList(this.get(p).app) }
  }

  /** `_lembas/job/output`, `/stop`, `/send`, `/transcript` (acp/jobs.ts): one job of the session. */
  private async job(op: "output" | "stop" | "send" | "transcript", p: any) {
    const t = this.terminalFor(p)
    if (t) return t.client.request("hub/job", { sessionId: t.sessionId, op, id: p?.id, since: p?.since, text: p?.text }, 15_000)
    const app = this.get(p).app
    switch (op) {
      case "output":
        return jobOutput(app, p?.id, p?.since)
      case "stop":
        return jobStop(app, p?.id)
      case "send":
        return jobSend(app, p?.id, p?.text)
      case "transcript":
        return jobTranscript(app, p?.id)
    }
  }

  /** A stored session's plan (the engine keeps it under PLAN_META), or null. */
  private storedPlan(id: string): Plan | null {
    try {
      const p = (this.store ??= new Store()).meta<Plan | null>(id, PLAN_META)
      return p && typeof p === "object" && "version" in p ? p : null
    } catch {
      return null
    }
  }

  /** `_lembas/session/rewind`: the client is editing or regenerating from a turn. That turn and
   *  every later one leave the conversation and the history, as /undo drops a turn — the files
   *  are not touched. Refused for a turn the session does not have, or while it works. */
  private async rewind(p: any) {
    const turnId = typeof p?.turnId === "string" ? p.turnId.trim() : ""
    if (!turnId) throw new RpcError(INVALID_PARAMS, "turnId, please")
    const t = this.terminalFor(p)
    if (t) return t.client.request("hub/rewind", { sessionId: t.sessionId, turnId }, 15_000)
    const s = this.get(p)
    if (s.prompting || s.turns.queued().length) throw new RpcError(INVALID_PARAMS, "this session is working — rewind it when the reply is done")
    const reverted = s.app.turns.rewind(turnId)
    if (reverted === undefined) throw new RpcError(INVALID_PARAMS, `this session has no turn ${turnId}`)
    s.turns.forget(reverted)
    return { reverted: reverted.length }
  }

  /** `_lembas/session/delete`: the chat was deleted in the web UI, so the session is too —
   *  stopped first if it works, and a terminal that has it open starts a new one. */
  private async deleteSession(p: any) {
    const id = String(p?.sessionId ?? "")
    const store = (this.store ??= new Store())
    const t = this.terminalFor(p)
    if (t) return t.client.request("hub/delete", { sessionId: t.sessionId }, 30_000)
    const row = store.session(id)
    if (!row) return { deleted: false }
    // Not `refusal`: that is the rule for opening one, and asks for trust a delete has no use for.
    const shown = this.sessions.has(id) || Boolean(this.hub?.shared.has(id)) || store.meta<boolean>(id, REMOTE_META) === true
    const refused = deletableFor(this.limits, row.root, shown)
    if (refused) throw new RpcError(INVALID_PARAMS, refused)
    const s = this.sessions.get(id)
    if (s) {
      s.app.cancel()
      // Its jobs go with it: nothing is left running for a session that no longer exists.
      s.app.registry.stopAll(id)
      await s.queue?.catch(() => {})
      this.sessions.delete(id)
      await s.app.close().catch(() => {})
    }
    dropAttachments(id)
    turnStore(id).drop()
    return { deleted: store.deleteSession(id) }
  }

  /** `_lembas/session/compact`: /compact, asked from the web UI. */
  private async compact(p: any) {
    const t = this.terminalFor(p)
    if (t) return t.client.request("hub/compact", { sessionId: t.sessionId }, 600_000)
    const s = this.get(p)
    if (s.prompting) throw new RpcError(INVALID_PARAMS, "this session is working — compact it when the reply is done")
    try {
      return { summary: await s.app.engine.compact() }
    } catch (e) {
      throw new RpcError(INVALID_PARAMS, `compaction failed: ${(e as Error).message}`)
    }
  }

  /** `_lembas/session/title`: the chat was renamed in the web UI. */
  private retitle(p: any) {
    const title = typeof p?.title === "string" ? p.title.trim().slice(0, 200) : ""
    const t = this.terminalFor(p)
    if (t) return t.client.request("hub/title", { sessionId: t.sessionId, title }, 15_000)
    const id = String(p?.sessionId ?? "")
    const store = (this.store ??= new Store())
    if (!store.session(id)) throw new RpcError(INVALID_PARAMS, "no such session")
    store.setTitle(id, title)
    return { title }
  }

  /** `_lembas/steer`: a message the person sent while the task runs, given to the model at
   *  its next step — what typing into the TUI while it works does (busy_input: steer). */
  private steer(p: any) {
    const text = typeof p?.text === "string" ? p.text.trim() : ""
    if (!text) throw new RpcError(INVALID_PARAMS, "nothing to send")
    // The sender's id for it: handed back in the `steered` event, so the web UI shows the
    // message at the point of the reply where the model took it in.
    const id = typeof p?.messageId === "string" && p.messageId ? p.messageId.slice(0, 64) : undefined
    const t = this.terminalFor(p)
    if (t) return t.client.request("hub/steer", { sessionId: t.sessionId, text, messageId: id }, 15_000)
    const s = this.get(p)
    if (!s.prompting) throw new RpcError(INVALID_PARAMS, "this session is not working on anything; send it as a prompt")
    s.app.engine.enqueue(text, id)
    return { queued: s.app.engine.queued }
  }

  /** `_lembas/terminal/open`: a login shell as this user, in a PTY, in a directory a remote
   *  session could use — only with `remote.terminal: true`. What is typed is a person's, not a
   *  model's, so the hardline and the modes do not apply, exactly as in a terminal opened here. */
  private terminalOpen(p: any) {
    const L = this.limits
    if (!L?.terminal) throw new RpcError(INVALID_PARAMS, "this device does not open terminals for the web UI (remote.terminal is off)")
    const cwd = typeof p?.cwd === "string" && p.cwd.trim() ? resolve(expandHome(p.cwd.trim())) : resolve(expandHome(L.roots[0] ?? "~"))
    const refused = this.refusal(cwd)
    if (refused) throw new RpcError(INVALID_PARAMS, refused)
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new RpcError(INVALID_PARAMS, `${cwd} is not a directory on this machine`)
    if (this.terminals.size >= MAX_TERMINALS) throw new RpcError(INVALID_PARAMS, `this device already has ${MAX_TERMINALS} terminals open for the web UI`)
    const id = crypto.randomUUID()
    const cols = Math.max(20, Math.min(500, Number(p?.cols) || 80))
    const rows = Math.max(5, Math.min(300, Number(p?.rows) || 24))
    const shell = process.env.SHELL || "/bin/bash"
    // Marks for the web UI's terminal: the user's own startup files first, then OSC 133/7.
    const launch = shellLaunch(shell, id, L.terminalIntegration !== false)
    const proc = Bun.spawn(launch.argv, {
      cwd,
      env: { ...process.env, TERM: "xterm-256color", ...launch.env },
      terminal: {
        cols,
        rows,
        data: (_t: unknown, d: Uint8Array) => this.peer.notify("_lembas/terminal/output", { terminalId: id, data: Buffer.from(d).toString("base64") }),
      },
    } as Parameters<typeof Bun.spawn>[1])
    const pty = (proc as unknown as { terminal: Terminal["pty"] }).terminal
    this.terminals.set(id, { proc, pty, cleanup: launch.cleanup })
    void proc.exited.then((code) => {
      launch.cleanup()
      if (!this.terminals.delete(id)) return
      this.peer.notify("_lembas/terminal/exit", { terminalId: id, code })
    })
    return { terminalId: id, cwd, cols, rows, shell: launch.kind, integration: launch.integration }
  }

  private terminalInput(p: any) {
    const t = this.terminals.get(String(p?.terminalId ?? ""))
    if (!t || typeof p?.data !== "string") return
    t.pty.write(Buffer.from(p.data, "base64"))
  }

  private terminalResize(p: any) {
    const t = this.terminals.get(String(p?.terminalId ?? ""))
    if (!t) return
    t.pty.resize(Math.max(20, Math.min(500, Number(p?.cols) || 80)), Math.max(5, Math.min(300, Number(p?.rows) || 24)))
  }

  private terminalClose(id: string) {
    const t = this.terminals.get(id)
    if (!t) return
    this.terminals.delete(id)
    try {
      t.proc.kill("SIGHUP")
    } catch {}
    t.cleanup()
    try {
      t.pty.close?.()
    } catch {}
  }

  private setMode(p: any) {
    const wanted = asMode(p?.modeId)
    if (!wanted) throw new RpcError(INVALID_PARAMS, `unknown mode ${p?.modeId}`)
    const t = this.terminalFor(p)
    if (t) {
      const mode = this.limits && !t.explicit ? clampMode(wanted, this.limits.maxMode) : wanted
      return t.client.request("hub/mode", { sessionId: t.sessionId, mode }, 30_000)
    }
    const s = this.get(p)
    const mode = this.limits ? clampMode(wanted, this.limits.maxMode) : wanted
    s.app.engine.mode = mode
    s.app.bus.emit({ type: "mode", mode })
    return {}
  }

  private cancel(p: any) {
    const t = this.terminalFor(p)
    if (t) return t.client.notify("hub/cancel", { sessionId: t.sessionId })
    this.sessions.get(String(p?.sessionId ?? ""))?.app.cancel()
  }

  private update(s: Session, update: Record<string, unknown>) {
    this.peer.notify("session/update", { sessionId: s.id, update })
  }

  private forward(s: Session, e: Event) {
    // A model change says whether the model is this link's instance's: its ref is the
    // provider's now (`deepseek/x`), so the ref alone no longer tells.
    const event = e.type === "model" ? { ...e, instance: this.isInstance(e.connection) } : e
    if (this.lembas) this.peer.notify("_lembas/event", { sessionId: s.id, event })
    switch (e.type) {
      case "text":
        return this.update(s, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: e.text } })
      case "reasoning":
        return this.update(s, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: e.text } })
      case "tool_start":
        return this.update(s, { sessionUpdate: "tool_call", toolCallId: e.id, title: e.name, kind: toolKind(e.name), status: "in_progress", rawInput: e.args })
      case "tool_end":
        return this.update(s, {
          sessionUpdate: "tool_call_update",
          toolCallId: e.id,
          status: e.result.isError ? "failed" : "completed",
          ...(e.result.title ? { title: e.result.title } : {}),
          content: [{ type: "content", content: { type: "text", text: e.result.output.slice(0, 20_000) } }],
        })
      case "tool_denied":
        return this.update(s, { sessionUpdate: "tool_call_update", toolCallId: e.id, status: "failed", content: [{ type: "content", content: { type: "text", text: e.reason } }] })
      case "plan":
        return this.update(s, planUpdate(e.plan))
      case "mode":
        return this.update(s, { sessionUpdate: "current_mode_update", currentModeId: e.mode })
    }
  }

  /** Approvals go to the client; nobody answering in time is a denial. ask_user and plan_submit
   *  go to it too, as `_lembas/question` and `_lembas/plan` — to a client that said it is
   *  LLeMbas; for any other there is nobody to ask, as before. A card the device stops waiting for
   *  (its time ran out, the link dropped) is taken down with `_lembas/permission/settled`. */
  private asker(s: Session): Asker {
    const agentOf = () => s.agent ?? this
    const canAsk = () => agentOf().cards && !agentOf().peer.isClosed
    /** The client does not know the method after all: as if it had never been offered (and never again). */
    const unknown = (a: AcpAgent, e: unknown) => {
      if (!(e instanceof RpcError) || e.code !== METHOD_NOT_FOUND) return false
      a.clientProtocol = 1
      return true
    }
    const settle = (a: AcpAgent, toolCallId: string) => a.peer.notify("_lembas/permission/settled", { sessionId: s.id, toolCallId })
    return {
      ask: async (req): Promise<AskReply> => {
        // Whichever link holds the session now; none (dropped, not back yet) is nobody to ask.
        const agent = agentOf()
        const timeout = agent.limits?.approvalTimeoutMs ?? 0
        const params = permissionParams(s.id, req)
        try {
          if (agent.peer.isClosed) throw new Error("not linked")
          const answer = await agent.peer.request("session/request_permission", params, timeout || undefined)
          return replyFrom(answer, !req.request.alwaysAsk)
        } catch {
          settle(agent, params.toolCall.toolCallId)
          return { kind: "deny", feedback: "Nobody answered the approval in time, so it was refused." }
        }
      },
      // Getters: whether there is anybody to ask is decided when the tool runs, by the link
      // holding the session then — the engine offers the card only where one can be shown.
      get question() {
        if (!canAsk()) return undefined
        return async (req: QuestionRequest, callId?: string): Promise<QuestionReply> => {
          const agent = agentOf()
          if (!canAsk()) throw new ToolError(NOBODY_TO_ASK)
          const params = questionParams(s.id, req, callId)
          try {
            return questionReplyFrom(await agent.peer.request("_lembas/question", params, agent.limits?.approvalTimeoutMs || undefined), req)
          } catch (e) {
            if (unknown(agent, e)) throw new ToolError(NOBODY_TO_ASK)
            settle(agent, params.toolCallId)
            return { dismissed: true }
          }
        }
      },
      get plan() {
        if (!canAsk()) return undefined
        return async (req: PlanRequest, callId?: string): Promise<PlanReply> => {
          const agent = agentOf()
          const params = planParams(s.id, req, callId)
          try {
            return planReplyFrom(await agent.peer.request("_lembas/plan", params, agent.limits?.approvalTimeoutMs || undefined), agent.limits?.maxMode)
          } catch (e) {
            if (unknown(agent, e)) throw new ToolError(nobodyToApprove(req.path))
            settle(agent, params.toolCallId)
            return { kind: "dismissed" }
          }
        }
      },
    }
  }
}
