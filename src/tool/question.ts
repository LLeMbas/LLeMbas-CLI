// The question tool. Its design merges three: LLeMbas' ask_user (options with explanations,
// everything in one call, an automatic free-text row, lenient with small models' shapes),
// OpenCode's question (a short header, `multiple`, the recommended option first) and Hermes'
// clarify — and adds what none of them has: the user may answer with a question of their own.
import { z } from "zod"
import { defineTool, ToolError } from "./tool.ts"
import { described } from "../harness.ts"

export interface QuestionOption {
  label: string
  description?: string
  recommended?: boolean
}

export interface Question {
  header: string
  question: string
  options: QuestionOption[]
  multiple?: boolean
}

export interface QuestionRequest {
  why?: string
  questions: Question[]
}

export type Answer = { kind: "options"; labels: string[] } | { kind: "custom"; text: string } | { kind: "back"; text: string }
export type QuestionReply = { dismissed: true } | { dismissed?: false; answers: Answer[]; auto?: string }

/** What the model is told when nobody can answer (also where a client that cannot show the card
 *  holds the session). */
export const NOBODY_TO_ASK = "Nobody can be asked in this context. Choose the most reasonable option, carry on, and say what you assumed."

const MAX_Q = 4
const MAX_OPT = 6

// Small models send options as bare strings, a single question without the array, "choices"
// instead of "options"… all of it is accepted and normalised, as LLeMbas does.
const OptionIn = z.preprocess(
  (o) => (typeof o === "string" ? { label: o } : o),
  z.object({
    label: z.string().min(1),
    description: z.string().optional(),
    recommended: z.boolean().optional(),
  }),
)
const QuestionIn = z.preprocess(
  (q) => {
    if (!q || typeof q !== "object") return q
    const x = { ...(q as Record<string, unknown>) }
    x.options ??= x.choices
    x.header ??= String(x.question ?? "").split(/[?.:]/)[0]!.slice(0, 30)
    return x
  },
  z.object({
    header: z.string(),
    question: z.string().min(1),
    options: z.array(OptionIn).max(MAX_OPT).default([]),
    multiple: z.boolean().optional(),
  }),
)

export const questionSchema = z.preprocess(
  (a) => {
    if (!a || typeof a !== "object") return a
    const x = a as Record<string, unknown>
    if (!x.questions && (x.question || x.options)) return { why: x.why, questions: [x] }
    return x
  },
  z.object({
    why: z.string().optional(),
    questions: z.array(QuestionIn).min(1).max(MAX_Q),
  }),
)

export const askUserTool = defineTool({
  ...described("ask_user"),
  purpose: false,
  access: "ask_user",
  exclusive: true,
  schema: questionSchema,
  permission: () => ({ permission: "ask_user", class: "interact", patterns: ["*"] }),
  async run(args, ctx) {
    if (!ctx.question) throw new ToolError(NOBODY_TO_ASK)
    const req = args as QuestionRequest
    for (const q of req.questions) {
      // Keep one recommendation at most, and put it first.
      let seen = false
      for (const o of q.options) if (o.recommended) (seen ? (o.recommended = false) : (seen = true))
      q.options.sort((a, b) => Number(!!b.recommended) - Number(!!a.recommended))
    }
    const reply = await ctx.question(req, ctx.callId)
    return { output: formatAnswers(req, reply), title: summary(req, reply) }
  },
})

function summary(req: QuestionRequest, reply: QuestionReply): string {
  if (reply.dismissed) return `${req.questions.length} question${req.questions.length > 1 ? "s" : ""} · dismissed`
  return req.questions.map((q, i) => `${q.header}: ${short(reply.answers[i])}`).join(" · ")
}

function short(a: Answer | undefined): string {
  if (!a) return "—"
  if (a.kind === "options") return a.labels.join(", ")
  if (a.kind === "custom") return `“${a.text.slice(0, 40)}”`
  return `asked back`
}

export function formatAnswers(req: QuestionRequest, reply: QuestionReply): string {
  if (reply.dismissed)
    return "The user dismissed the questions without answering. Do not ask them again. Continue with your best judgement, and say what you assumed."
  const lines: string[] = []
  const back: number[] = []
  req.questions.forEach((q, i) => {
    lines.push(`Q${i + 1} [${q.header}] ${q.question}`)
    const a = reply.answers[i]
    if (!a) lines.push("→ (no answer)")
    else if (a.kind === "options") {
      const rec = q.options.find((o) => o.recommended)?.label
      lines.push(`→ ${a.labels.map((l) => (l === rec ? `${l} (the one you recommended)` : l)).join(", ")}${reply.auto ? ` (${reply.auto})` : ""}`)
    } else if (a.kind === "custom") lines.push(`→ custom: "${a.text}"`)
    else {
      lines.push(`↩ counter-question: "${a.text}"`)
      back.push(i + 1)
    }
  })
  if (back.length) {
    const final = req.questions.map((_, i) => i + 1).filter((n) => !back.includes(n))
    lines.push(
      "",
      `${final.length ? `Q${final.join(", Q")} ${final.length > 1 ? "are" : "is"} answered. ` : ""}Instead of answering Q${back.join(", Q")}, the user asked you a question. Answer it in your reply, then call question again with only Q${back.join(", Q")} — adjusted if your answer changes the options.`,
    )
  }
  return lines.join("\n")
}

/** For headless runs with nobody present: config question.unattended. */
export function unattendedReply(req: QuestionRequest, policy: "recommended" | "first" | "fail"): QuestionReply {
  if (policy === "fail") return { dismissed: true }
  return {
    auto: policy === "recommended" ? "chosen automatically: nobody is present, so the recommended option was taken" : "chosen automatically: nobody is present, so the first option was taken",
    answers: req.questions.map((q) => {
      const o = (policy === "recommended" ? q.options.find((x) => x.recommended) : undefined) ?? q.options[0]
      return o ? { kind: "options", labels: [o.label] } : { kind: "custom", text: "(no answer: nobody is present)" }
    }),
  }
}
