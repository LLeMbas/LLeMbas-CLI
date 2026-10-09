// `lembas run "…"`: one prompt, no TUI. Text goes to stdout, tool lines and notices to stderr
// (so the answer can be piped), or everything as JSON lines with --json.
import { createInterface } from "node:readline/promises"
import type { Asker, AskReply, Bus, Event } from "./bus/index.ts"
import { unattendedReply, type Answer, type QuestionReply, type QuestionRequest } from "./tool/question.ts"
import type { PlanReply } from "./tool/plan_exit.ts"
import type { IconSet } from "./tui/icons.ts"
import { loadTheme, type Theme } from "./tui/palette.ts"
import { duration } from "./duration.ts"

/** The theme's colours as 24-bit escapes — the same theme the TUI uses (`theme` in config.yaml). */
function escapes(theme: Theme) {
  const fg = (hex: string) => {
    const n = Number.parseInt(hex.slice(1), 16)
    return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`
  }
  const k = theme.colors
  return { label: fg(k.label), dim: fg(k.dim), ok: fg(k.ok), err: fg(k.error), warn: fg(k.warn), think: "\x1b[2;3m", reset: "\x1b[0m" }
}

export function renderPlain(bus: Bus, opts: { color: boolean; showReasoning: boolean; icons?: IconSet; theme?: string }) {
  const theme = loadTheme(opts.theme, opts.icons).theme
  const C = escapes(theme)
  const icon = (name: string) => theme.toolEmoji[name] ?? (name.startsWith("mcp__") ? theme.icons.mcp : theme.icons.other)
  const c = (code: string, s: string) => (opts.color ? code + s + C.reset : s)
  let inReasoning = false
  let atLineStart = true
  let started = false
  const out = (s: string) => {
    if (!s) return
    process.stdout.write(s)
    atLineStart = s.endsWith("\n")
  }
  const line = (s: string) => {
    if (!atLineStart) out("\n")
    process.stderr.write(s + "\n")
  }
  bus.on((e: Event) => {
    if (e.type !== "reasoning" && inReasoning) {
      inReasoning = false
      if (opts.showReasoning) out("\n")
    }
    switch (e.type) {
      case "text": {
        // Models often open with blank lines (after their reasoning); they are not the answer.
        const t = started ? e.text : e.text.trimStart()
        if (t) started = true
        out(t)
        break
      }
      case "reasoning":
        if (!opts.showReasoning) break
        inReasoning = true
        out(c(C.think, e.text))
        break
      case "tool_end": {
        const verb = e.name.padEnd(6)
        const mark = e.result.isError ? c(C.err, "✗") : ""
        const title = e.result.title ?? (e.result.isError ? e.result.output.split("\n")[0]!.slice(0, 120) : "")
        line(`${c(C.dim, "┊")} ${icon(e.name)} ${c(C.label, verb)} ${title} ${c(C.dim, duration(e.ms))} ${mark}`)
        break
      }
      case "sub_tool":
        line(`    ${c(C.dim, "┊")} ${icon(e.name)} ${c(C.dim, e.name.padEnd(6))} ${e.title}`)
        break
      case "tool_denied":
        line(`${c(C.dim, "┊")} ${theme.icons.denied} ${c(C.warn, e.name.padEnd(6))} ${e.reason.split("\n")[0]!.slice(0, 140)}`)
        break
      case "retract":
        if (!atLineStart) out("\n")
        started = false
        break
      case "notice":
        line(c(C.warn, `⚠ ${e.message}`))
        break
      case "error":
        line(c(C.err, `✗ ${e.message}`))
        break
      case "done":
        if (!atLineStart) out("\n")
        if (e.reason === "steps") line(c(C.warn, "⚠ stopped at the step limit"))
        break
    }
  })
}

export function renderJson(bus: Bus) {
  bus.on((e) => process.stdout.write(JSON.stringify(e) + "\n"))
}

/** Asks on the terminal when there is one; otherwise follows --yes, or refuses. */
export function terminalAsker(opts: { yes: boolean; unattended?: "recommended" | "first" | "fail"; theme?: string }): Asker {
  const C = escapes(loadTheme(opts.theme).theme)
  return {
    // With nobody at a terminal there is no plan method at all: plan_exit then saves and stops.
    ...(process.stdin.isTTY && !opts.yes
      ? {
          async plan(req: { path: string; text: string }): Promise<PlanReply> {
            const rl = createInterface({ input: process.stdin, output: process.stderr })
            try {
              process.stderr.write(`\n${C.label}── plan: ${req.path} ──${C.reset}\n${req.text}\n${C.label}──${C.reset}\n`)
              const a = (await rl.question("  [a]pprove (edit mode)  [m]anual mode  [r]evise…  [?] ask back…  [enter] keep planning › ")).trim().toLowerCase()
              if (a === "a") return { kind: "approve", mode: "edit" }
              if (a === "m") return { kind: "approve", mode: "manual" }
              if (a === "r") return { kind: "revise", feedback: (await rl.question("  what should change? ")).trim() }
              if (a === "?") return { kind: "back", text: (await rl.question("  your question: ")).trim() }
              return { kind: "dismissed" }
            } finally {
              rl.close()
            }
          },
        }
      : {}),
    async question(req: QuestionRequest): Promise<QuestionReply> {
      if (opts.yes || !process.stdin.isTTY) return unattendedReply(req, opts.unattended ?? "recommended")
      const rl = createInterface({ input: process.stdin, output: process.stderr })
      try {
        if (req.why) process.stderr.write(`\n${C.dim}${req.why}${C.reset}\n`)
        const answers: Answer[] = []
        for (const [i, q] of req.questions.entries()) {
          process.stderr.write(`\n${C.warn}? [${q.header}]${C.reset} ${q.question}${req.questions.length > 1 ? ` (${i + 1}/${req.questions.length})` : ""}\n`)
          q.options.forEach((o, n) =>
            process.stderr.write(`  ${n + 1}. ${o.label}${o.recommended ? " (Recommended)" : ""}${o.description ? `${C.dim} — ${o.description}${C.reset}` : ""}\n`),
          )
          const hint = `number${q.multiple ? "s (1,3)" : ""}, your own answer, ?question to ask back${q.options.some((o) => o.recommended) ? ", enter = recommended" : ""}, - to skip all`
          const raw = (await rl.question(`  ${C.dim}${hint}${C.reset} › `)).trim()
          if (raw === "-") return { dismissed: true }
          if (raw.startsWith("?")) answers.push({ kind: "back", text: raw.slice(1).trim() })
          else if (!raw) {
            const rec = q.options.find((o) => o.recommended) ?? q.options[0]
            answers.push(rec ? { kind: "options", labels: [rec.label] } : { kind: "custom", text: "" })
          } else if (/^\d+(\s*,\s*\d+)*$/.test(raw)) {
            const picked = raw.split(",").map((n) => q.options[Number(n) - 1]?.label).filter((l): l is string => !!l)
            answers.push(picked.length ? { kind: "options", labels: q.multiple ? picked : picked.slice(0, 1) } : { kind: "custom", text: raw })
          } else answers.push({ kind: "custom", text: raw })
        }
        return { answers }
      } finally {
        rl.close()
      }
    },
    async ask({ tool, args, request, decision, preview, purpose }): Promise<AskReply> {
      if (opts.yes) return { kind: "once" }
      if (!process.stdin.isTTY)
        return { kind: "deny", final: true, feedback: `nobody is present to approve ${tool} in this headless run.` }
      const what = request.command ?? request.patterns.join(", ")
      const rl = createInterface({ input: process.stdin, output: process.stderr })
      try {
        process.stderr.write(`\n${C.warn}? ${tool}${C.reset} ${what}\n`)
        if (purpose) process.stderr.write(`  ${C.label}${purpose}${C.reset}\n`)
        if (preview?.diff)
          for (const l of preview.diff.split("\n").filter((l) => !/^(Index:|={5,}|--- |\+\+\+ )/.test(l)))
            process.stderr.write(`  ${l.startsWith("+") ? C.ok : l.startsWith("-") ? C.err : l.startsWith("@@") ? C.dim : ""}${l}${C.reset}\n`)
        if (preview?.error) process.stderr.write(`  ${C.err}this will fail: ${preview.error}${C.reset}\n`)
        process.stderr.write(`  ${C.dim}${decision.reason}${C.reset}\n`)
        void args
        const always = decision.always.length ? ` (${decision.always.join(", ")})` : ""
        const answer = (await rl.question(`  [y]es  [s]ession-always${always}  [p]roject-always  [n]o  [r]eason… `)).trim().toLowerCase()
        if (answer === "y" || answer === "yes") return { kind: "once" }
        if (answer === "s") return { kind: "session" }
        if (answer === "p") return { kind: "project" }
        if (answer === "r") return { kind: "deny", feedback: (await rl.question("  why? ")).trim() }
        return { kind: "deny" }
      } finally {
        rl.close()
      }
    },
  }
}
