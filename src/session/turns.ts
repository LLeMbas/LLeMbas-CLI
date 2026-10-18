// One entry per prompt: where the conversation and the working tree were before it and after it.
// /undo takes the files the turn changed back to how they were and drops the turn from the
// conversation; /redo reverses that. A new prompt clears what could be redone.
import type { Snapshots } from "../git/snapshot.ts"
import type { Message } from "../provider/types.ts"
import type { Engine, PromptMeta } from "./engine.ts"
import type { Store } from "./store.ts"

interface Turn {
  prompt: string
  /** Its id: the one it was given (the web UI's message id), or the one made here. */
  turnId: string
  /** engine.messages.length before the prompt. */
  at: number
  before?: string
  after?: string
  firstRow: number
  lastRow: number
}

interface Undone {
  turn: Turn
  /** The working tree when it was undone — what /redo puts back. */
  current?: string
  messages: Message[]
}

export interface UndoResult {
  prompt: string
  files: string[]
}

export class Turns {
  /** The prompt running now: where the tree was before it, and its turn id. */
  current?: { before?: string; turnId?: string }
  private done: Turn[] = []
  private undone: Undone[] = []
  /** Tree at the first prompt of the session: the base of /diff. */
  base?: string

  constructor(
    private engine: Engine,
    private snaps: Snapshots | undefined,
    private store?: Store,
  ) {}

  get canUndo() {
    return this.done.length > 0
  }
  get canRedo() {
    return this.undone.length > 0
  }

  /** Run a prompt with a snapshot either side. Every turn has an id: the one it was given
   *  (the web UI's message id), or a new one — carried on its `task` and `prompt` events. */
  async prompt(text: string, extra: (string | import("../provider/types.ts").ImagePart)[] = [], shown = text, meta: PromptMeta = {}) {
    this.undone = []
    const before = this.snaps?.track()
    this.base ??= before
    const turnId = meta.turnId || crypto.randomUUID()
    const turn: Turn = { prompt: text, turnId, at: this.engine.messages.length, before, firstRow: this.engine.lastRowId + 1, lastRow: 0 }
    this.current = { ...turn }
    this.engine.o.bus.emit({ type: "task", state: "start", turnId })
    try {
      return await this.engine.prompt(text, extra, shown, { ...meta, turnId })
    } finally {
      this.current = undefined
      turn.after = this.snaps?.track()
      turn.lastRow = this.engine.lastRowId
      this.done.push(turn)
      this.engine.o.bus.emit({ type: "task", state: "end", turnId })
    }
  }

  /** A message the user sent while a task runs. False when no task runs: send it as a prompt
   *  instead. */
  steer(text: string, id?: string): boolean {
    if (!this.current) return false
    this.engine.enqueue(text, id)
    return true
  }

  /** What was sent during the task and never reached the model (queue mode, a turn that ended
   *  first, or Esc): for the caller to send next, or to give back to the user. */
  takeInbox(): string[] {
    return this.engine.takeInbox()
  }

  undo(): UndoResult | undefined {
    const turn = this.done.pop()
    if (!turn) return undefined
    const current = this.snaps?.track()
    let files: string[] = []
    if (this.snaps && turn.before && current) {
      files = this.snaps.changed(turn.before, current)
      this.snaps.restore(turn.before, files)
    }
    const messages = this.engine.messages.splice(turn.at)
    if (this.store && this.engine.sessionId && turn.lastRow >= turn.firstRow) this.store.setKind(this.engine.sessionId, turn.firstRow, turn.lastRow, "reverted")
    this.undone.push({ turn, current, messages })
    return { prompt: turn.prompt, files }
  }

  redo(): UndoResult | undefined {
    const u = this.undone.pop()
    if (!u) return undefined
    let files: string[] = []
    if (this.snaps && u.turn.before && u.current) {
      files = this.snaps.changed(u.turn.before, u.current)
      this.snaps.restore(u.current, files)
    }
    this.engine.messages.push(...u.messages)
    if (this.store && this.engine.sessionId && u.turn.lastRow >= u.turn.firstRow) this.store.setKind(this.engine.sessionId, u.turn.firstRow, u.turn.lastRow, "message")
    this.done.push(u.turn)
    return { prompt: u.turn.prompt, files }
  }

  /** `_lembas/session/rewind`: the turn `turnId` and every later one leave the conversation the
   *  model sees and the history — their rows re-kinded as /undo re-kinds a turn's, the messages
   *  dropped — and the files are left as they are (the client says so beside its control). The
   *  ids of the turns reverted, oldest first, or undefined for a turn this session does not have;
   *  the caller forgets them from its turn log, or a client re-sending one would get the old
   *  answer. Not while a prompt runs: the caller checks. */
  rewind(turnId: string): string[] | undefined {
    const sessionId = this.engine.sessionId
    const i = this.done.findIndex((t) => t.turnId === turnId)
    if (i >= 0) {
      const dropped = this.done.splice(i)
      const first = dropped[0]!
      const last = dropped[dropped.length - 1]!
      this.engine.messages.splice(first.at)
      if (this.store && sessionId && last.lastRow >= first.firstRow) this.store.setKind(sessionId, first.firstRow, last.lastRow, "reverted")
      this.undone = []
      return dropped.map((t) => t.turnId)
    }
    // A turn run before this process had the session (opened from the store): by its row. Every
    // turn run here came after it, so they all go too.
    if (!this.store || !sessionId) return undefined
    const row = this.store.turnRow(sessionId, turnId)
    if (row === undefined) return undefined
    const ids = this.store.turnIdsFrom(sessionId, row)
    this.store.setKind(sessionId, row, Number.MAX_SAFE_INTEGER, "reverted")
    const at = this.engine.messages.findIndex((m) => m.role === "user" && m.turnId === turnId)
    if (at >= 0) this.engine.messages.splice(at)
    this.done = []
    this.undone = []
    return ids
  }

  /** Everything changed since the session's first prompt, as a unified diff. */
  diff(): string | undefined {
    if (!this.snaps || !this.base) return undefined
    const now = this.snaps.track()
    return now ? this.snaps.diff(this.base, now) : undefined
  }

  /** Paths changed since the session's first prompt. */
  touched(): string[] {
    if (!this.snaps || !this.base) return []
    const now = this.snaps.track()
    return now ? this.snaps.changed(this.base, now) : []
  }

  reset() {
    this.done = []
    this.undone = []
    this.base = undefined
  }
}
