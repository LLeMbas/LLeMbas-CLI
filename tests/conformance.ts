// What the CLI does with each conformance case (harness/conformance/*.json). The cases are the
// harness spec's: LLeMbas runs the same files through its own implementation. The test compares
// this with each case's `expect`; `bun run harness record` fills in an `expect` a new case lacks.
import { alwaysPatterns, toRules, evaluate, DEFAULT_RULES, type PermissionRequest } from "../src/permission/evaluate.ts"
import { BUILTIN_HARDLINE, hardlineCommand, plainCommands } from "../src/permission/hardline.ts"
import { splitCommand, words } from "../src/permission/bash.ts"
import { prefix } from "../src/permission/arity.ts"
import { split } from "../src/library/chunks.ts"
import { ThinkSplitter } from "../src/provider/think.ts"
import { advertisedEfforts, effortRefused } from "../src/provider/effort.ts"
import { replace } from "../src/tool/replace.ts"
import { applyUnified, parseUnified } from "../src/tool/unidiff.ts"
import { derive, joinBom, parse } from "../src/tool/patch.ts"
import type { Mode, PermissionConfig } from "../src/config/schema.ts"
import { apply, fromTodos, normalise, type Plan } from "../src/plan/plan.ts"
import { ToolCallAccumulator } from "../src/provider/openai-chat.ts"
import { parseInfo, titleFor } from "../src/prototype/fence.ts"
import { resolveBase } from "../src/library/store.ts"
import { NarrowError, narrowParameters, type Narrow } from "../src/harness.ts"
import { fillPrompt } from "../src/prompt/fill.ts"
import { instructionChain } from "../src/prompt/assemble.ts"
import { applyOps, type Op, type Target } from "../src/memory/store.ts"
import { jobNote, type NoteCase } from "../src/jobs/note.ts"

type Case = Record<string, unknown>

/** Whether a path is at `ro` or above under `grants` (fs_access's rule: the most specific grant on
 *  the path or above it wins; none where nothing is granted). No grants at all: everything readable. */
function readableUnder(grants: Record<string, string> | undefined, path: string): boolean {
  if (!grants) return true
  let best: string | undefined
  for (const g of Object.keys(grants)) {
    const covers = g === "/" || path === g || path.startsWith(g + "/")
    if (covers && (best === undefined || g.length > best.length)) best = g
  }
  return best !== undefined && grants[best] !== "none"
}

export const AREAS: Record<string, (c: Case) => unknown> = {
  hardline: (c) => hardlineCommand(c.line as string, BUILTIN_HARDLINE)?.id ?? null,
  split: (c) => splitCommand(c.line as string),
  plain: (c) => plainCommands(c.line as string),
  arity: (c) => prefix(words(c.command as string)).join(" "),
  always: (c) => {
    const line = c.line as string
    const split = splitCommand(line)
    // What an approval card offers to remember: nothing when the split cannot be trusted.
    if (split.unsafe.length) return []
    return alwaysPatterns({ permission: "bash", class: "execute", patterns: [line], command: line }, split.commands.length ? split.commands : [line])
  },
  permission: (c) => {
    const line = c.line as string
    const req: PermissionRequest = { permission: "bash", class: "execute", patterns: [line], command: line, paths: ["/project"] }
    const rules = [...toRules(DEFAULT_RULES, "default"), ...toRules((c.rules ?? {}) as PermissionConfig, "global")]
    return evaluate(req, { mode: c.mode as Mode, rules, hardline: BUILTIN_HARDLINE, root: "/project", planDir: "/project/.agent/plans", projectDir: "/project/.agent" }).action
  },
  chunk: (c) => split(c.text as string, c.size as number, c.overlap as number),
  think: (c) => {
    const s = new ThinkSplitter()
    const pieces = [...(c.chunks as string[]).flatMap((x) => s.feed(x)), ...s.flush()]
    const out = { reasoning: "", text: "" }
    for (const p of pieces) out[p.kind] += p.text
    return out
  },
  effort: (c) => ({ refused: effortRefused(c.message as string), advertised: advertisedEfforts(c.message as string) }),
  edit: (c) => {
    try {
      return { content: replace(c.content as string, c.old as string, c.new as string, c.all === true) }
    } catch (e) {
      return { error: (e as Error).message }
    }
  },
  unidiff: (c) => {
    try {
      const files = parseUnified(c.patch as string)
      return { content: applyUnified(c.content as string, files.flatMap((f) => f.hunks)) }
    } catch (e) {
      return { error: (e as Error).message }
    }
  },
  plan: (c) => {
    if (c.op === "normalise") return normalise(c.plan)
    if (c.op === "update") return apply(c.plan as Plan, c.changes)
    if (c.op === "todos") return fromTodos(c.todos)
    throw new Error(`plan: unknown op ${String(c.op)}`)
  },
  prototype: (c) => {
    const info = parseInfo(c.info as string)
    return info ? { kind: info.kind, title: titleFor(c.code as string, info.title) } : null
  },
  fill: (c) => {
    try {
      return { text: fillPrompt(c.text as string, c.vars as Record<string, string>) }
    } catch (e) {
      // "prompt: no value for {{a}}, {{c}}": the names, sorted.
      return { missing: [...(e as Error).message.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!).sort() }
    }
  },
  narrow: (c) => {
    try {
      return { parameters: narrowParameters(c.parameters as Record<string, unknown>, c.narrow as Narrow) }
    } catch (e) {
      if (e instanceof NarrowError) return { error: e.code }
      throw e
    }
  },
  memory: (c) => {
    const r = applyOps(c.target as Target, c.entries as string[], c.ops as Op[], c.limit as number)
    return { ok: r.ok, entries: r.ok ? r.after : c.entries, message: r.message, usage: r.usage, shown: Boolean(r.entries) }
  },
  jobs: (c) => jobNote(c as unknown as NoteCase),
  // The instruction chain (filesystem.md): the CLI's own walk, with the case's files and grants as
  // what it may read.
  instructions: (c) => {
    const files = new Set(c.files as string[])
    return instructionChain(c.boundary as string, c.start as string, (p) => files.has(p) && readableUnder(c.grants as Record<string, string> | undefined, p))
  },
  library_scope: (c) => resolveBase(c.bases as { id: string; name: string }[], c.base as string | null),
  toolcall_index: (c) => {
    // The deltas as the OpenAI stream carries them: `function.name` and `function.arguments`.
    const acc = new ToolCallAccumulator()
    acc.feed((c.deltas as Record<string, unknown>[]).map(({ index, id, name, arguments: args }) => ({ index, id, function: { name, arguments: args } })))
    return acc.result().map((p) => ({ id: p.id, name: p.name, arguments: p.args }))
  },
  envelope: (c) => {
    // planPatch's logic without the filesystem: every file followed through the patch in memory.
    const files = new Map<string, string | null>(Object.entries(c.files as Record<string, string>))
    try {
      for (const h of parse(c.patch as string)) {
        const text = files.get(h.path) ?? null
        if (h.type === "add") {
          if (text !== null) throw new Error(`${h.path} already exists; use Update File to change it.`)
          files.set(h.path, h.contents.endsWith("\n") ? h.contents : h.contents + "\n")
        } else if (h.type === "delete") {
          if (text === null) throw new Error(`${h.path} does not exist.`)
          files.set(h.path, null)
        } else {
          if (text === null) throw new Error(`${h.path} does not exist.`)
          const next = derive(h.path, h.chunks, text)
          if (h.movePath) files.set(h.path, null)
          files.set(h.movePath ?? h.path, joinBom(next.content, next.bom))
        }
      }
      return { files: Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b))) }
    } catch (e) {
      return { error: (e as Error).message }
    }
  },
}
