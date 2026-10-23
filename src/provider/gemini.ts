// Google Gemini, native (`{base}/models/{id}:streamGenerateContent?alt=sse`), base
// https://generativelanguage.googleapis.com/v1beta. UNTESTED: no Gemini endpoint has been
// available to try it against (see the wiki's Working-notes).
import type { Effort } from "../config/schema.ts"
import { resolveKey } from "../config/load.ts"
import { DEFAULT_BUDGETS } from "./anthropic.ts"
import { Parts, record, recordFailure, retrying, statusOf } from "./common.ts"
import { authHeaders, joinUrl, request, tlsFor } from "./http.ts"
import { sseJson } from "./sse.ts"
import { estimateTokens, estimateValue } from "./tokens.ts"
import { ProviderError, type ChatRequest, type Client, type DiscoveredModel, type Message, type ResolvedModel, type StreamEvent, type ToolCallPart } from "./types.ts"

type Content = { role: "user" | "model"; parts: Record<string, unknown>[] }

// Checked against Hermes Agent (agent/gemini_native_adapter.py, agent/gemini_schema.py) and
// OpenCode (provider/transform.ts). Still untested against a real Gemini endpoint.

/** Gemini's own id, without an aggregator prefix. */
const bare = (id: string) => id.replace(/^(models|google|gemini)\//i, "")
/** Gemini 3 and later: tool calls and results carry ids, and thinking is a level, not a budget. */
export const isGemini3 = (id: string) => Number(/gemini-(\d+)/i.exec(bare(id))?.[1] ?? 0) >= 3
const LEGACY = /gemini-(?:(?:flash|pro)-)?[12](?:[.-]|$)/i
/** A call replayed without a signature (made by another model, or before signatures existed):
 *  Google's documented sentinel, without which Gemini 3 refuses the whole history. */
export const SKIP_SIGNATURE = "skip_thought_signature_validator"
/** Thought tokens count against maxOutputTokens, and Gemini's own default is low. */
export const DEFAULT_MAX_OUTPUT = 65535
const PLACEHOLDER = "[The previous response was interrupted before it completed.]"

// ── tool schemas ──────────────────────────────────────────────────────────────────────────────
// v1beta takes plain JSON Schema as `parametersJsonSchema`; only same-document $refs have to be
// inlined. Other API versions take `parameters`, an OpenAPI subset where one unknown key 400s the
// whole request, so that path drops everything outside the subset.

const ALLOWED = new Set(["type", "format", "title", "description", "nullable", "enum", "maxItems", "minItems", "properties", "required", "minProperties", "maxProperties", "minLength", "maxLength", "pattern", "example", "anyOf", "propertyOrdering", "default", "items", "minimum", "maximum"])
const STRUCTURAL: Record<string, string[]> = { array: ["items", "minItems", "maxItems"], object: ["properties", "required", "minProperties", "maxProperties", "propertyOrdering"] }
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)

export function geminiSchema(s: unknown): Record<string, unknown> {
  if (!isObj(s)) return {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(s)) {
    if (!ALLOWED.has(k)) continue
    if (k === "properties") {
      if (isObj(v)) out.properties = Object.fromEntries(Object.entries(v).map(([p, sub]) => [p, geminiSchema(sub)]))
    } else if (k === "items") out.items = geminiSchema(v)
    else if (k === "anyOf") {
      if (Array.isArray(v)) out.anyOf = v.filter(isObj).map(geminiSchema)
    } else out[k] = v
  }
  const types = out.type
  if (Array.isArray(types)) {
    delete out.type
    const real = types.filter((t): t is string => typeof t === "string" && t !== "null")
    if (!real.length) out.type = types.includes("null") ? "null" : "object"
    else if (real.length === 1) out.type = real[0]
    else {
      // Several types: one branch each, and the structure belongs on the branch it describes.
      const moved: Record<string, unknown> = {}
      for (const keys of Object.values(STRUCTURAL)) for (const k of keys) if (k in out) (moved[k] = out[k]), delete out[k]
      out.anyOf = real.map((t) => geminiSchema({ type: t, ...Object.fromEntries(Object.entries(moved).filter(([k]) => STRUCTURAL[t]?.includes(k))) }))
    }
    if (types.includes("null")) out.nullable = true
  }
  // Every enum entry must be a string, whatever the declared type.
  if (Array.isArray(out.enum) && (Array.isArray(types) || ["integer", "number", "boolean"].includes(out.type as string))) {
    const vals = [...new Set(out.enum.map((e) => (typeof e === "boolean" || (typeof e === "number" && Number.isFinite(e)) ? String(e) : typeof e === "string" ? e : undefined)).filter((e) => e !== undefined))]
    if (vals.length) out.enum = vals
    else delete out.enum
  }
  // `required` naming a property that is not there fails the entire request.
  if (Array.isArray(out.required)) {
    const names = isObj(out.properties) ? out.properties : {}
    const req = out.required.filter((r): r is string => typeof r === "string" && r in names)
    if (req.length) out.required = req
    else delete out.required
  }
  return out
}

/** For `parameters`: the subset, and never an empty schema. */
export function geminiParameters(s: unknown): Record<string, unknown> {
  const out = geminiSchema(s)
  return Object.keys(out).length ? out : { type: "object", properties: {} }
}

function inlineRefs(node: unknown, root: Record<string, unknown>, budget: { n: number }, stack: string[] = []): unknown {
  if (Array.isArray(node)) return node.map((x) => inlineRefs(x, root, budget, stack))
  if (!isObj(node)) return node
  const ref = node.$ref
  if (typeof ref !== "string") return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, inlineRefs(v, root, budget, stack)]))
  if (stack.includes(ref)) throw new Error(`circular $ref ${ref}`)
  if (--budget.n < 0) throw new Error("$ref budget exhausted")
  if (!ref.startsWith("#/")) throw new Error(`unresolvable $ref ${ref}`)
  let target: unknown = root
  for (const raw of ref.slice(2).split("/")) {
    const part = raw.replace(/~1/g, "/").replace(/~0/g, "~")
    target = isObj(target) ? target[part] : undefined
  }
  if (!isObj(target)) throw new Error(`unresolvable $ref ${ref}`)
  const inlined = inlineRefs(target, root, budget, [...stack, ref]) as Record<string, unknown>
  // Siblings of a $ref apply alongside it and win.
  const { $ref: _, ...siblings } = node
  return Object.keys(siblings).length ? { ...inlined, ...(inlineRefs(siblings, root, budget, stack) as object) } : inlined
}

/** For `parametersJsonSchema`: root $schema dropped, local $refs inlined, an object root. A schema
 *  whose refs cannot all be resolved goes as it is, so the provider names the real problem. */
export function geminiJsonSchema(s: unknown): Record<string, unknown> {
  if (!isObj(s) || !Object.keys(s).length) return { type: "object", properties: {} }
  const { $schema: _, ...rest } = structuredClone(s)
  let out: Record<string, unknown>
  try {
    out = inlineRefs(rest, rest, { n: 256 }) as Record<string, unknown>
  } catch {
    return rest
  }
  delete out.$defs
  delete out.definitions
  if (!Object.keys(out).length) return { type: "object", properties: {} }
  if (out.type === "object" && !("properties" in out)) out.properties = {}
  return out
}

/** `parametersJsonSchema` exists only on v1beta. */
export const acceptsJsonSchema = (base: string) => /\/v1beta\/*$/i.test(base.trim())

// ── history ───────────────────────────────────────────────────────────────────────────────────

/** A JSON Schema inside a function response is resolved by Gemini 3, and an unknown $ref 400s. */
const hasRef = (v: unknown): boolean => (Array.isArray(v) ? v.some(hasRef) : isObj(v) ? Object.entries(v).some(([k, x]) => (k === "$ref" && typeof x === "string" && x.startsWith("#/")) || hasRef(x)) : false)

function functionResponse(content: string, isError: boolean | undefined): Record<string, unknown> {
  if (isError) return { error: content }
  // A JSON object result goes structured; anything else under "output", as Google documents.
  if (/^\s*\{/.test(content))
    try {
      const parsed = JSON.parse(content)
      if (isObj(parsed) && !hasRef(parsed)) return parsed
    } catch {}
  return { output: content }
}

export function toGeminiContents(messages: Message[], vision: boolean, ids = false): Content[] {
  const out: Content[] = []
  const names = new Map<string, string>()
  const results = (c: Content) => c.parts.some((p) => "functionResponse" in p)
  const push = (role: Content["role"], parts: Record<string, unknown>[]) => {
    if (!parts.length) return
    const last = out[out.length - 1]
    // Same-role turns must merge (Gemini insists on alternation), except that a person's words are
    // never folded into a turn of tool results: Gemini 3 then reads them as part of the result and
    // answers with nothing. A placeholder model turn keeps the two apart.
    if (last && last.role === role && role === "user" && results(last) !== parts.some((p) => "functionResponse" in p)) out.push({ role: "model", parts: [{ text: PLACEHOLDER }] }, { role, parts })
    else if (last && last.role === role) last.parts.push(...parts)
    else out.push({ role, parts })
  }
  for (const m of messages) {
    if (m.role === "user")
      push(
        "user",
        m.parts.map((p) => (p.type === "text" ? { text: p.text } : vision ? { inlineData: { mimeType: p.mime, data: p.data } } : { text: "[image omitted: this model has no vision]" })),
      )
    else if (m.role === "assistant") {
      const parts: Record<string, unknown>[] = []
      for (const p of m.parts) {
        if (p.type === "text" && p.text.trim()) parts.push({ text: p.text })
        else if (p.type === "tool_call") {
          names.set(p.id, p.name)
          let args: unknown = {}
          try {
            args = p.args.trim() ? JSON.parse(p.args) : {}
          } catch {
            args = { _raw: p.args }
          }
          // Gemini 3 wants the thought signature back on the call it came with.
          parts.push({ functionCall: { name: p.name, args: isObj(args) ? args : { _value: args }, ...(ids ? { id: p.id } : {}) }, thoughtSignature: p.signature ?? SKIP_SIGNATURE })
        }
      }
      push("model", parts)
    } else push("user", [{ functionResponse: { name: names.get(m.callId) ?? m.name, response: functionResponse(m.content, m.isError), ...(ids ? { id: m.callId } : {}) } }])
  }
  return out
}

// ── thinking ──────────────────────────────────────────────────────────────────────────────────

const LEVELS = ["minimal", "low", "medium", "high"] as const
/** The levels a Gemini 3 model takes (OpenCode's table). */
function levelsOf(id: string): readonly string[] {
  const s = id.toLowerCase()
  if (s.includes("gemma") || s.includes("flash-image")) return ["minimal", "high"]
  if (s.includes("pro-image")) return ["high"]
  if (s.includes("flash")) return LEVELS
  return ["low", "medium", "high"]
}

export function thinkingConfig(id: string, effort: Effort, map?: Partial<Record<Effort, number>>): Record<string, unknown> {
  if (map?.[effort]) return { thinkingBudget: map[effort], includeThoughts: true }
  const b = bare(id)
  if (LEGACY.test(b)) {
    // 2.x takes a budget; 2.5 Pro goes to 32k, the rest to 24k.
    const max = /gemini-2[.-]5/i.test(b) && /pro/i.test(b) && !/flash/i.test(b) ? 32768 : 24576
    return { thinkingBudget: Math.min(DEFAULT_BUDGETS[effort], max), includeThoughts: true }
  }
  // 3 and later take a level: the one asked for, else the next one up the model has, else its top.
  const i = LEVELS.indexOf(effort as (typeof LEVELS)[number])
  const want = i < 0 ? LEVELS.length - 1 : i // xhigh and max: the top
  const have = levelsOf(b)
  const level = LEVELS.slice(want).find((l) => have.includes(l)) ?? have[have.length - 1]
  return { thinkingLevel: level, includeThoughts: true }
}

/** Keys sorted, so a call sent again compares equal to itself (as Hermes does). */
const sortedJson = (v: unknown) => JSON.stringify(v, (_, x) => (isObj(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x))

const FINISH: Record<string, string> = { STOP: "stop", MAX_TOKENS: "length", SAFETY: "content_filter", RECITATION: "content_filter", BLOCKLIST: "content_filter", PROHIBITED_CONTENT: "content_filter", SPII: "content_filter" }

export class GeminiClient implements Client {
  constructor(private m: ResolvedModel) {}

  private headers() {
    return authHeaders(this.m.connection, resolveKey(this.m.connectionName, this.m.connection), this.m.spec.headers)
  }

  buildBody(req: ChatRequest): Record<string, unknown> {
    const { m } = this
    const generationConfig: Record<string, unknown> = {}
    if (m.spec.temperature !== undefined) generationConfig.temperature = m.spec.temperature
    generationConfig.maxOutputTokens = m.spec.max_output ?? DEFAULT_MAX_OUTPUT
    if (m.spec.top_p !== undefined) generationConfig.topP = m.spec.top_p
    if (req.effort) generationConfig.thinkingConfig = thinkingConfig(m.id, req.effort, m.spec.effort_map)
    const body: Record<string, unknown> = { contents: toGeminiContents(req.messages, m.spec.vision === true, isGemini3(m.id)), generationConfig, ...m.connection.body, ...m.spec.body }
    if (req.system) body.systemInstruction = { parts: [{ text: req.system }] }
    if (req.tools.length && m.spec.tools !== false) {
      const json = acceptsJsonSchema(m.connection.base_url)
      body.tools = [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, ...(json ? { parametersJsonSchema: geminiJsonSchema(t.parameters) } : { parameters: geminiParameters(t.parameters) }) })) }]
    }
    return body
  }

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    const body = this.buildBody(req)
    yield* retrying(() => this.attempt(req, body))
  }

  private async *attempt(req: ChatRequest, body: Record<string, unknown>): AsyncGenerator<StreamEvent> {
    const { m } = this
    const url = joinUrl(m.connection.base_url, `models/${encodeURIComponent(m.id)}:streamGenerateContent?alt=sse`)
    const res = await request(url, { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal: req.signal, timeoutMs: (m.connection.timeout ?? 600) * 1000, tls: tlsFor(m.connection) }, m.ref).catch((e) => {
      recordFailure(m.ref, body, e)
      throw e
    })
    if (!res.body) throw new ProviderError(`${m.ref}: empty response`)
    const out = new Parts()
    let finish = "stop"
    let usage: StreamEvent | undefined
    // One slot per call. Gemini 3 ids its calls; 2.5 does not, restarts part numbering in every
    // event and may send a call again whole, so a payload repeating (or extending) a slot's arguments
    // is that call and anything else is a new one.
    const slots = new Map<string, { index: number; part: ToolCallPart }>()
    const slotFor = (fc: any, sig: string, at: number, args: string) => {
      if (typeof fc.id === "string" && fc.id) return `id:${fc.id}`
      const key = `${at}:${fc.name}:${sig}`
      const s = slots.get(key)
      if (!s || args.startsWith(s.part.args)) return key
      for (const [k, o] of slots) if (k.startsWith(`${key}#`) && args.startsWith(o.part.args)) return k
      return `${key}#${slots.size}`
    }
    for await (const { data } of sseJson(record(res.body, m.ref, body))) {
      const chunk = data as any
      if (chunk?.error) throw new ProviderError(`${m.ref}: ${chunk.error.message ?? JSON.stringify(chunk.error)}`, statusOf(chunk.error) ?? chunk.error.code, undefined, !out.output)
      const cand = chunk?.candidates?.[0]
      const parts: any[] = cand?.content?.parts ?? []
      for (const [at, p] of parts.entries()) {
        if (typeof p.text === "string" && p.text) {
          const kind = p.thought === true ? "reasoning" : "text"
          out.add(kind, p.text)
          yield { type: kind, text: p.text }
        }
        const fc = p.functionCall
        if (fc?.name) {
          const args = sortedJson(fc.args ?? {})
          const sig = typeof p.thoughtSignature === "string" ? p.thoughtSignature : ""
          const key = slotFor(fc, sig, at, args)
          let s = slots.get(key)
          if (!s) {
            s = { index: slots.size, part: { type: "tool_call", id: typeof fc.id === "string" && fc.id ? fc.id : `gemini_call_${slots.size}`, name: fc.name, args: "" } }
            slots.set(key, s)
            out.push(s.part)
          }
          const prev = s.part.args
          s.part.args = args
          if (sig) s.part.signature = sig
          yield { type: "tool_call_delta", index: s.index, name: fc.name, argsDelta: args.startsWith(prev) ? args.slice(prev.length) : args }
        }
      }
      if (cand?.finishReason) finish = FINISH[String(cand.finishReason).toUpperCase()] ?? "stop"
      const u = chunk?.usageMetadata
      if (u) usage = { type: "usage", usage: { input: u.promptTokenCount ?? 0, output: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0), reasoning: u.thoughtsTokenCount, cached: u.cachedContentTokenCount } }
    }
    const message = out.message()
    if (slots.size && finish !== "length") finish = "tool_calls"
    yield usage ?? { type: "usage", usage: { input: estimateValue(body.contents), output: message.parts.reduce((n, p) => n + estimateTokens(p.type === "tool_call" ? p.args : p.text), 0), estimated: true } }
    yield { type: "finish", reason: finish, message }
  }

  async listModels(): Promise<DiscoveredModel[]> {
    const res = await request(joinUrl(this.m.connection.base_url, "models?pageSize=200"), { headers: this.headers(), timeoutMs: 15_000, tls: tlsFor(this.m.connection) }, this.m.connectionName)
    const j = (await res.json()) as any
    return (j?.models ?? [])
      .filter((x: any) => !x.supportedGenerationMethods || x.supportedGenerationMethods.includes("generateContent"))
      .map((x: any) => ({ id: String(x.name ?? "").replace(/^models\//, ""), context: x.inputTokenLimit }))
      .filter((x: DiscoveredModel) => x.id)
  }
}
