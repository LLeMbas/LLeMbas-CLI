// What the CLI does with each conformance case (harness/conformance/*.json). The cases are the
// harness spec's: LLeMbas runs the same files through its own implementation. The test compares
// this with each case's `expect`; `bun run harness record` fills in an `expect` a new case lacks.
import { alwaysPatterns, toRules, evaluate, DEFAULT_RULES, type PermissionRequest } from "../src/permission/evaluate.ts"
import { BUILTIN_HARDLINE, hardlineCommand, plainCommands } from "../src/permission/hardline.ts"
import { splitCommand, words } from "../src/permission/bash.ts"
import { prefix } from "../src/permission/arity.ts"
import { split } from "../src/library/chunks.ts"
import { ThinkSplitter } from "../src/provider/think.ts"
import { advertisedEfforts, effortRefused, levelFields, levelsOf, type LevelMeta } from "../src/provider/effort.ts"
import { replace } from "../src/tool/replace.ts"
import { applyUnified, parseUnified } from "../src/tool/unidiff.ts"
import { derive, joinBom, parse } from "../src/tool/patch.ts"
import type { Mode, PermissionConfig } from "../src/config/schema.ts"
import { apply, fromTodos, normalise, type Plan } from "../src/plan/plan.ts"
import { ToolCallAccumulator, toOpenAIMessages } from "../src/provider/openai-chat.ts"
import type { Message } from "../src/provider/types.ts"
import { parseInfo, titleFor } from "../src/prototype/fence.ts"
import { resolveBase } from "../src/library/store.ts"
import { NarrowError, narrowParameters, type Narrow } from "../src/harness.ts"
import { fillPrompt } from "../src/prompt/fill.ts"
import { instructionChain } from "../src/prompt/assemble.ts"
import { CONTEXT, hunks, lineCount, memoryResults, presentIds, ResultContext, sha256 } from "../src/session/results.ts"
import { readBody } from "../src/tool/read.ts"
import { applyOps, type Op, type Target } from "../src/memory/store.ts"
import { jobNote, type NoteCase } from "../src/jobs/note.ts"
import { compactAsk, noteFor, offeredFor, toldAt, unavailable, type Now, type Requirement, type Told } from "../src/session/prefix.ts"
import { envLines, promptText } from "../src/prompt/assemble.ts"
import { absPath, type ToolContext } from "../src/tool/tool.ts"
import { LOOP, TOOL_SPECS } from "../src/harness.ts"
import { Team, TEAM_TOOLS, type Capacity } from "../src/team/team.ts"
import { noteBlock } from "../src/session/prefix.ts"
import { offer, subagentModel, type ModelInfo } from "../src/team/subagents.ts"

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
  // Effort levels (models/schema.json `levels`): what a model offers, how it is shown, where it
  // starts, and what a request carries for a level.
  levels: (c) => {
    const meta = c.model as LevelMeta
    if (c.op === "levels") return levelsOf(meta)
    if (c.op === "request") return levelFields(meta, c.level as string)
    throw new Error(`levels: unknown op ${String(c.op)}`)
  },
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
  // Context hygiene: one session's insertions, step by step. `messages` is the request being built
  // (what a stub may point at); `history` the results since the last compaction, which its table
  // is drawn from. `reply` starts a request that carries none of them, as a chat's next reply does.
  context: (c) => {
    const messages: { role: string; content: string }[] = []
    const history = new Set<string>()
    const store = memoryResults()
    const rc = new ResultContext(store, () => presentIds(messages), { ...CONTEXT.cap, ...((c.limits ?? {}) as object) })
    return (c.steps as Record<string, any>[]).map((st) => {
      if (st.op === "reply") {
        messages.length = 0
        return ""
      }
      if (st.op === "compact") {
        const table = rc.compactionTable(store.all().filter((r) => history.has(r.id)))
        messages.length = 0
        history.clear()
        return table
      }
      let text: string
      if (st.op === "read") {
        const { body, from, to, of } = readBody(st.content, st.offset, st.limit)
        text = rc.insert({ kind: "read", path: st.path, key: st.path, sha: sha256(st.content), from, to, of, body }, st.id)
      } else if (st.op === "edit" || st.op === "write") {
        const sha = sha256(st.after)
        text = rc.insert({ kind: "edit", files: [st.before === undefined ? { path: st.path, sha, created: lineCount(st.after) } : { path: st.path, sha, hunks: hunks(st.before, st.after) }] }, st.id)
      } else if (st.op === "recall") text = rc.insert({ kind: "recall", target: st.target, offset: st.offset, limit: st.limit }, st.id)
      else text = rc.insert({ kind: "output", tool: st.tool, args: st.args, text: st.text }, st.id)
      messages.push({ role: "tool", content: text })
      history.add(st.id)
      return text
    })
  },
  // The prefix (context.md §10): one session's requests, step by step — which prompt each sends (a
  // new number each time one is made), which tools it offers, and the note on a user message.
  prefix: (c) => {
    const start = c.start as Partial<Now> & { could?: Requirement[]; met?: Requirement[] }
    const could = new Set<Requirement>(start.could ?? [])
    let met = new Set<Requirement>(start.met ?? could)
    const now: Now = { date: start.date!, mode: start.mode ?? "manual", plan: start.plan ?? "", memory: start.memory ?? "", personality: start.personality ?? "", files: start.files ?? {}, mcp: start.mcp ?? {} }
    const modeText = (m: Mode) => fillPrompt(promptText(`modes/${m}.md`), { plan_dir: (c.plan_dir as string | undefined) ?? ".agent/plans" })
    const requires = (t: string) => TOOL_SPECS[t]?.requires as Requirement[] | undefined
    let made: { system: number; tools: string[]; told: Told } | undefined
    let prompts = 0
    let carried: string | undefined
    const make = () => {
      if (made) return made
      made = { system: ++prompts, tools: (c.tools as string[]).filter((t) => offeredFor(requires(t), could)), told: { ...toldAt(now), ...(carried ? { date: carried } : {}) } }
      carried = undefined
      return made
    }
    const fields = ["date", "mode", "plan", "memory", "personality", "files", "mcp"] as const
    return (c.steps as Record<string, any>[]).map((st) => {
      if (st.op === "set") {
        for (const f of fields) if (f in st) (now as unknown as Record<string, unknown>)[f] = structuredClone(st[f])
        if (st.met) met = new Set(st.met)
        // The model's own tool changed it: its result told the model.
        if (st.by === "model" && made) for (const f of fields) if (f in st && f !== "date") (made.told as unknown as Record<string, unknown>)[f] = structuredClone(st[f])
        return null
      }
      if (st.op === "call") {
        const here = new Set(met)
        if (now.mode === "plan") here.add("plan")
        else here.delete("plan")
        return unavailable(st.tool, requires(st.tool), here) ?? null
      }
      if (st.op === "model") {
        carried = made?.told.date
        made = undefined
        return null
      }
      const k = make()
      if (st.op === "user") {
        const { note, told } = noteFor(k.told, now, modeText)
        if (note) k.told = told
        return { system: k.system, tools: k.tools, note: note || null }
      }
      if (st.op === "tool" || st.op === "wrapup") return { system: k.system, tools: k.tools, note: null }
      if (st.op === "compact") {
        made = undefined
        return { system: k.system, tools: k.tools, ask: compactAsk() }
      }
      throw new Error(`prefix: unknown op ${String(st.op)}`)
    })
  },
  // Reasoning sent back during its turn (context.md §8): the history as the OpenAI chat dialect
  // sends it — role, content and reasoning_content (tool calls and ids left out, as the cases do).
  reasoning: (c) => {
    const history: Message[] = (c.messages as Record<string, any>[]).map((m, i): Message => {
      if (m.role === "user") return { role: "user", parts: [{ type: "text", text: m.content }], ...(m.turn === false ? { turn: false as const } : {}) }
      if (m.role === "assistant") return { role: "assistant", parts: [...(m.reasoning !== undefined ? [{ type: "reasoning" as const, text: m.reasoning }] : []), ...(m.content ? [{ type: "text" as const, text: m.content }] : [])] }
      return { role: "tool", callId: `c${i}`, name: "read", content: m.content }
    })
    return (toOpenAIMessages("", history, false) as Record<string, any>[]).map((m) => ({ role: m.role, content: m.content ?? "", ...(m.reasoning_content !== undefined ? { reasoning_content: m.reasoning_content } : {}) }))
  },
  // No absolute paths (context.md §11): the environment block's lines, and how a tool reads a path.
  paths: (c) => {
    if (c.op === "env") return envLines(c.root as string, c.started as string)
    if (c.op === "resolve") return absPath(c.path as string, { root: (c.root as string).replace(/\/+$/, ""), cwd: c.started as string } as ToolContext)
    throw new Error(`paths: unknown op ${String(c.op)}`)
  },
  // Subagents (subagents.md, spec 3.3.0): the model a subagent runs on, through the rules spawn and
  // team_add ask; the offer through the Team the app makes (its tools, setting and note).
  subagents: (c) => {
    const models = Object.entries(c.models as Record<string, Omit<ModelInfo, "ref">>).map(([ref, m]) => ({ ref, ...m }))
    const byRef = (ref: string) => models.find((m) => m.ref === ref)!
    const session = byRef(c.session as string)
    if (c.op === "model") {
      const r = subagentModel(session, c.model === undefined ? undefined : byRef(c.model as string), (c.said as string[] | undefined) ?? [])
      return "refused" in r ? { refused: r.refused } : { model: r.model }
    }
    if (c.op === "offer") {
      const subagents = c.subagents !== false
      const pure = offer(session, models, subagents)
      const team = new Team({ min: 1, max: 4, subagents, model: session.ref, capacity: (ref) => byRef(ref).capacity, models: () => models.map((m) => m.ref) })
      if (team.offered !== pure.offered) throw new Error("subagents: the Team and the rule disagree on the offer")
      const noted = team.offered && team.noteLines()[0]!.split("\n").includes(LOOP.context.note.team_own)
      return { offered: team.offered, own: pure.own, note: noted ? LOOP.context.note.team_own : null }
    }
    throw new Error(`subagents: unknown op ${String(c.op)}`)
  },
  // Teams (team.md): one lead session's team, step by step, through the CLI's own rules
  // (team/team.ts); the app drives the same class from real turns.
  team: (c) => {
    const start = c.start as { min: number; max: number; subagents?: boolean; capacity: Capacity }
    let capacity = start.capacity
    const team = new Team({ min: start.min, max: start.max, subagents: start.subagents, model: "m", capacity: () => capacity })
    const delivered = () => {
      const out: Record<string, string[]> = {}
      for (const d of team.delivered.splice(0)) (out[d.name] ??= []).push(d.text)
      return out
    }
    return (c.steps as Record<string, any>[]).map((st) => {
      const by = (st.by as string | undefined) ?? "lead"
      switch (st.op) {
        case "offered": {
          const a = team.get(by)!
          const tools = !team.offered ? [] : a.leads ? [...TEAM_TOOLS] : ["team_read", "team_send"]
          return { tools: tools.sort(), setting: team.offered }
        }
        case "call": {
          const args = st.args as Record<string, any>
          let result: string | null
          if (st.tool === "team_read") {
            const no = team.offered ? team.unavailable() : "unavailable"
            const room = no ? [] : team.readRoom(by, args.since ?? 0).messages.map((m) => ({ n: m.n, from: m.from, to: m.to.join(", ") }))
            return { room, delivered: delivered() }
          }
          if (st.tool === "team_add") result = team.add(by, args as any).text
          else if (st.tool === "team_send") result = team.send(by, args as any)
          else if (st.tool === "team_stop") result = team.stopCmd(by, args.name)
          else {
            result = team.refusal(by, st.tool, args) ?? null
            if (st.tool === "task" && result === null && team.offered) team.taskStart(by)
          }
          return { result, delivered: delivered() }
        }
        case "finish":
          team.finish(by, st.reply ?? "", st.reason ?? "stop")
          return { delivered: delivered() }
        case "task_done":
          team.taskDoneBy(by)
          return null
        case "set":
          if (st.capacity) capacity = st.capacity
          if (st.min !== undefined || st.max !== undefined) team.setSetting(st.min ?? team.min, st.max ?? team.max)
          return null
        case "person_stop":
          team.personStop(st.name)
          return null
        case "user": {
          const lines = team.noteLines()
          team.leadWants()
          return { note: lines.length ? noteBlock(lines) : null }
        }
        case "state":
          return team.state()
      }
      throw new Error(`team: unknown op ${String(st.op)}`)
    })
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
