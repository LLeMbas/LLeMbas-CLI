import type { Mode } from "../config/schema.ts"
import type { Decision, PermissionRequest } from "../permission/evaluate.ts"
import type { Usage } from "../provider/types.ts"
import type { Plan } from "../plan/plan.ts"
import type { PlanReply, PlanRequest } from "../tool/plan_submit.ts"
import type { QuestionReply, QuestionRequest } from "../tool/ask_user.ts"
import type { ToolResult } from "../tool/tool.ts"

// Everything the engine does is announced here. The TUI, the headless renderer and the tests
// are all just subscribers — the engine knows none of them.
export type Event =
  | { type: "session"; id: string; model: string; mode: Mode }
  /** The session open before a resume was empty and is gone from the store. `shown`: it had
   *  been in the web UI's hands, so the instance is to hear of it (acp/share.ts). */
  | { type: "discarded"; id: string; shown: boolean }
  /** A prompt starts: `text` as the user sees it (a command's name, not its expanded body).
   *  `turnId`: the turn it starts, the web UI's message id or one made here, so a client
   *  matches the turn to its own row by id rather than by timing. `attachments`: what went with it
   *  (pasted images, @files, a web upload), for chips beside the text. */
  | { type: "prompt"; text: string; turnId?: string; attachments?: AttachmentInfo[]; /** The harness started the turn, not the person: a job's note (jobs/note.ts), beginning with its mark. */ machine?: true }
  | { type: "step"; n: number }
  /** The session was named (or renamed). */
  | { type: "title"; id: string; title: string }
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call_delta"; index: number; name?: string; argsDelta: string }
  /** The server reading the prompt, before the reply (llama.cpp): tokens in all, from its cache, read so far. */
  | { type: "progress"; total: number; cache: number; processed: number; ms: number }
  | { type: "tool_start"; id: string; name: string; args: unknown }
  | { type: "tool_end"; id: string; name: string; result: ToolResult; ms: number }
  | { type: "tool_denied"; id: string; name: string; reason: string }
  | {
      type: "usage"
      usage: Usage
      context?: number
      /** What the next request will hold, where the engine knows better than input + output. */
      used?: number
      /** Output tokens per second in this step's reply. */
      rate?: number
      /** A subagent's: counts toward the task, says nothing about the session's context. */
      child?: boolean
    }
  /** Messages the user sent while the task runs, not yet given to the model. */
  | { type: "inbox"; texts: string[]; mode: "steer" | "queue" }
  /** Those messages, given to the model now: at a step boundary, after the last step's tool results. */
  /** `ids`: the ids their senders gave them (the web UI's message ids), where there were any. */
  | { type: "steered"; texts: string[]; ids?: string[] }
  /** A task — one prompt, with every step and tool it takes — starts or ends; `turnId` as on `prompt`. */
  | { type: "task"; state: "start" | "end"; turnId?: string }
  | { type: "notice"; message: string; level?: "info" | "warn" }
  /** Discard the reply streamed so far in this step: it is being retried. */
  | { type: "retract" }
  /** The session's plan was written, changed or cleared (plan_write, plan_update, /new). */
  | { type: "plan"; plan: Plan | undefined }
  /** The conversation was replaced by a summary of it (/compact, or automatically). */
  | { type: "compacted"; summary: string }
  /** A subagent's tool call finished (shown under the task line); `jobId`: its job, when it runs as one. */
  | { type: "sub_tool"; callId: string; jobId?: string; name: string; title: string; isError?: boolean }
  /** A background job of the session began, has news (new output, a subagent's step — at most four
   *  a second per job), or ended (jobs/registry.ts). */
  | { type: "job"; state: "start" | "update" | "end"; job: import("../jobs/registry.ts").JobInfo }
  /** The note about that job was given to the model: inside a turn at its next step, or as the
   *  `machine` turn whose `prompt` follows. */
  | { type: "job_note"; jobId: string; text: string }
  /** The permission mode changed from inside a turn (plan approved). */
  | { type: "mode"; mode: Mode }
  /** The session's model or effort changed, for whatever reason — /model, /effort, the settings
   *  tool, a fallback, the web UI. `effort`: a level, or "off". */
  | {
      type: "model"
      ref: string
      effort: string
      /** The connection it is spoken to through: a login's webui connection for an
       *  instance's model, whatever its ref says. */
      connection?: string
      /** Added by the link: the model is this link's instance's — the chat can take it. */
      instance?: boolean
    }
  /** A word in the status bar that goes by itself ("Updated to 1.2.0"). */
  | { type: "flash"; text: string }
  /** A setting changed (/settings, the settings tool, a command): front ends redraw what shows it. */
  | { type: "setting"; key: string; value: unknown }
  | { type: "error"; message: string }
  | { type: "done"; reason: "stop" | "steps" | "budget" | "cancelled" | "error" }

/** What went with a prompt, as a client shows it: a chip, not the content. */
export interface AttachmentInfo {
  name: string
  mimeType: string
  size: number
}

export type Listener = (e: Event) => void

export class Bus {
  private listeners = new Set<Listener>()
  on(l: Listener): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
  emit(e: Event) {
    for (const l of this.listeners) l(e)
  }
}

export type AskReply =
  /** `command`: the user corrected the command line before allowing it (a command's card only). */
  | { kind: "once"; command?: string }
  | { kind: "session" }
  | { kind: "project" }
  /** `final`: this will be refused every time in this session (nobody to ask) — stop offering the tool. */
  | { kind: "deny"; feedback?: string; final?: boolean }

/** Whoever answers permission questions: the TUI's dialog, a y/n prompt, or a policy in headless runs. */
export interface Asker {
  /** `preview`: the change the call would make (a unified diff), or why it could not be worked out. */
  ask(req: {
    tool: string
    args: unknown
    request: PermissionRequest
    decision: Decision
    preview?: { diff?: string; error?: string }
    /** What the model says the call is for. */
    purpose?: string
    /** Set when a subagent running as a background job asks, so the card can say which — it may
     *  ask while the session itself is idle. */
    source?: { jobId: string; agent: string; description: string }
  }): Promise<AskReply>
  /** The ask_user tool. Absent: the tool reports that nobody can be asked. `callId`: the tool call's
   *  id, which keys the card on another screen. */
  question?(req: QuestionRequest, callId?: string): Promise<QuestionReply>
  /** plan_submit. Absent: the plan is saved and the model told to stop. */
  plan?(req: PlanRequest, callId?: string): Promise<PlanReply>
}
