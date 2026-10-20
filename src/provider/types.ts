import type { Connection, Effort, ModelSpec } from "../config/schema.ts"

// Provider-neutral conversation model. Every dialect converts to and from this.

export type TextPart = { type: "text"; text: string }
export type ImagePart = { type: "image"; mime: string; data: string /* base64 */ }
/** `signature` / `opaque` carry what a provider needs echoed back on the next turn
 *  (Anthropic thinking signatures, Gemini thought signatures, Responses encrypted reasoning). */
export type ReasoningPart = { type: "reasoning"; text: string; signature?: string; opaque?: unknown }
/** `signature`: Gemini's thought signature, which must travel back with the call. */
export type ToolCallPart = { type: "tool_call"; id: string; name: string; args: string /* raw JSON */; signature?: string }

export type Message =
  /** `turnId`: the turn a prompt started, kept with it in the store for
   *  `_lembas/session/history`; never sent to a model. */
  | { role: "user"; parts: (TextPart | ImagePart)[]; turnId?: string; /** The harness wrote it (a job's note), not the person: shown as such. */ machine?: true }
  | { role: "assistant"; parts: (TextPart | ReasoningPart | ToolCallPart)[] }
  | { role: "tool"; callId: string; name: string; content: string; isError?: boolean }

export interface ToolSpec {
  name: string
  description: string
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>
}

export interface Usage {
  input: number
  output: number
  reasoning?: number
  cached?: number
  /** True when the endpoint reported nothing and these are estimates. */
  estimated?: boolean
}

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  /** Partial tool-call progress, for the UI. */
  | { type: "tool_call_delta"; index: number; name?: string; argsDelta: string }
  | { type: "usage"; usage: Usage }
  /** How far the server is through reading the prompt, before the reply starts (llama.cpp's
   *  return_progress): tokens in all, taken from its cache, and read so far; ms spent reading. */
  | { type: "progress"; total: number; cache: number; processed: number; ms: number }
  | { type: "finish"; reason: string; message: Extract<Message, { role: "assistant" }> }
  /** Something worth telling the user that is not an error, e.g. a retry. */
  | { type: "notice"; message: string }

export interface ChatRequest {
  system: string
  messages: Message[]
  tools: ToolSpec[]
  /** null = off */
  effort?: Effort | null
  signal?: AbortSignal
}

export interface ResolvedModel {
  /** `connection/model` */
  ref: string
  connectionName: string
  connection: Connection
  id: string
  spec: ModelSpec
}

export interface DiscoveredModel {
  id: string
  context?: number
}

export interface Client {
  stream(req: ChatRequest): AsyncGenerator<StreamEvent>
  listModels(): Promise<DiscoveredModel[]>
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
    /** Nothing of the model's reply had been passed on yet, so a retry cannot duplicate output. */
    readonly beforeOutput = status !== undefined,
    /** The server could not be reached at all (refused, no route, no answer): another may be. */
    readonly unreachable = false,
  ) {
    super(message)
  }
}
