// The TUI's view of a session, built only from bus events. Streaming text is buffered and
// flushed at ~30 fps: re-parsing markdown per token is what would make a 2-core box stutter.
import type { LocalAsk } from "../acp/share.ts"
import { batch } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type { Asker, AskReply, Bus, Event } from "../bus/index.ts"
import type { Mode } from "../config/schema.ts"
import type { Decision, PermissionRequest } from "../permission/evaluate.ts"
import type { Message, Usage } from "../provider/types.ts"
import type { Plan } from "../plan/plan.ts"
import type { PlanReply, PlanRequest } from "../tool/plan_submit.ts"
import type { QuestionReply, QuestionRequest } from "../tool/ask_user.ts"
import { CONTINUE_PROMPT, STEER_MARK } from "../session/engine.ts"
import { splitPrototypes, titleFor, type PrototypeKind } from "../prototype/fence.ts"
import { savePrototype } from "../prototype/store.ts"
import { CHARS_PER_TOKEN } from "../provider/tokens.ts"

export type Item =
  /** `mid`: sent while the agent worked, and given to it at a step boundary. */
  | { kind: "user"; id: string; text: string; mid?: boolean }
  /** `prototypes`: the prototype fences in the text that have been saved, by where each starts. */
  | { kind: "assistant"; id: string; text: string; streaming: boolean; prototypes?: Record<number, SavedPrototype> }
  | { kind: "reasoning"; id: string; text: string; streaming: boolean; started: number; ms?: number; tokens?: number }
  | {
      kind: "tool"
      id: string
      name: string
      args: unknown
      status: "running" | "done" | "error" | "denied"
      title?: string
      ms?: number
      output?: string
      diff?: string
      /** A subagent's tool lines (the task tool), newest last. */
      children?: { name: string; title: string; isError?: boolean }[]
    }
  | { kind: "notice"; id: string; text: string; level: "info" | "warn" }
  | { kind: "diff"; id: string; title: string; patch: string }
  | { kind: "error"; id: string; text: string }

export type Phase = "idle" | "waiting" | "thinking" | "writing" | "tools"

/** A prototype the model wrote, saved as a file (prototype/store.ts). */
export interface SavedPrototype {
  kind: PrototypeKind
  title: string
  path: string
}

/** Whether a reply might hold a fenced block at all, before it is split. */
const mayFence = (text: string) => text.includes("```") || text.includes("~~~")

/** Every completed prototype fence in a reply, saved the first time it is seen — the model's
 *  output as it is, under the state directory — and noted on the item, so the transcript draws
 *  one line in its place. Nothing without a session to keep it under. */
function keepPrototypes(sessionId: string | undefined, it: Extract<Item, { kind: "assistant" }>) {
  if (!sessionId || !mayFence(it.text)) return
  for (const seg of splitPrototypes(it.text)) {
    if (seg.kind !== "prototype" || !seg.closed || it.prototypes?.[seg.start]) continue
    const title = titleFor(seg.code, seg.info.title)
    try {
      const path = savePrototype(sessionId, seg.code, { kind: seg.info.kind, title })
      ;(it.prototypes ??= {})[seg.start] = { kind: seg.info.kind, title, path }
    } catch {}
  }
}

export interface Pending {
  tool: string
  args: unknown
  request: PermissionRequest
  decision: Decision
  preview?: { diff?: string; error?: string }
  /** What the model says the call is for. */
  purpose?: string
  resolve: (r: AskReply) => void
}

export interface PendingQuestion {
  req: QuestionRequest
  resolve: (r: QuestionReply) => void
}

export interface ViewState {
  items: Item[]
  phase: Phase
  busySince: number
  usage?: Usage
  /** Context the next request holds (the engine's count); falls back to input + output. */
  used?: number
  /** Output tokens per second of the last reply. */
  rate?: number
  context?: number
  sessionId?: string
  pending?: Pending
  question?: PendingQuestion
  plan?: import("./components/plancard.tsx").PendingPlan
  /** The session's plan (plan_write / plan_update), drawn above the prompt while work is open. */
  livePlan?: Plan
  /** Tool call being streamed by the model, for the spinner line. */
  preparing?: string
  showReasoning: boolean
  expandTools: boolean
  /** Messages sent while the agent works, not yet given to it; `mode` says when they will be. */
  queued: { texts: string[]; mode: "steer" | "queue" }
  /** The server reading the prompt (llama.cpp): set while it reads, gone once the reply starts. */
  progress?: { total: number; done: number; processed: number; ms: number }
}

const ATTACHMENT = /^<(file|directory|shell|image) /
let seq = 0
const nextId = () => `i${++seq}`

export function createView(bus: Bus) {
  const [state, set] = createStore<ViewState>({ items: [], phase: "idle", busySince: 0, showReasoning: false, expandTools: false, queued: { texts: [], mode: "steer" } })
  let stepStart = 0
  // The task's output tokens (every step, subagents included), and the reply
  // streaming now, counted as it arrives so the number moves before the step's usage comes in.
  // Not in the store: the spinner reads them on its own tick.
  let inTask = false
  let taskTokens = 0
  let liveChars = 0
  const startTask = () => {
    inTask = true
    taskTokens = 0
    liveChars = 0
    set("busySince", Date.now())
  }
  let buf: { kind: "text" | "reasoning"; text: string }[] = []
  let timer: ReturnType<typeof setTimeout> | undefined

  const flush = () => {
    timer = undefined
    if (!buf.length) return
    const chunks = buf
    buf = []
    set(
      produce((s) => {
        for (const c of chunks) {
          const last = s.items[s.items.length - 1]
          if (c.kind === "text") {
            if (last?.kind === "reasoning" && last.streaming) {
              last.streaming = false
              last.ms = Date.now() - last.started
            }
            if (last?.kind === "assistant" && last.streaming) last.text += c.text
            else s.items.push({ kind: "assistant", id: nextId(), text: c.text, streaming: true })
            const reply = s.items[s.items.length - 1]!
            if (reply.kind === "assistant") keepPrototypes(s.sessionId, reply)
            s.phase = "writing"
          } else {
            if (last?.kind === "reasoning" && last.streaming) last.text += c.text
            else s.items.push({ kind: "reasoning", id: nextId(), text: c.text, streaming: true, started: Date.now() })
            s.phase = "thinking"
          }
        }
      }),
    )
  }
  const queue = (kind: "text" | "reasoning", text: string) => {
    buf.push({ kind, text })
    if (!timer) timer = setTimeout(flush, 33)
  }
  const settle = (s: ViewState) => {
    for (const it of s.items)
      if ((it.kind === "assistant" || it.kind === "reasoning") && it.streaming) {
        it.streaming = false
        if (it.kind === "reasoning") it.ms = Date.now() - it.started
        else keepPrototypes(s.sessionId, it)
      }
  }

  bus.on((e: Event) => {
    if (e.type === "progress") {
      // done: what is behind it, the cached part included; never more than the whole.
      set("progress", { total: e.total, done: Math.min(e.total, e.cache + e.processed), processed: e.processed, ms: e.ms })
      return
    }
    if (e.type === "text" || e.type === "reasoning") {
      if (state.progress) set("progress", undefined)
      liveChars += e.text.length
      return queue(e.type, e.text)
    }
    flush()
    batch(() => {
      switch (e.type) {
        case "session":
          set("sessionId", e.id)
          break
        case "step":
          set(produce((s) => settle(s)))
          stepStart = state.items.length
          liveChars = 0
          // Work that is not a task of its own (a command that prompts the engine directly): the
          // clock starts here then.
          if (!inTask && state.phase === "idle") startTask()
          set({ phase: "waiting", preparing: undefined, progress: undefined })
          break
        case "tool_call_delta":
          // Thinking ends where the model starts writing a call, not when the call runs — which
          // may be minutes later, behind a permission prompt.
          if (e.name) set(produce((s) => (settle(s), (s.preparing = e.name), (s.progress = undefined))))
          break
        case "tool_start":
          set(
            produce((s) => {
              settle(s)
              s.items.push({ kind: "tool", id: e.id, name: e.name, args: e.args, status: "running" })
              s.phase = "tools"
              s.preparing = undefined
            }),
          )
          break
        case "tool_end":
          set(
            "items",
            (it) => it.kind === "tool" && it.id === e.id,
            produce((it) => {
              if (it.kind !== "tool") return
              it.status = e.result.isError ? "error" : "done"
              it.title = e.result.title ?? (e.result.isError ? e.result.output.split("\n")[0] : undefined)
              it.ms = e.ms
              it.output = e.result.output
              it.diff = typeof e.result.meta?.diff === "string" ? (e.result.meta.diff as string) : undefined
            }),
          )
          break
        case "tool_denied":
          set(produce((s) => void s.items.push({ kind: "tool", id: e.id, name: e.name, args: undefined, status: "denied", title: e.reason.split("\n")[0] })))
          break
        case "retract":
          set(produce((s) => void s.items.splice(stepStart)))
          break
        case "usage": {
          taskTokens += e.usage.output
          liveChars = 0
          if (!e.child) set({ usage: e.usage, context: e.context, used: e.used, ...(e.rate ? { rate: e.rate } : {}) })
          // The provider's count of the thinking is for the whole step: it is one thought's only
          // when the step had one. With several, each keeps its own estimate.
          if (e.usage.reasoning)
            set(
              produce((s) => {
                const thoughts = s.items.slice(stepStart).filter((it) => it.kind === "reasoning")
                if (thoughts.length === 1 && thoughts[0]!.kind === "reasoning") thoughts[0]!.tokens = e.usage.reasoning
              }),
            )
          break
        }
        case "inbox":
          set("queued", { texts: [...e.texts], mode: e.mode })
          break
        case "steered":
          // In the transcript where the model got it: after the last step's tools.
          set(produce((s) => (settle(s), void s.items.push(...e.texts.map((text) => ({ kind: "user" as const, id: nextId(), text, mid: true }))))))
          break
        case "task":
          if (e.state === "start") startTask()
          else inTask = false
          break
        case "sub_tool":
          set(
            "items",
            (it) => it.kind === "tool" && it.id === e.callId,
            produce((it) => {
              if (it.kind !== "tool") return
              it.children = [...(it.children ?? []), { name: e.name, title: e.title, isError: e.isError }].slice(-8)
            }),
          )
          break
        case "plan":
          set("livePlan", e.plan ? structuredClone(e.plan) : undefined)
          break
        case "notice":
          set(produce((s) => void s.items.push({ kind: "notice", id: nextId(), text: e.message, level: "warn" })))
          break
        case "error":
          set(produce((s) => void s.items.push({ kind: "error", id: nextId(), text: e.message })))
          break
        case "done":
          set(
            produce((s) => {
              settle(s)
              s.phase = "idle"
              s.preparing = undefined
              s.progress = undefined
              if (e.reason === "cancelled") s.items.push({ kind: "notice", id: nextId(), text: "cancelled", level: "info" })
              if (e.reason === "steps") s.items.push({ kind: "notice", id: nextId(), text: "stopped at the step limit", level: "warn" })
            }),
          )
          break
      }
    })
  })

  // One interaction on screen at a time. Parallel subagents can ask at once; later asks wait
  // their turn instead of replacing the one being answered.
  let turnQueue: Promise<unknown> = Promise.resolve()
  const inTurn = <T,>(show: (done: (r: T) => void) => void): Promise<T> => {
    const p = turnQueue.then(() => new Promise<T>((resolve) => show(resolve)))
    turnQueue = p.catch(() => {})
    return p
  }
  /** An approval on screen, which an answer from elsewhere (the web UI) can take down —
   *  shown now, or skipped when its turn comes. */
  const askLocal = (req: Parameters<Asker["ask"]>[0]): LocalAsk => {
    let dismissed: AskReply | undefined
    let finish: ((r: AskReply) => void) | undefined
    const reply = inTurn<AskReply>((resolve) => {
      if (dismissed) return resolve(dismissed)
      set(produce((s) => settle(s)))
      finish = (r) => {
        finish = undefined
        set("pending", undefined)
        resolve(r)
      }
      set("pending", { ...req, resolve: (r) => finish?.(r) })
    })
    return {
      reply,
      dismiss: (r) => {
        dismissed = r
        finish?.(r)
      },
    }
  }
  /** A question or a plan card on screen, which an answer from the web UI can take down. */
  const cardLocal = <R,>(show: (finish: (r: R) => void) => void, hide: () => void): LocalAsk<R> => {
    let dismissed: { r: R } | undefined
    let finish: ((r: R) => void) | undefined
    const reply = inTurn<R>((resolve) => {
      if (dismissed) return resolve(dismissed.r)
      finish = (r) => {
        finish = undefined
        hide()
        resolve(r)
      }
      show((r) => finish?.(r))
    })
    return {
      reply,
      dismiss: (r) => {
        dismissed = { r }
        finish?.(r)
      },
    }
  }
  const questionLocal = (req: QuestionRequest) =>
    cardLocal<QuestionReply>(
      (done) => set("question", { req, resolve: done }),
      () => set("question", undefined),
    )
  const planLocal = (req: PlanRequest) =>
    cardLocal<PlanReply>(
      (done) => set("plan", { ...req, resolve: done }),
      () => set("plan", undefined),
    )
  /** Set by the session's sharing (acp/share.ts): an approval, a question or a plan asked here and in
   *  the web UI, the first answer winning. */
  let hooks: CardHooks = {}
  const asker: Asker = {
    ask: (req) => (hooks.ask ? hooks.ask(req, askLocal(req)) : askLocal(req).reply),
    question: (req, callId) => (hooks.question ? hooks.question(req, callId, questionLocal(req)) : questionLocal(req).reply),
    plan: (req, callId) => (hooks.plan ? hooks.plan(req, callId, planLocal(req)) : planLocal(req).reply),
  }

  return {
    state,
    asker,
    setCardHooks(h: CardHooks) {
      hooks = h
    },
    /** The task's output tokens so far, the streaming reply estimated (`estimated`: some of it is). */
    taskTokens(): { n: number; estimated: boolean } {
      return { n: taskTokens + Math.ceil(liveChars / CHARS_PER_TOKEN), estimated: liveChars > 0 }
    },
    user(text: string) {
      set(produce((s) => void s.items.push({ kind: "user", id: nextId(), text })))
      set({ phase: "waiting", busySince: Date.now() })
    },
    info(text: string, level: "info" | "warn" = "info") {
      set(produce((s) => void s.items.push({ kind: "notice", id: nextId(), text, level })))
    },
    /** A `!` command the user ran: shown like a tool call, without touching the phase. */
    shellStart(command: string): string {
      const id = nextId()
      set(produce((s) => void s.items.push({ kind: "tool", id, name: "bash", args: { command }, status: "running", title: `! ${command.split("\n")[0]}` })))
      return id
    },
    shellEnd(id: string, r: { output: string; title?: string; isError?: boolean }, ms: number) {
      set(
        "items",
        (it) => it.kind === "tool" && it.id === id,
        produce((it) => {
          if (it.kind !== "tool") return
          it.status = r.isError ? "error" : "done"
          it.title = `${it.title} · ${r.title?.split(" · ").pop() ?? ""}`
          it.output = r.output
          it.ms = ms
        }),
      )
    },
    diff(title: string, patch: string) {
      set(produce((s) => void s.items.push({ kind: "diff", id: nextId(), title, patch })))
    },
    clear() {
      set({ items: [], usage: undefined, used: undefined })
    },
    toggleReasoning() {
      set("showReasoning", (v) => !v)
    },
    toggleTools() {
      set("expandTools", (v) => !v)
    },
    /** Show a stored conversation. */
    load(messages: Message[]) {
      const items: Item[] = []
      const tools = new Map<string, Extract<Item, { kind: "tool" }>>()
      for (const m of messages) {
        if (m.role === "user" && m.parts[0]?.type === "text" && m.parts[0].text === CONTINUE_PROMPT)
          items.push({ kind: "user", id: nextId(), text: "↻ continue" })
        else if (m.role === "user" && m.parts[0]?.type === "text" && m.parts[0].text.startsWith(STEER_MARK))
          items.push({ kind: "user", id: nextId(), text: m.parts[0].text.slice(STEER_MARK.length).trim(), mid: true })
        else if (m.role === "user")
          // What was typed; attachments (@files, ! output) went to the model but are not shown again.
          items.push({ kind: "user", id: nextId(), text: m.parts.filter((p) => p.type === "text" && !ATTACHMENT.test(p.text)).map((p) => (p.type === "text" ? p.text : "")).join("\n") })
        else if (m.role === "assistant") {
          for (const p of m.parts) {
            if (p.type === "text" && p.text.trim()) {
              const it: Extract<Item, { kind: "assistant" }> = { kind: "assistant", id: nextId(), text: p.text, streaming: false }
              keepPrototypes(state.sessionId, it)
              items.push(it)
            }
            else if (p.type === "reasoning" && p.text.trim()) items.push({ kind: "reasoning", id: nextId(), text: p.text, streaming: false, started: 0 })
            else if (p.type === "tool_call") {
              let args: unknown
              try {
                args = JSON.parse(p.args)
              } catch {}
              const t: Extract<Item, { kind: "tool" }> = { kind: "tool", id: p.id, name: p.name, args, status: "done" }
              tools.set(p.id, t)
              items.push(t)
            }
          }
        } else {
          const t = tools.get(m.callId)
          if (t) {
            t.status = m.isError ? "error" : "done"
            t.output = m.content
            t.title = m.content.split("\n")[0]!.slice(0, 100)
          }
        }
      }
      set({ items, usage: undefined, used: undefined })
    },
  }
}

export interface CardHooks {
  ask?: (req: Parameters<Asker["ask"]>[0], local: LocalAsk) => Promise<AskReply>
  question?: (req: QuestionRequest, callId: string | undefined, local: LocalAsk<QuestionReply>) => Promise<QuestionReply>
  plan?: (req: PlanRequest, callId: string | undefined, local: LocalAsk<PlanReply>) => Promise<PlanReply>
}

export type View = ReturnType<typeof createView>
export type { Mode }
