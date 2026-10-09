// The hub: one session, seen and used from the terminal and the web UI alike.
//
// A session runs in exactly one process — whichever has it open — and every other side reaches it
// through that one. The process holding the LLeMbas link (the service, or a terminal that shared a
// session with /remote while no service ran) is the hub: it listens on a Unix socket in the state
// directory, and every terminal on this machine connects to it.
//
//   - A session the web UI started runs in the hub. Opening it in a terminal asks the hub to let go
//     of it first (refused while it is working), and the terminal carries it on from the store —
//     the same sessions.db, so nothing is lost and nothing is forked.
//   - A session a terminal runs is *shared*: the hub tells the instance about it, passes on every
//     event it makes, and hands it what the web UI sends (a prompt, a message mid-task, stop, mode,
//     model). An approval goes to both sides and the first answer counts.
//   - With the service running, every terminal session is shared by itself, within the device's
//     own `remote:` limits. Without it, /remote shares the one session, and the terminal holds the
//     link itself — so that session lasts on the web exactly as long as the terminal does.
//
// The socket is the user's own (0600, in ~/.local/state/lembas). It answers JSON-RPC, one
// message a line, the same framing as `serve --stdio`.
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { connect, createServer, type Server, type Socket } from "node:net"
import { join } from "node:path"
import { paths } from "../config/paths.ts"
import type { Mode } from "../config/schema.ts"
import type { CommandInfo } from "../session/commands.ts"
import { clampMode, refusalFor, type AcpAgent, type Limits } from "./agent.ts"
import { addPendingDeleted } from "./pending.ts"
import { INVALID_PARAMS, Peer, RpcError, type Transport } from "./rpc.ts"

export const hubSocket = () => join(paths.state, "hub.sock")

/** One message a line, over a Unix socket. */
export function socketTransport(sock: Socket): Transport {
  let onMsg: (t: string) => void = () => {}
  let onEnd: () => void = () => {}
  let buf = ""
  let ended = false
  sock.setEncoding("utf8")
  sock.on("data", (chunk: string) => {
    buf += chunk
    let nl: number
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (line.trim()) onMsg(line)
    }
  })
  const end = () => {
    if (ended) return
    ended = true
    onEnd()
  }
  sock.on("close", end)
  sock.on("error", () => {})
  return {
    send: (t) => void (sock.writable && sock.write(t + "\n")),
    onMessage: (fn) => (onMsg = fn),
    onClose: (fn) => (onEnd = fn),
    close: () => sock.destroy(),
  }
}

/** Whether something answers on the socket (a hub that is alive, not a file left behind). */
export function answers(path = hubSocket(), timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect(path)
    const done = (v: boolean) => {
      clearTimeout(timer)
      sock.destroy()
      resolve(v)
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    sock.once("connect", () => done(true))
    sock.once("error", () => done(false))
  })
}

/** Connect to the hub, if one runs. */
export function connectHub(path = hubSocket()): Promise<Peer | undefined> {
  if (!existsSync(path)) return Promise.resolve(undefined)
  return new Promise((resolve) => {
    const sock = connect(path)
    const timer = setTimeout(() => (sock.destroy(), resolve(undefined)), 2000)
    sock.once("connect", () => {
      clearTimeout(timer)
      resolve(new Peer(socketTransport(sock)))
    })
    sock.once("error", () => {
      clearTimeout(timer)
      resolve(undefined)
    })
  })
}

/** A session a terminal runs and the hub passes on. */
export interface Shared {
  sessionId: string
  /** The project's root: what the limits judge, and what the instance is told. */
  cwd: string
  /** The directory it works in, which @path mentions resolve against. */
  workdir: string
  title: string
  model: string
  /** The connection its model is spoken to through. */
  modelConnection?: string
  mode: Mode
  effort: string
  /** /remote: the person shared it by name, so the device's remote limits do not decide. */
  explicit: boolean
  busy: boolean
  client: Peer
  pid: number
  /** Its turns as its events said them: the one running, the last one done. */
  turnId?: string
  lastTurnId?: string
  /** Its command set, as the terminal sent it. */
  commands?: CommandInfo[]
}

export interface HubOptions {
  /** The service: every terminal session is shared by itself (within the limits). A terminal that
   *  became the hub for /remote shares only what is shared by name. */
  service: boolean
  limits: Limits & { enabled: boolean }
}

export class Hub {
  readonly shared = new Map<string, Shared>()
  /** The sessions the link runs here: kept across links, so one that drops and comes
   *  back finds them still working. */
  readonly held = new Map<string, import("./agent.ts").Session>()
  /** The ACP agent on the link while it is up. */
  agent?: AcpAgent
  private server?: Server
  private clients = new Set<Peer>()

  constructor(readonly o: HubOptions) {}

  /** Take the socket. False: another hub is alive on it. */
  async listen(path = hubSocket()): Promise<boolean> {
    mkdirSync(paths.state, { recursive: true })
    if (existsSync(path)) {
      if (await answers(path)) return false
      rmSync(path, { force: true })
    }
    return new Promise((resolve) => {
      const server = createServer((sock) => this.accept(new Peer(socketTransport(sock))))
      server.once("error", () => resolve(false))
      server.listen(path, () => {
        try {
          chmodSync(path, 0o600)
        } catch {}
        this.server = server
        this.path = path
        resolve(true)
      })
    })
  }
  private path?: string

  close() {
    for (const c of this.clients) c.close()
    this.server?.close()
    if (this.path) rmSync(this.path, { force: true })
    this.server = undefined
  }

  /** The link came up: the instance hears about every shared session. */
  attach(agent: AcpAgent) {
    this.agent = agent
    for (const s of this.shared.values()) this.announce(s)
    // Their command sets go once the client has initialized the link (agent.ts, initialize).
  }

  detach(agent: AcpAgent) {
    if (this.agent === agent) this.agent = undefined
  }

  /** Whether anything works here now: a session the link runs, or one a terminal shares mid-turn. */
  busy(): boolean {
    return [...this.held.values()].some((s) => s.prompting || s.queue) || [...this.shared.values()].some((s) => s.busy)
  }

  private announce(s: Shared) {
    this.agent?.notifyInstance("_lembas/session/announce", {
      sessionId: s.sessionId,
      cwd: s.cwd,
      title: s.title,
      model: s.model,
      // The session's model is this link's instance's.
      instance: this.agent?.isInstance(s.modelConnection) ?? false,
      mode: s.mode,
      effort: s.effort,
      busy: s.busy,
      origin: "terminal",
    })
  }

  /** What the hub would say to a terminal asking to open this session: undefined when it may. */
  private releaseFor(peer: Peer, id: string): void {
    const other = this.shared.get(id)
    if (other && other.client !== peer && !other.client.isClosed) throw new RpcError(INVALID_PARAMS, `this session is open in another terminal (pid ${other.pid})`)
    const held = this.agent?.holding(id)
    if (held === "busy") throw new RpcError(INVALID_PARAMS, "this session is working on a prompt from the web UI — wait for it to finish, then open it")
    if (held) this.agent!.drop(id)
  }

  private accept(peer: Peer) {
    this.clients.add(peer)
    let pid = 0
    peer.handle("hub/hello", (p) => {
      pid = Number(p?.pid) || 0
      return { service: this.o.service, linked: Boolean(this.agent), pid: process.pid }
    })
    // Before a terminal resumes a session: the hub lets go of its own copy, or says why not.
    peer.handle("hub/release", (p) => {
      this.releaseFor(peer, String(p?.sessionId ?? ""))
      return {}
    })
    peer.handle("hub/share", (p) => {
      const id = String(p?.sessionId ?? "")
      if (!id) throw new RpcError(INVALID_PARAMS, "no session")
      this.releaseFor(peer, id)
      const explicit = p?.explicit === true
      const cwd = String(p?.cwd ?? "")
      if (!explicit) {
        if (!this.o.service) return { shared: false, reason: "no service runs here; /remote shares this session" }
        const why = refusalFor(this.o.limits, cwd)
        if (why) return { shared: false, reason: why }
      }
      const s: Shared = {
        sessionId: id,
        cwd,
        workdir: typeof p?.workdir === "string" && p.workdir ? p.workdir : cwd,
        title: String(p?.title ?? ""),
        model: String(p?.model ?? ""),
        ...(typeof p?.modelConnection === "string" ? { modelConnection: p.modelConnection } : {}),
        mode: (p?.mode ?? "manual") as Mode,
        effort: String(p?.effort ?? ""),
        explicit,
        busy: p?.busy === true,
        client: peer,
        pid,
      }
      this.shared.set(id, s)
      this.announce(s)
      return { shared: true, linked: Boolean(this.agent) }
    })
    peer.handle("hub/unshare", (p) => {
      this.unshare(peer, String(p?.sessionId ?? ""))
      return {}
    })
    peer.on("hub/event", (p) => {
      const s = this.shared.get(String(p?.sessionId ?? ""))
      const e = p?.event
      if (!s || s.client !== peer || !e || typeof e !== "object") return
      if (e.type === "task") {
        s.busy = e.state === "start"
        if (typeof e.turnId === "string") {
          if (e.state === "start") s.turnId = e.turnId
          else {
            s.lastTurnId = e.turnId
            if (s.turnId === e.turnId) s.turnId = undefined
          }
        }
      }
      if (e.type === "mode") s.mode = e.mode
      if (e.type === "model") {
        s.model = String(e.ref ?? s.model)
        if (typeof e.connection === "string") s.modelConnection = e.connection
        s.effort = String(e.effort ?? s.effort)
      }
      if (e.type === "title") s.title = String(e.title ?? "")
      this.agent?.emitShared(s.sessionId, e)
    })
    peer.handle("hub/ask", async (p) => {
      const s = this.shared.get(String(p?.sessionId ?? ""))
      if (!s || s.client !== peer) throw new RpcError(INVALID_PARAMS, "this session is not shared")
      if (!this.agent) throw new RpcError(INVALID_PARAMS, "not linked")
      return this.agent.askInstance(p.params)
    })
    // A terminal deleted a session: already let go of here (hub/release first), so the
    // instance is told, and deletes the chat that is that session.
    peer.on("hub/deleted", (p) => {
      const id = String(p?.sessionId ?? "")
      if (!id) return
      const s = this.shared.get(id)
      if (s && s.client === peer) this.shared.delete(id)
      this.deleted(id)
    })
    peer.on("hub/settled", (p) => this.agent?.notifyInstance("_lembas/permission/settled", { sessionId: p?.sessionId, toolCallId: p?.toolCallId }))
    // ask_user and plan_submit in a terminal's session: the same card in the web UI, the
    // first answer wins — exactly as an approval.
    for (const [method, card] of [
      ["hub/question", "_lembas/question"],
      ["hub/plan", "_lembas/plan"],
    ] as const)
      peer.handle(method, async (p) => {
        const s = this.shared.get(String(p?.sessionId ?? ""))
        if (!s || s.client !== peer) throw new RpcError(INVALID_PARAMS, "this session is not shared")
        if (!this.agent) throw new RpcError(INVALID_PARAMS, "not linked")
        const answer: any = await this.agent.askInstanceCard(card, p.params)
        // A plan approved from the web never puts a session shared by the device's limits (not by
        // name) in a mode beyond remote.max_mode; where even manual is beyond it, nothing is decided.
        if (card === "_lembas/plan" && answer?.outcome === "approve" && !s.explicit) {
          const mode = clampMode(answer.mode === "manual" ? "manual" : "edit", this.o.limits.maxMode)
          return mode === "edit" || mode === "manual" ? { ...answer, mode } : { outcome: "dismissed" }
        }
        return answer
      })
    // Its command set, at sharing and whenever it changes.
    peer.on("hub/commands", (p) => {
      const s = this.shared.get(String(p?.sessionId ?? ""))
      if (!s || s.client !== peer || !Array.isArray(p?.commands)) return
      s.commands = p.commands
      this.agent?.commandsShared(s.sessionId, s.commands!)
    })
    peer.onClose(() => {
      this.clients.delete(peer)
      for (const s of [...this.shared.values()]) if (s.client === peer) this.unshare(peer, s.sessionId)
    })
  }

  /** A session deleted on this machine, to the instance — or, with no link up now, kept for the
   *  next one (pending.ts): a delete made while the link is down is not lost, and its chat does
   *  not stay in the web UI for good. */
  deleted(id: string) {
    if (this.agent) this.agent.notifyDeleted(id)
    else addPendingDeleted([id])
  }

  private unshare(peer: Peer, id: string) {
    const s = this.shared.get(id)
    if (!s || s.client !== peer) return
    this.shared.delete(id)
    // With the service, the session is still reachable: the next prompt from the web UI opens it
    // here from the store. Without it, it is gone from the web UI's reach with the terminal.
    this.agent?.notifyInstance("_lembas/session/left", { sessionId: id, available: this.o.service })
  }
}
