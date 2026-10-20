// A terminal's side of the hub (hub.ts): its session shown and used in the web UI too.
//
// With the service running, the session the terminal has open is shared by itself — within the
// device's `remote:` limits — and follows /new and /sessions. /remote shares it by name: through
// the service when it runs, otherwise by holding the link here, for as long as this terminal runs.
//
// Shared, the web UI is a second keyboard on the same session: its prompt runs here as if typed,
// its message mid-task joins the task, its stop stops it, and an approval is asked on both sides —
// whichever answers first decides, and the other side's card goes away.
import type { App } from "../app.ts"
import type { AskReply, Asker, AttachmentInfo, Event } from "../bus/index.ts"
import { asMode, type Mode } from "../config/schema.ts"
import type { ImagePart } from "../provider/types.ts"
import { commandSet, sourcesOf } from "../session/commands.ts"
import type { PlanReply, PlanRequest } from "../tool/plan_submit.ts"
import type { QuestionReply, QuestionRequest } from "../tool/ask_user.ts"
import { clampMode, effortOf, markRemote, permissionParams, planParams, planReplyFrom, questionParams, questionReplyFrom, replyFrom, STOP, type PromptResult } from "./agent.ts"
import { jobList, jobOutput, jobSend, jobStop, jobTranscript } from "./jobs.ts"
import type { SessionContext } from "../app.ts"
import { sessionTurnFile, sessionTurns, type TurnLog } from "./turns.ts"
import { dropAttachments, preparePrompt } from "./prompt.ts"
import { connectHub, Hub } from "./hub.ts"
import { isLocal } from "../config/paths.ts"
import { localRefusal, refusedLocally } from "../project/local.ts"
import { addPendingDeleted } from "./pending.ts"
import { REMOTE_META, type Store } from "../session/store.ts"
import { limitsFromConfig, runLink } from "./link.ts"
import { INVALID_PARAMS, RpcError, type Peer } from "./rpc.ts"

type AskRequest = Parameters<Asker["ask"]>[0]

/** An approval shown here, which the web UI's answer can take down. */
export interface LocalAsk<R = AskReply> {
  reply: Promise<R>
  dismiss(r: R): void
}

/** A prompt from the web UI, made into what the TUI sends: the expanded text, what the
 *  transcript shows, the attachments for the model and as chips, its turn id, and a command's model
 *  and mode for this one prompt. */
export interface SharedPrompt {
  prompt: string
  shown: string
  extra: (string | ImagePart)[]
  attachments: AttachmentInfo[]
  turnId: string
  model?: string
  mode?: Mode
}

export interface ShareHooks {
  /** A prompt from the web UI: run it as if typed here, calling `started` when it stops waiting for
   *  the turn before it. Resolves with the engine's stop reason. */
  prompt(input: SharedPrompt, started: () => void): Promise<string>
  /** A command from the web UI that sends no prompt — compact, undo, plan; absent, the
   *  share does it on the app and says `changed`. */
  action?(name: "compact" | "undo" | "plan", arg: string): Promise<Record<string, unknown>>
  notice(text: string, level?: "info" | "warn"): void
  /** /compact, asked from the web UI. Resolves with the summary. */
  compact(): Promise<string>
  /** The web UI deleted this session: it is gone here too, and a new one starts. */
  deleted(): void
  /** Shared or not, mode, model or effort changed: redraw. */
  changed(): void
  /** The web UI rewound the session (`_lembas/session/rewind`): the conversation is shorter now. */
  rewound?(): void
}

let current: Share | undefined

/** Before a session is resumed in a terminal: the hub lets go of its own copy of it, or says why it
 *  cannot (working on a prompt from the web UI, or open in another terminal). */
export async function releaseForResume(id: string): Promise<string | undefined> {
  return current ? current.release(id) : releaseVia(undefined, id)
}

async function releaseVia(hub: Peer | undefined, id: string): Promise<string | undefined> {
  const peer = hub ?? (await connectHub())
  if (!peer) return undefined
  try {
    await peer.request("hub/release", { sessionId: id }, 5000)
    return undefined
  } catch (e) {
    return (e as Error).message
  } finally {
    if (peer !== hub) peer.close()
  }
}

/** Delete a stored session here and in the web UI (from Share.deleted): the hub lets go of
 *  its copy first (or says why it cannot — working on a prompt from the web UI, open in another
 *  terminal), the rows and what hangs off them go, and the hub is told so that the instance deletes
 *  the chat. `hub`: a connection to it already open (a terminal's); without one, one is made for
 *  this delete when a hub runs — `lembas sessions delete` reaches it the way a terminal does. With
 *  no hub at all, the word waits in the pending list for the service's next link. */
export async function deleteEverywhere(store: Store, id: string, hub?: Peer): Promise<string | undefined> {
  const peer = hub ?? (await connectHub())
  try {
    if (peer) {
      try {
        await peer.request("hub/release", { sessionId: id }, 5000)
      } catch (e) {
        return (e as Error).message
      }
    }
    store.deleteSession(id)
    dropAttachments(id)
    sessionTurnFile(id).drop()
    if (!peer) return void addPendingDeleted([id])
    peer.notify("hub/deleted", { sessionId: id })
    // A connection made for this delete closes next; a request after the notification is answered
    // only once the hub has read the notification, so the word is not lost with the socket.
    if (peer !== hub) await peer.request("hub/hello", { pid: process.pid }, 5000).catch(() => {})
    return undefined
  } finally {
    if (peer && peer !== hub) peer.close()
  }
}

/** The session a terminal leaves, deleted when nothing was ever said in it: every start
 *  makes one, and a TUI opened and closed again left it behind as an empty row in /sessions and,
 *  shared, an empty chat in the web UI. The same rule as a resume's discard (app.ts): no message
 *  rows at all, and the instance told only when it was shown the session (REMOTE_META). Kept when a
 *  running hub will not let go of it — open in another terminal, or the service working in it.
 *  Called after the terminal's own link to the hub is closed, so that link no longer counts. */
export async function discardOnExit(store: Store, id: string | undefined): Promise<boolean> {
  if (!id || !store.session(id) || !store.isEmpty(id)) return false
  const peer = await connectHub()
  try {
    if (peer) {
      try {
        await peer.request("hub/release", { sessionId: id }, 5000)
      } catch {
        return false
      }
    }
    // Asked again after the wait: a prompt from the web UI could have landed meanwhile.
    if (!store.isEmpty(id)) return false
    const shown = store.meta<boolean>(id, REMOTE_META) === true
    if (!store.deleteSession(id)) return false
    dropAttachments(id)
    sessionTurnFile(id).drop()
    if (shown) {
      if (!peer) addPendingDeleted([id])
      else {
        peer.notify("hub/deleted", { sessionId: id })
        await peer.request("hub/hello", { pid: process.pid }, 5000).catch(() => {})
      }
    }
    return true
  } finally {
    peer?.close()
  }
}

export class Share {
  private hub?: Peer
  /** The hub is the service: every session here is shared by itself. */
  private service = false
  /** The link this terminal holds for /remote, when nobody else does. */
  private own?: { hub: Hub; stop: AbortController }
  /** The session shared now. */
  sharedId?: string
  /** Shared by name (/remote): it stays shared across a dropped hub, and the limits do not decide. */
  explicit = false
  private retry?: ReturnType<typeof setInterval>
  private off: () => void
  private closed = false
  /** The shared session's turns, by id: a prompt sent twice runs once — on the file the
   *  service uses too, so a turn run here is not run again there after the session moves. */
  private turnLog?: { id: string; log: TurnLog<PromptResult> }
  private get turns(): TurnLog<PromptResult> {
    const id = this.app.engine.sessionId ?? ""
    if (this.turnLog?.id !== id) this.turnLog = { id, log: sessionTurns<PromptResult>(id) }
    return this.turnLog.log
  }
  /** The command set last sent to the hub. */
  private commandsSent?: string

  constructor(
    private app: App,
    private hooks: ShareHooks,
  ) {
    this.off = app.bus.on((e) => this.onEvent(e))
    current = this
  }

  /** Find the hub, and keep looking for one (the service may start later). */
  async start() {
    await this.connect()
    this.retry = setInterval(() => void this.reconnect(), 10_000)
    this.retry.unref?.()
  }

  /** The status bar's word: shared, and how. */
  label(): string {
    if (!this.sharedId) return ""
    return this.own ? "⇄ web (this terminal)" : "⇄ web"
  }

  status(): string {
    if (isLocal()) return localRefusal("sharing with the web UI")
    if (this.sharedId) return `this session is shared with the web UI ${this.own ? "— the link is held by this terminal, so it lasts as long as the terminal does" : "through the service"}`
    if (this.hub && this.service) return "not shared: this session is outside what the service shares (remote.roots, trust) — /remote shares it anyway"
    if (this.hub) return "not shared — /remote shares it"
    return "not shared, and no service runs here — /remote shares it for as long as this terminal runs"
  }

  release(id: string) {
    return releaseVia(this.hub, id)
  }

  /** A session deleted here (/sessions, /delete): the hub lets go of its copy, and the web UI
   *  deletes the chat it is. Returns why not, when it cannot be (working in the web UI). */
  async deleted(id: string): Promise<string | undefined> {
    if (!this.app.store) return undefined
    return deleteEverywhere(this.app.store, id, this.hub)
  }

  /** /remote on or off. Returns what to say. */
  async remote(on: boolean): Promise<string> {
    if (!on) {
      const id = this.sharedId
      this.explicit = false
      if (!id) return "this session is not shared"
      this.sharedId = undefined
      await this.hub?.request("hub/unshare", { sessionId: id }, 5000).catch(() => {})
      if (this.own) this.dropOwn()
      this.hooks.changed()
      return "no longer shared with the web UI"
    }
    if (!this.hub) {
      const why = await this.becomeHub()
      if (why) return why
    }
    await this.share(true)
    return this.sharedId ? this.status() : "could not share this session"
  }

  /** An approval of the shared session goes to both sides; the first answer counts. */
  async ask(req: AskRequest, local: LocalAsk): Promise<AskReply> {
    const id = this.sharedId
    const hub = this.hub
    if (!id || !hub || this.app.engine.sessionId !== id) return local.reply
    const params = permissionParams(id, req, { patient: true })
    // A web UI that cannot show it (or a link that drops) never answers: the terminal's card does.
    const remote = hub.request("hub/ask", { sessionId: id, params }).then(
      (a) => replyFrom(a, !req.request.alwaysAsk),
      () => new Promise<never>(() => {}),
    )
    const won = await Promise.race([local.reply.then((r) => ({ r, here: true })), remote.then((r) => ({ r, here: false }))])
    if (won.here) hub.notify("hub/settled", { sessionId: id, toolCallId: params.toolCall.toolCallId })
    else {
      local.dismiss(won.r)
      this.hooks.notice(`answered in the web UI: ${won.r.kind === "deny" ? "denied" : "allowed"}`)
    }
    return won.r
  }

  /** ask_user in the shared session: the card here and in the web UI, the first answer wins. */
  question(req: QuestionRequest, callId: string | undefined, local: LocalAsk<QuestionReply>): Promise<QuestionReply> {
    return this.card(local, "hub/question", (id) => questionParams(id, req, callId, { patient: true }), (a) => questionReplyFrom(a, req), (r) => (r.dismissed ? "dismissed" : "answered"))
  }

  /** plan_submit in the shared session, likewise. */
  plan(req: PlanRequest, callId: string | undefined, local: LocalAsk<PlanReply>): Promise<PlanReply> {
    return this.card(local, "hub/plan", (id) => planParams(id, req, callId, { patient: true }), (a) => planReplyFrom(a), (r) => (r.kind === "approve" ? `approved (${r.mode})` : r.kind === "revise" ? "to be revised" : "not decided"))
  }

  private async card<R>(local: LocalAsk<R>, method: string, params: (sessionId: string) => { toolCallId: string }, read: (answer: unknown) => R, said: (r: R) => string): Promise<R> {
    const id = this.sharedId
    const hub = this.hub
    if (!id || !hub || this.app.engine.sessionId !== id) return local.reply
    const p = params(id)
    // A web UI that cannot show it (or a link that drops) never answers: the terminal's card does.
    const remote = hub.request(method, { sessionId: id, params: p }).then(read, () => new Promise<never>(() => {}))
    const won = await Promise.race([local.reply.then((r) => ({ r, here: true })), remote.then((r) => ({ r, here: false }))])
    if (won.here) hub.notify("hub/settled", { sessionId: id, toolCallId: p.toolCallId })
    else {
      local.dismiss(won.r)
      this.hooks.notice(`answered in the web UI: ${said(won.r)}`)
    }
    return won.r
  }

  /** The command set, to the hub when it changed. */
  private sendCommands(always = false) {
    const id = this.sharedId
    if (!id || !this.hub) return
    let list
    try {
      list = commandSet(sourcesOf(this.app))
    } catch {
      return
    }
    const key = JSON.stringify(list)
    if (!always && key === this.commandsSent) return
    this.commandsSent = key
    this.hub.notify("hub/commands", { sessionId: id, commands: list })
  }

  close() {
    this.closed = true
    if (current === this) current = undefined
    clearInterval(this.retry)
    this.off()
    // Closing the connection is the hub's word that every session of this terminal is gone.
    this.hub?.close()
    this.dropOwn()
  }

  private dropOwn() {
    if (!this.own) return
    this.own.stop.abort()
    this.own.hub.close()
    this.own = undefined
  }

  private async connect(): Promise<boolean> {
    const peer = await connectHub()
    if (!peer) return false
    try {
      const hello = await peer.request<{ service?: boolean }>("hub/hello", { pid: process.pid }, 5000)
      this.hub = peer
      this.service = hello?.service === true
      this.wire(peer)
      peer.onClose(() => {
        if (this.hub !== peer) return
        this.hub = undefined
        const was = this.sharedId
        this.sharedId = undefined
        if (was && !this.closed) this.hooks.notice("the link to the web UI went away — the session goes on here", "warn")
        this.hooks.changed()
      })
      await this.share(this.explicit)
      return true
    } catch {
      peer.close()
      return false
    }
  }

  private async reconnect() {
    if (this.closed || this.hub) return
    if (await this.connect()) return
    // Shared by name, and nobody holds the link any more: hold it here.
    if (this.explicit) await this.becomeHub()
  }

  /** Hold the link in this terminal, for /remote while no service runs. Returns why not, if not. */
  private async becomeHub(): Promise<string | undefined> {
    const local = refusedLocally("/remote")
    if (local) return local
    const { instances } = await import("../lembas/login.ts")
    if (!Object.keys(instances()).length) return "not logged in to a LLeMbas instance — /login first"
    const hub = new Hub({ service: false, limits: limitsFromConfig() })
    if (!(await hub.listen())) return (await this.connect()) ? undefined : "something holds the hub's socket but does not answer"
    const stop = new AbortController()
    this.own = { hub, stop }
    void runLink({
      hub,
      sharedOnly: true,
      signal: stop.signal,
      onStatus: (s) => {
        if (s.state === "stopped" && s.detail !== "stopped") this.hooks.notice(`the link to the web UI stopped: ${s.detail}`, "warn")
      },
    }).catch((e) => {
      this.hooks.notice(`/remote: ${(e as Error).message}`, "warn")
      this.dropOwn()
    })
    return (await this.connect()) ? undefined : "could not reach the hub this terminal started"
  }

  private async share(explicit: boolean) {
    const hub = this.hub
    const id = this.app.engine.sessionId
    if (!hub || !id) return
    try {
      const r = await hub.request<{ shared?: boolean; reason?: string }>(
        "hub/share",
        {
          sessionId: id,
          cwd: this.app.project.root,
          // Where it works, which @path mentions are read from: a session started in a
          // subdirectory is not at its project's root.
          workdir: this.app.engine.o.toolCtx.cwd,
          title: this.app.store?.session(id)?.title ?? "",
          model: this.app.engine.model.ref,
          // Which connection that model is spoken to through, so the hub can say whether it
          // is the instance's.
          modelConnection: this.app.engine.model.connectionName,
          mode: this.app.engine.mode,
          effort: this.app.engine.effort ?? "off",
          busy: Boolean(this.app.turns.current),
          explicit,
        },
        10_000,
      )
      if (r?.shared) {
        // In the web UI's hands from now on: deletable from there even once this terminal has let
        // go of it, wherever it is (agent.ts, deletableFor).
        markRemote(this.app.store, id)
        this.sharedId = id
        this.explicit = explicit
        this.sendCommands(true)
      } else {
        this.sharedId = undefined
        if (explicit) this.hooks.notice(`not shared: ${r?.reason ?? "the hub said no"}`, "warn")
      }
    } catch (e) {
      this.sharedId = undefined
      if (explicit) this.hooks.notice(`not shared: ${(e as Error).message}`, "warn")
    }
    this.hooks.changed()
  }

  /** compact, undo or plan sent from the web UI: the TUI's own way when it has one. */
  private async action(name: "compact" | "undo" | "plan", arg: string): Promise<Record<string, unknown>> {
    if (this.hooks.action) return this.hooks.action(name, arg)
    if (name === "compact") return { summary: await this.hooks.compact() }
    if (name === "undo") {
      const r = this.app.turns.undo()
      this.hooks.changed()
      return { undone: r ?? null }
    }
    this.app.engine.mode = "plan"
    this.app.bus.emit({ type: "mode", mode: "plan" })
    this.hooks.changed()
    return { mode: "plan" }
  }

  private onEvent(e: Event) {
    // The empty session a resume left (app.ts): gone from the store already; the web UI's
    // chat for it goes too, where it was shown one — through the hub, or the pending list.
    if (e.type === "discarded") {
      dropAttachments(e.id)
      sessionTurnFile(e.id).drop()
      if (!e.shown) return
      if (this.hub) this.hub.notify("hub/deleted", { sessionId: e.id })
      else addPendingDeleted([e.id])
      return
    }
    // Every turn here, typed or sent from the web UI, by its id.
    if (e.type === "task" && e.turnId) e.state === "start" ? this.turns.started(e.turnId) : this.turns.ended(e.turnId)
    if (e.type === "session") {
      if (e.id === this.sharedId) return
      // /new or /sessions: the old one stops being shared, and the new one is shared as any is.
      const was = this.sharedId
      this.sharedId = undefined
      this.explicit = false
      if (was) void this.hub?.request("hub/unshare", { sessionId: was }, 5000).catch(() => {})
      void this.share(false)
      return
    }
    if (this.sharedId && this.hub && this.app.engine.sessionId === this.sharedId) {
      this.hub.notify("hub/event", { sessionId: this.sharedId, event: e })
      if (e.type === "task" && e.state === "end") this.sendCommands()
    }
  }

  private mine(p: any) {
    if (!this.sharedId || p?.sessionId !== this.sharedId) throw new RpcError(INVALID_PARAMS, "that session is not open in this terminal any more")
  }

  /** What the web UI asks of the session, done here as if from the keyboard. */
  private wire(peer: Peer) {
    peer.handle("session/prompt", async (p): Promise<PromptResult> => {
      this.mine(p)
      const turnId = typeof p?.turnId === "string" && p.turnId ? p.turnId : crypto.randomUUID()
      // A turn id taken already: the original's answer.
      if (this.turns.has(turnId)) return this.turns.run(turnId, () => Promise.reject(new Error("unreachable")))
      // What the client holds for the session (its instructions, personalization, library scope,
      // prototypes), passed on by the hub: read into the prompt here as the service would.
      if (p?.context && typeof p.context === "object") this.app.setContext(p.context as SessionContext, typeof p?.instance === "string" ? p.instance : undefined)
      // The blocks, expanded here as this terminal's keyboard would; `text` from a hub of
      // an earlier build.
      const blocks = Array.isArray(p?.prompt) ? p.prompt : [{ type: "text", text: String(p?.text ?? "") }]
      // The device's limits for a prompt from the web: an @path only inside this session's project
      // and the remote roots (where any are set).
      const limits = limitsFromConfig()
      const roots = limits.roots
      const prepared = preparePrompt(this.app, this.sharedId!, blocks, { roots: roots.length || !this.explicit ? roots : undefined })
      return this.turns.run(turnId, async (started) => {
        const done = (meta: Record<string, unknown>): PromptResult => ({ stopReason: "end_turn", _meta: { lembas: { turnId, ...meta } } })
        if (prepared.kind === "message") {
          started()
          this.hooks.notice(`/${prepared.name} (from the web UI): ${prepared.text}`)
          return done({ command: prepared.name, message: prepared.text })
        }
        if (prepared.kind === "action") {
          started()
          return done({ command: prepared.name, ...(await this.action(prepared.name, prepared.arg)) })
        }
        const { kind: _, atPaths: __, command, ...input } = prepared
        // A command's mode from the web never goes past remote.max_mode in a session shared under
        // the device's limits (not by name), as in a session the service runs.
        if (input.mode && !this.explicit) input.mode = clampMode(input.mode, limits.maxMode)
        const reason = await this.hooks.prompt({ ...input, turnId }, started)
        return { stopReason: STOP[reason] ?? "end_turn", _meta: { lembas: { turnId, ...(command ? { command } : {}) } } }
      })
    })
    // The terminal's turns: `_lembas/session/status` for a shared session asks here.
    peer.handle("hub/status", (p) => {
      this.mine(p)
      return { ...(this.turns.running ? { turnId: this.turns.running } : {}), queued: this.turns.queued(), ...(this.turns.last ? { lastTurnId: this.turns.last } : {}), plan: this.app.engine.plan ?? null, jobs: jobList(this.app) }
    })
    // The session's jobs (capability `jobs`): `_lembas/jobs` and `_lembas/job/*` for a session
    // this terminal has open are answered here, by the same code the agent uses for its own.
    peer.handle("hub/job", async (p) => {
      this.mine(p)
      switch (p?.op) {
        case "list":
          return { jobs: jobList(this.app) }
        case "output":
          return jobOutput(this.app, p?.id, p?.since)
        case "stop":
          return jobStop(this.app, p?.id)
        case "send":
          return jobSend(this.app, p?.id, p?.text)
        case "transcript":
          return jobTranscript(this.app, p?.id)
        default:
          throw new RpcError(INVALID_PARAMS, `no such job operation: ${String(p?.op ?? "")}`)
      }
    })
    // The web UI is editing or regenerating from a turn: that turn and the later ones go, as /undo
    // drops one — the files stay.
    peer.handle("hub/rewind", (p) => {
      this.mine(p)
      if (this.app.turns.current) throw new RpcError(INVALID_PARAMS, "this session is working — rewind it when the reply is done")
      const turnId = String(p?.turnId ?? "")
      const reverted = this.app.turns.rewind(turnId)
      if (reverted === undefined) throw new RpcError(INVALID_PARAMS, `this session has no turn ${turnId}`)
      this.turns.forget(reverted)
      this.hooks.rewound?.()
      this.hooks.notice(`the web UI rewound ${reverted.length} turn${reverted.length === 1 ? "" : "s"} — the files they changed stay as they are`)
      return { reverted: reverted.length }
    })
    peer.handle("hub/steer", (p) => {
      this.mine(p)
      const id = typeof p?.messageId === "string" && p.messageId ? p.messageId : undefined
      if (!this.app.turns.steer(String(p?.text ?? ""), id)) throw new RpcError(INVALID_PARAMS, "this session is not working on anything; send it as a prompt")
      return { queued: this.app.engine.queued }
    })
    peer.handle("hub/compact", async (p) => {
      this.mine(p)
      if (this.app.turns.current) throw new RpcError(INVALID_PARAMS, "this session is working — compact it when the reply is done")
      try {
        return { summary: await this.hooks.compact() }
      } catch (e) {
        throw new RpcError(INVALID_PARAMS, `compaction failed: ${(e as Error).message}`)
      }
    })
    peer.handle("hub/title", (p) => {
      this.mine(p)
      this.app.rename(String(p?.title ?? ""))
      return { title: String(p?.title ?? "").trim() }
    })
    // The web UI deleted the chat this session is: stopped, gone from the store, and the terminal
    // goes on in a new session (which is shared as any is).
    peer.handle("hub/delete", async (p) => {
      this.mine(p)
      const id = this.sharedId!
      this.app.cancel()
      // Stopped first, as the agent's own delete waits for its queue: until then the
      // cancelled turn could still be writing its last rows — into a session about to be gone, or,
      // once `deleted` below has moved the terminal on, into the new one. Bounded: a turn that does
      // not stop in time is deleted under it, as before.
      for (let i = 0; i < 100 && this.app.turns.current; i++) await Bun.sleep(100)
      // Moved on meanwhile (/new, /sessions): the session is no longer this terminal's to replace.
      const still = this.sharedId === id
      if (still) {
        this.sharedId = undefined
        this.explicit = false
        this.hooks.deleted()
      }
      dropAttachments(id)
      sessionTurnFile(id).drop()
      return { deleted: this.app.store?.deleteSession(id) ?? false }
    })
    peer.on("hub/cancel", (p) => {
      if (this.sharedId && p?.sessionId === this.sharedId) this.app.cancel()
    })
    peer.handle("hub/mode", (p) => {
      this.mine(p)
      const mode = asMode(p?.mode)
      if (!mode) throw new RpcError(INVALID_PARAMS, `unknown mode ${p?.mode}`)
      this.app.engine.mode = mode
      this.app.bus.emit({ type: "mode", mode })
      this.hooks.changed()
      return {}
    })
    peer.handle("hub/configure", (p) => {
      this.mine(p)
      // Compared as the ref the model has now: the instance's `<login>/<served>` names the
      // same model as `deepseek/x`, and switching to it again would reset the effort.
      if (typeof p?.model === "string" && p.model && this.app.canonicalRef(p.model) !== this.app.engine.model.ref) this.app.switchModel(p.model)
      const effort = effortOf(p?.effort)
      if (effort !== undefined) this.app.engine.effort = effort === "off" ? null : effort
      this.hooks.changed()
      return { model: this.app.engine.model.ref, effort: this.app.engine.effort ?? "off" }
    })
  }
}
