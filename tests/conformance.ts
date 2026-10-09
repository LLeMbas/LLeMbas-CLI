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

type Case = Record<string, unknown>

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
