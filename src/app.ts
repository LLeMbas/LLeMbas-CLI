// Wiring shared by every front end: load config, find the project, resolve the model, and build
// an Engine. The TUI and `run` both start here.
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { capacityRefusal, capacityBeside } from "./session/capacity.ts"
import { jobRegistry, type Job, type JobRegistry, type SubagentHandle } from "./jobs/registry.ts"
import { MARKS, shownLine } from "./jobs/note.ts"
import { fillDescription, LOOP, TOOL_SPECS } from "./harness.ts"
import { duration } from "./duration.ts"
import { createWorktree, finishWorktree, type Worktree } from "./git/worktree.ts"
import { boardSummary } from "./project/board.ts"
import { unsafeProjectFile } from "./project/safe.ts"
import { Bus, type Asker } from "./bus/index.ts"
import { loadConfig, type Loaded } from "./config/load.ts"
import type { Mode } from "./config/schema.ts"
import { DEFAULT_RULES, toRules } from "./permission/evaluate.ts"
import { hardlineRules } from "./permission/hardline.ts"
import { clientFor, familyOf, resolveModel } from "./provider/index.ts"
import { subagentModel, type ModelInfo } from "./team/subagents.ts"
import { assembleSystem, instructionFiles, knowledgeScope, modeText } from "./prompt/assemble.ts"
import type { Changing } from "./session/prefix.ts"
import { describeRepo, repoState } from "./git/repo.ts"
import { findProject, forgetProjectRule, persistProjectRule, trustOf, type Project } from "./project/root.ts"
import type { Message } from "./provider/types.ts"
import { Engine } from "./session/engine.ts"
import { agents, NOT_FOR_SUBAGENTS } from "./project/agents.ts"
import { ToolError, type SpawnOptions, type SubagentHandleInfo, type Tool } from "./tool/tool.ts"
import type { SubagentResult } from "./tool/task.ts"
import type { Client, ResolvedModel } from "./provider/types.ts"
import { modelTitle, firstReply, promptTitle } from "./session/title.ts"
import { Turns } from "./session/turns.ts"
import { Snapshots } from "./git/snapshot.ts"
import { CWD_META, REMOTE_META, Store } from "./session/store.ts"
import { BUILTIN_TOOLS } from "./tool/registry.ts"
import { DEFAULT_LIMITS, MemoryStore } from "./memory/store.ts"
import { loadSkills, skillLines, type Skill } from "./skill/index.ts"
import { personalityOf } from "./prompt/personality.ts"
import { McpManager } from "./mcp/index.ts"
import { VERSION } from "./version.ts"
import { Settings } from "./settings.ts"
import { Library, type Embedder } from "./library/store.ts"
import { instances as lembasInstances, keyFile as lembasKeyFile } from "./lembas/login.ts"
import { PERSONAL_KEYS, personalConfig, pushPersonalization } from "./lembas/personal.ts"
import type { Plan } from "./plan/plan.ts"
import { LIBRARY_SERVER, mcpInstructions } from "./mcp/index.ts"
import { clean as cleanText, errorLine } from "./mcp/clean.ts"
import { customCommands } from "./project/commands.ts"
import { TUI_COMMAND_NAMES } from "./session/commands.ts"
import type { McpServer } from "./config/schema.ts"
import { embedderFor } from "./library/embed.ts"
import { isLevel, levelsFor, readLevel, type Level } from "./provider/effort.ts"
import { memberTools as memberToolsOf, readingBashByDefault, Team, TEAM, TEAM_TOOLS, type Capacity, type TeamAgent } from "./team/team.ts"
import { whoDecides } from "./team/delegation.ts"
import { TeamRuntime, type MemberHandle } from "./team/runtime.ts"

export interface AppOptions {
  cwd: string
  model?: string
  mode?: Mode
  /** The effort level asked for (an effort, "off" or "default"); undefined, or one the model does
   *  not offer: its start level. */
  effort?: string
  asker: Asker
  store?: Store | false
  /** Nobody can answer an approval (headless, no --yes). Said in the system prompt up front. */
  unattended?: boolean
  /** Share a bus created earlier (the TUI builds its view before the app). */
  bus?: Bus
  /** false: no working-tree snapshots (headless runs). */
  snapshots?: false
  /** false: name sessions from the first prompt only (headless runs end before a second request could). */
  modelTitles?: false
  /** The stored session this app is opened for, to be resumed at once: no new session is
   *  made first. Without it every reopening — the service opening a web chat's session from the
   *  store — left an empty, untitled session behind in the project, listed by /sessions as its id. */
  resuming?: string
}

const UNATTENDED: Record<Mode, string | undefined> = {
  manual: "any file change, and any command not already allowed",
  edit: "any command not already allowed, and anything outside the project",
  plan: "anything but reading and the plan file",
  auto: undefined,
}

/** What only a client knows about a session (harness/acp.md, `Context` in `session/new` and
 *  `session/prompt`'s `_meta.lembas`): the pieces of the prompt an instance holds, read into the
 *  prompt this device composes from the spec's texts. Each is absent where nothing was said. */
export interface SessionContext {
  /** The chat's authored prompt, under `## Instructions from <instance>`. */
  instructions?: string
  /** The account's personalization, in place of this device's; null: the device's own. */
  personalization?: { personality: string; personality_custom: string; instructions: string } | null
}

export interface App {
  bus: Bus
  engine: Engine
  loaded: Loaded
  project: Project
  trusted: boolean
  /** The subagents the task tool offers (built-in, global, and a trusted project's), as of start. */
  agents: import("./project/agents.ts").AgentSpec[]
  store: Store | undefined
  /** Every model the server serves, by its id there, in its order. */
  modelRefs(): string[]
  /** A ref in any form it may be written in (the old `<login>/<model>` too) as the ref the
   *  model has now; the ref itself when it names nothing. */
  canonicalRef(ref: string): string
  switchModel(ref: string): void
  newSession(): void
  /** Name the open session by hand (a chat renamed in the web UI); no model title follows. */
  rename(title: string): void
  /** Delete the open session when nothing was ever said in it — `lembas run` on its way
   *  out; the TUI goes through acp/share.ts (discardOnExit), which asks the hub first. True when
   *  it went. */
  discardIfEmpty(): boolean
  /** Load a stored session into the engine; returns what the UI should show (the full history). */
  resume(id: string): Message[]
  /** Snapshot-bracketed prompts: /undo, /redo, /diff. */
  turns: Turns
  snapshots: Snapshots | undefined
  memory: MemoryStore
  /** This project's own memory, when it has one. */
  projectMemory?: MemoryStore
  /** MCP servers. Connecting starts with the app; `mcpReady` settles when every server has
   *  connected or failed (headless runs wait for it). */
  mcp: McpManager
  mcpReady: Promise<void>
  /** Stop what the app started (MCP server processes). */
  close(): Promise<void>
  /** Skills as they are on disk now. */
  skills(): Skill[]
  /** The model for small jobs (titles, commit messages): `small_model`, else the session's. */
  small(): { model: ResolvedModel; client: Client }
  /** Settings: what each is, where it comes from, changing them (/settings, the settings tool). */
  settings: Settings
  /** Notes and knowledge bases (library.db), and the embedding model, if one is set. */
  library: Library
  embedder?: Embedder
  /** Stop whatever runs: the model's reply. */
  cancel(): void
  /** The process's job registry (jobs/registry.ts); this app is attached to it for its session. */
  registry: JobRegistry
  /** The id the registry knows the open session by (the store's, or a stand-in without a store). */
  jobsSessionId(): string
  /** The open session's jobs, running first. */
  jobs(): Job[]
  /** A note for the open session (a job's end, a subagent's message), beginning with its mark: to
   *  the model's next step while a turn runs, else a turn of its own marked `machine`. `shown`:
   *  the line a transcript shows for it. */
  wake(text: string, shown: string): void
  /** What the client holds for this session (the link): read into every prompt from now on. */
  context: SessionContext
  /** Replace it (`{}`: none), naming the instance it came from for the prompt's heading. */
  setContext(ctx: SessionContext, from?: string): void
  /** The session's team (spec 3.2.0, team.md): its rules and its members at work. */
  team: TeamRuntime
  /** The chat a session the client opened belongs to (its id): sent with every call to the server's
   *  memory, which answers in that chat's data group (harness/acp.md *Memory*); undefined for a
   *  session of this device's own. The memory for the prompt is read again in it. */
  setScope(scope: string | undefined): void
}

/** What the LLeMbas server's /mcp stands in for (harness spec 3.0.0, acp.md *Memory*): memory
 *  alone. Notes, knowledge bases and skills stay this machine's. */
const SERVER_MEMORY = new Set(["memory"])
/** The resource holding the server's memory entries as the prompt's memory block shows them. */
export const MEMORY_RESOURCE = "lembas://memory"

function lembasLibraryServer(warnings: string[]): (McpServer & { source: "global" }) | undefined {
  const all = Object.values(lembasInstances())
  const one = all.length > 1 ? [...all].sort((a, b) => b.logged_in_at.localeCompare(a.logged_in_at))[0] : all[0]
  if (!one || !existsSync(lembasKeyFile(one.connection))) {
    warnings.push(one ? "library: lembas, but the login's key file is gone (lembas login again); memory is this machine's for now" : "library: lembas, but not logged in (lembas login); memory is this machine's for now")
    return undefined
  }
  return {
    url: `${one.base_url}/mcp`,
    // The token itself, read now: the config's {file:} substitution has already run by here.
    headers: { authorization: `Bearer ${readFileSync(lembasKeyFile(one.connection), "utf8").trim()}` },
    transport: "http",
    oauth: false,
    // The memory tool alone; the resource is read for the prompt, not offered to the model.
    tools: { include: [...SERVER_MEMORY] },
    prompts: false,
    resources: false,
    instructions: false,
    ...(one.ca ? { tls: { ca: one.ca } } : {}),
    source: "global",
  }
}

/** Open a page in the user's browser, where there is one; false when there is not. */
function openInBrowser(url: string): boolean {
  // Only a web page: a server's "authorization URL" could be file:, or a scheme a desktop runs.
  if (!/^https?:\/\//i.test(url)) return false
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && process.platform === "linux") return false
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open"
  try {
    Bun.spawn([cmd, url], { stdout: "ignore", stderr: "ignore" }).unref()
    return true
  } catch {
    return false
  }
}

/** A model as the subagent rules see it (subagents.md): its names and what its server can do at once. */
function modelInfo(m: ResolvedModel): ModelInfo {
  return { ref: m.ref, id: m.id, name: m.spec.name, capacity: { parallel: m.spec.parallel, single_session: m.spec.single_session, group: m.spec.group } }
}

/** Tools the spec offers to subagents only (`offered: subagent`): never a session's own model's. */
export const SUBAGENT_ONLY = new Set(Object.values(TOOL_SPECS).filter((t) => t.offered === "subagent").map((t) => t.name))
/** Spec 3.4.0: tools the spec offers to the main agent only (`offered: main`): never a subagent's. */
export const MAIN_ONLY_TOOLS = new Set(Object.values(TOOL_SPECS).filter((t) => t.offered === "main").map((t) => t.name))

const MODE_RANK: Record<Mode, number> = { auto: 0, edit: 1, manual: 2, plan: 3 }
export function stricterMode(a: Mode | undefined, b: Mode): Mode {
  return a !== undefined && MODE_RANK[a] > MODE_RANK[b] ? a : b
}

export function createApp(o: AppOptions): App {
  const project = findProject(o.cwd)
  const trust = trustOf(project.root)
  const trusted = trust === "trusted"
  const loaded = loadConfig({ projectConfigDir: project.dir, trusted })
  const model = resolveModel(loaded, o.model ?? loaded.config.model)
  // An untrusted project is read-only: plan mode, and its own config is ignored.
  let mode: Mode = o.mode ?? loaded.config.mode ?? "manual"
  if (trust === "readonly") mode = "plan"
  // `effort:` in config when this model offers that level, else the model's own start level
  // (harness models/schema.json `levels`).
  const startEffort = (m: ResolvedModel): Level => readLevel(m, loaded.config.effort)
  const effort: Level = o.effort !== undefined && isLevel(o.effort) && (levelsFor(model).levels as string[]).includes(o.effort) ? o.effort : startEffort(model)
  // One object for the session's lifetime, so a setting changed later reaches the tools.
  loaded.config.search ??= {}
  const bus = o.bus ?? new Bus()
  const store = o.store === false ? undefined : (o.store ?? new Store())
  const session = o.resuming ? undefined : store?.createSession(project.root, model.ref)
  // Where it was started: reopened later — by the service for the web UI — it works there
  // again, not at the project's root (agent.ts, workdirOf).
  const keepCwd = (id: string | undefined) => {
    if (!id || !store) return
    try {
      store.setMeta(id, CWD_META, o.cwd)
    } catch {}
  }
  keepCwd(session?.id)
  // settings_tool: allow lifts the settings tool's catch-all ask — rules somebody wrote still count.
  const settingsTool = loaded.config.settings_tool ?? "ask"
  const rules = [
    ...toRules(DEFAULT_RULES, "default"),
    ...(settingsTool === "allow" ? toRules({ settings: "allow" }, "global") : []),
    ...loaded.permissions.flatMap((p, i) => toRules(p, loaded.permissionSources[i] ?? "global")),
  ]
  const planDir = join(project.dir, "plans")
  // The git block: the repository as the session found it, never refreshed during it. It sits
  // near the top of the system prompt, so any change to it — a file created or deleted, a commit
  // — makes the server's prompt cache useless and the whole conversation is read again: on a
  // 27B model holding 140k tokens, minutes of "waiting for the model". The model runs git status when it needs the state now.
  const gitSummary = () => {
    if (!project.gitRoot) return undefined
    const s = repoState(project.gitRoot)
    return s ? describeRepo(s) : undefined
  }

  // Memory and skills go into the system prompt as they stood when it was made: a write during the
  // session reaches the file, not the prompt (Hermes' frozen snapshot) — the person's own edit
  // reaches the model as a note (session/prefix.ts).
  const memoryOn = loaded.config.memory?.enabled !== false
  const memory = new MemoryStore({ memory: loaded.config.memory?.memory_chars ?? DEFAULT_LIMITS.memory, user: loaded.config.memory?.user_chars ?? DEFAULT_LIMITS.user })
  const projectDir = () => (trusted && existsSync(project.dir) ? project.dir : undefined)
  // The project's own memory: .agent/local (gitignored), in a trusted project that has one.
  const projectMemory = projectDir() && !unsafeProjectFile(join(project.dir, "local", "MEMORY.md"), project.root)
    ? new MemoryStore({ memory: loaded.config.memory?.memory_chars ?? DEFAULT_LIMITS.memory, user: 0 }, join(project.dir, "local"), { memory: "PROJECT MEMORY (this project only)" })
    : undefined
  const skillList = () => loadSkills({ projectDir: projectDir(), external: loaded.config.skills?.external_dirs, disabled: loaded.config.skills?.disabled })
  // What the system prompt holds that nothing during the session updates: taken as the session
  // starts, for the same reason as the git block. The engine makes the prompt once and resends it
  // byte for byte (harness context.md §10); what may change and is said in a note when it does —
  // memory, instruction files, personality, MCP instructions — is read by `changing` below.
  const freeze = () => ({
    skills: skillLines(skillList()),
    git: gitSummary(),
    tasks: projectDir() && !unsafeProjectFile(join(project.dir, "tasks.md"), project.root) ? boardSummary(project.dir) : undefined,
  })
  /** The memory block as it is now: the server's when it is the server's (as last read for this
   *  session, readServerMemory), else this machine's files; undefined when memory is off. */
  const memoryNow = () => (!memoryOn ? undefined : serverMemory !== undefined ? serverMemory.text : [memory.snapshot(), projectMemory?.block("memory") ?? ""].filter(Boolean).join("\n\n"))
  // `library: lembas`: the server keeps the memory (acp.md *Memory*); its entries for the prompt are
  // read from it as a session starts. Until the read answers, none.
  const memoryOnServer = loaded.config.library === "lembas" && memoryOn
  let serverMemory: { text: string } | undefined = memoryOnServer ? { text: "" } : undefined
  let frozen = freeze()

  // The library: one file for every project; an embedding model only when one is set (and usable).
  const library = new Library()
  let embedder: Embedder | undefined
  try {
    embedder = embedderFor(loaded, loaded.config.embedding)
  } catch (e) {
    loaded.warnings.push((e as Error).message)
  }
  const libraryCtx = { lib: library, project: project.root, bases: loaded.config.knowledge, embedder }
  // The client's context for this session (setContext), and whose it is.
  let context: SessionContext = {}
  let contextFrom = "the instance"

  // library: lembas — the account's library through the instance's /mcp, in place of this
  // machine's. Needs the one instance logged in to, with a token that has the memory scope (or
  // the older library).
  const lembasLibrary = memoryOnServer ? lembasLibraryServer(loaded.warnings) : undefined
  if (lembasLibrary) loaded.mcp[LIBRARY_SERVER] = lembasLibrary
  // Without a way to the server's memory, this machine's is used for now.
  if (memoryOnServer && !lembasLibrary) serverMemory = undefined
  const mcp = new McpManager(loaded.mcp, {
    root: project.root,
    version: VERSION,
    notice: (message) => bus.emit({ type: "notice", message }),
    open: openInBrowser,
  })

  const perm = {
    rules,
    hardline: hardlineRules({ extra: loaded.config.hardline_extra, disable: loaded.config.hardline_disable }),
    root: project.root,
    planDir,
    projectDir: project.dir,
  }
  const baseToolCtx = () => ({
    root: project.root,
    cwd: o.cwd,
    readFiles: new Set<string>(),
    fileStamps: new Map<string, number>(),
    bashTimeoutMs: (loaded.config.limits?.bash_timeout ?? 120) * 1000,
    instructionsSeen: new Set(instructionFiles(o.cwd, project.root, loaded.instructions).map((f) => f.path)),
    search: loaded.config.search ?? {},
    planDir,
    projectDir: projectDir(),
    memory,
    projectMemory,
    library: libraryCtx,
    skills: { list: skillList, projectDir: projectDir() },
    sessions: store ? { store, current: () => engine.sessionId } : undefined,
    settings: { get: (k: string) => settings.get(k), list: () => settings.list(), set: (k: string, v: unknown, sc?: "session" | "global" | "project") => settings.set(k, v, sc), models: () => modelRefs() },
  })
  /** Whether knowledge_search is offered (engine.offered's rule): a base of this machine's with
   *  documents in scope. Knowledge bases are this machine's alone (spec 3.0.0). */
  const knowledgeOffered = () => library.bases().some((b) => b.documents > 0 && (!libraryCtx.bases || libraryCtx.bases.includes(b.name)))
  /** The library block's scope: this machine's `knowledge:`. */
  const libraryBlock = () => (knowledgeOffered() ? { scope: knowledgeScope(libraryCtx.bases) } : undefined)
  /** The three personal keys this session uses: the client's for it, else the config's. */
  const personal = () => (context.personalization ? personalConfig({ enabled: true, available: true, ...context.personalization }) : loaded.config)
  /** What may change during the session, as it is now (session/prefix.ts `Changing`): what the
   *  prompt is made from, and what a note compares. A subagent's prompt holds no memory and no
   *  personality; a worktree subagent reads its own checkout's instruction files. */
  type Source = { files: { path: string; text: string; chain?: true }[]; memory?: string; personality?: string; userInstructions?: string; instance?: { name: string; instructions: string }; mcp: Record<string, string> }
  const changing = (subagent?: boolean, at?: { cwd: string; root: string }): Changing => {
    const files = instructionFiles(at?.cwd ?? o.cwd, at?.root ?? project.root, loaded.instructions)
    const p = subagent ? {} : personalityOf(personal())
    const src: Source = {
      files,
      memory: subagent ? undefined : memoryNow(),
      ...p,
      ...(!subagent && context.instructions ? { instance: { name: contextFrom, instructions: context.instructions } } : {}),
      mcp: mcp.serverInstructions(),
    }
    const named: Record<string, string> = Object.fromEntries(files.map((f) => [f.path, f.text]))
    // What a note names the person's own instructions by (loop.json context.note.personal).
    if (src.userInstructions) named[LOOP.context.note.personal] = src.userInstructions
    if (src.instance) named[`Instructions from ${src.instance.name}`] = src.instance.instructions
    return { memory: src.memory ?? "", personality: src.personality ?? "", files: named, mcp: src.mcp, source: src }
  }
  const system = (m: Mode, current: ResolvedModel, ch: Changing, subagent?: { name: string; instructions: string; report: boolean; skills: boolean; recall: boolean }, at?: { cwd: string; root: string }, plan?: Plan, member?: { id: string; name: string; manager: string; role: string; goal: string; lead: boolean }) => {
    const src = ch.source as Source
    return assembleSystem({
      modelRef: current.ref,
      family: familyOf(current),
      cwd: at?.cwd ?? o.cwd,
      root: at?.root ?? project.root,
      instructions: loaded.instructions,
      isGit: project.gitRoot !== undefined,
      mode: m,
      planDir,
      toolNames: BUILTIN_TOOLS.map((t) => t.name),
      unattended: o.unattended ? UNATTENDED[m] : undefined,
      // A worktree subagent works elsewhere: its own snapshot, taken as it starts.
      git: at ? gitSummary() : frozen.git,
      tasks: frozen.tasks,
      files: src.files,
      subagent,
      memory: src.memory,
      // The skills block tells of skill_view; a subagent without the tool gets no block.
      skills: subagent && !subagent.skills ? undefined : frozen.skills,
      manageSkills: true,
      // As the prompt is made; /personality and /settings later change it by a note.
      personality: src.personality,
      userInstructions: src.userInstructions,
      mcp: mcpInstructions(src.mcp),
      roster: roster(current.ref),
      plan,
      ...(src.instance ? { instance: src.instance } : {}),
      library: libraryBlock(),
      context: subagent ? subagent.recall : true,
      ...(member ? { member } : {}),
      // The lead's prompt says how to lead whenever the team tools are offered (team.md §10).
      teamLead: !subagent && teamRt.team.offered,
    })
  }
  /** A mode's text for a note, as the prompt would have it. */
  const modeNote = (m: Mode) => modeText(m, planDir, o.unattended ? UNATTENDED[m] : undefined)
  // The other configured models, for the task tool's `model`, or a switch.
  const roster = (current: string) =>
    loaded.refs
      .map((r) => ({ ref: r.ref, spec: loaded.connections[r.connection]!.models[r.id]! }))
      .filter((m) => m.ref !== current)
      .slice(0, 15)
      .map((m) => `- ${m.ref}${m.spec.name ? ` (${m.spec.name})` : ""}${m.spec.notes ? ` — ${m.spec.notes}` : ""}`)
      .join("\n")
  const compaction = { autoAt: loaded.config.compaction?.auto_at }

  // Subagents (the task tool): a child engine with its own bus and read-tracker, the agent's
  // tools and mode, the same asker (permission prompts still reach the user), no task tool of its
  // own. Only its final reply goes back; its tool lines are shown under the task line.
  const agentList = agents(trusted ? project.dir : undefined, loaded.warnings)
  const offered = BUILTIN_TOOLS.filter(
    (t) => (memoryOn || t.name !== "memory") && (settingsTool !== "off" || t.name !== "settings") && !(lembasLibrary && SERVER_MEMORY.has(t.name)) && !SUBAGENT_ONLY.has(t.name),
  )
  // The spec's descriptions carry the facts LLeMbas CLI fills in itself (harness/README.md).
  const inWords = (sec: number) => (sec % 60 === 0 ? `${sec / 60} minute${sec === 60 ? "" : "s"}` : `${sec} seconds`)
  const vars: Record<string, Record<string, string>> = {
    task: { agents: agentList.map((a) => `${a.name} — ${a.description}`).join("; ") },
    team_add: { agents: agentList.map((a) => `${a.name} — ${a.description}`).join("; ") },
    bash: {
      timeout: inWords(loaded.config.limits?.bash_timeout ?? 120),
      timeout_max: inWords(600),
      background: " For a server, a watcher or anything long, set `background: true`: it returns at once with a job id. Read a job's output with job_output, list jobs with job_list, stop one with job_stop; you are told when one ends.",
    },
  }
  // A tool whose values are its own (the library's, set where it is defined) is filled already;
  // any other with variables is filled here, and one with none given fails rather than reach the
  // model with a literal `{{name}}`.
  const tools: Tool[] = offered.map((t) => {
    if (!TOOL_SPECS[t.name]?.variables || (t.vars && !vars[t.name])) return t
    const v = vars[t.name] ?? {}
    return { ...t, description: fillDescription(t.description, v), vars: { ...t.vars, ...v } }
  })
  // Background jobs: one registry for the process, this app attached for whichever session it
  // holds. Without a store a session has no id of its own; the jobs get a stand-in.
  const registry = jobRegistry()
  let standIn = `local_${crypto.randomUUID().slice(0, 8)}`
  const jobsSessionId = () => engine.sessionId ?? standIn
  const wake = (text: string, shown: string) => {
    if (turns.current || engine.busy) return engine.note(text)
    void turns.prompt(text, [], shown, { machine: true }).catch((e) => bus.emit({ type: "notice", level: "warn", message: `a job's note could not start a turn: ${(e as Error).message}` }))
  }
  const detach = registry.attach({ sessionId: jobsSessionId, bus, wake, store, runningMax: () => loaded.config.limits?.jobs ?? registry.limits.runningMax })
  const childDetach: (() => void)[] = []
  // A note the turn ended before delivering (stopped, or a budget): a turn of its own now, or —
  // after Esc — with the next message, so it starts no work nobody asked for.
  bus.on((e) => {
    if (e.type !== "done") return
    const left = engine.takeNotes()
    if (!left.length) return
    if (e.reason === "cancelled") return void engine.pendingContext.push(...left)
    setTimeout(() => {
      for (const n of left) wake(n, shownLine(n))
    }, 0)
  })

  // Subagents (the task tool): a child engine with its own bus, session row and read-tracker, the
  // agent's tools and mode, the same asker (permission prompts still reach the user, saying which
  // subagent asked), no task tool of its own. Every one runs as a job of the session: a synchronous
  // one's report goes back as the call's result, a background one's as a note when it ends.
  const spawn = async (name: string, prompt: string, opts: SpawnOptions): Promise<SubagentHandleInfo> => {
    const spec = agentList.find((a) => a.name === name)
    if (!spec) throw new ToolError(`There is no agent "${name}". The agents are: ${agentList.map((a) => a.name).join(", ")}.`)
    // The model asked for (task's `model`), else the agent's own, else the session's — and whether
    // its server can take it beside the session's and beside every subagent already running
    // (src/session/capacity.ts), before anything is made.
    const member = opts.member
    // Spec 3.3.0 (subagents.md): the session's model, unless the person named another; an agent
    // file's own `model` is not used. A member's model was judged by team_add.
    let m: ResolvedModel
    if (member) m = opts.model ? resolveModel(loaded, opts.model) : engine.model
    else {
      const wanted = opts.model ? resolveModel(loaded, opts.model) : undefined
      const r = subagentModel(modelInfo(engine.model), wanted && modelInfo(wanted), engine.personSaid())
      if ("refused" in r) throw new ToolError(r.refused)
      m = wanted && wanted.ref === r.model ? wanted : engine.model
    }
    // A team's member is not refused for capacity: the team gave it its slot (team.md §8).
    if (!member) {
      const running = registry.running(jobsSessionId()).filter((j) => j.kind === "subagent" && j.subagent && !j.team)
      const onIt = running.filter((j) => j.subagent!.engine.model.ref === m.ref).length
      const refused = capacityRefusal(engine.model, m, onIt) || running.map((j) => capacityBeside(j.subagent!.engine.model, m, onIt)).find(Boolean)
      if (refused) throw new ToolError(`${refused} Wait for one to finish, or do this part yourself.`)
    }
    // A checkout and branch of its own, when asked for (the task's worktree, the agent's isolation).
    let wt: Worktree | undefined
    if (opts.worktree || spec.isolation === "worktree") {
      if (!project.gitRoot) throw new ToolError("worktree needs a git repository; this project is not one.")
      try {
        wt = createWorktree(project.gitRoot, `${spec.name}-${opts.description ?? ""}`)
      } catch (e) {
        throw new ToolError(`Could not make a worktree: ${(e as Error).message}`)
      }
    }
    const at = wt ? { root: join(wt.dir, relative(project.gitRoot!, project.root)), cwd: join(wt.dir, relative(project.gitRoot!, o.cwd)) } : undefined
    // A directory not committed yet is not in the checkout; make it, so the tools have somewhere to be.
    if (at) for (const d of [at.root, at.cwd]) mkdirSync(d, { recursive: true })
    // Isolation is the point: the main checkout is refused to it outright, in every mode —
    // its prompt may well name files there by their absolute paths. Its project directory and plan
    // directory are the checkout's, so the edit-mode guard and plan mode judge the right place.
    const childProjectDir = at ? join(at.root, relative(project.root, project.dir)) : project.dir
    const childPerm = at
      ? {
          ...perm,
          root: at.root,
          projectDir: childProjectDir,
          planDir: join(childProjectDir, "plans"),
          rules: [...perm.rules, { permission: "external_directory", pattern: project.gitRoot!, action: "deny" as const }, { permission: "external_directory", pattern: `${project.gitRoot!}/*`, action: "deny" as const }],
        }
      : perm
    // `report` is every subagent's: its way of speaking to the main agent before its final reply.
    // A subagent of the tree also has its team tools (spec 3.4.0 §8: whoami, read, send, findings,
    // finish, and request with request options) — never the main agent's (`offered: main`); a task
    // subagent has none of them.
    const memberTools = member ? memberToolsOf(member) : []
    const isTeamTool = (n: string) => (TEAM_TOOLS as readonly string[]).includes(n)
    const childTools = [
      ...tools.filter((t) => !NOT_FOR_SUBAGENTS.has(t.name) && !MAIN_ONLY_TOOLS.has(t.name) && (!isTeamTool(t.name) || memberTools.includes(t.name)) && (!spec.tools || spec.tools.includes(t.name) || memberTools.includes(t.name))),
      ...BUILTIN_TOOLS.filter((t) => SUBAGENT_ONLY.has(t.name) && (!isTeamTool(t.name) || memberTools.includes(t.name))),
    ]
    // Its mode: the one the main agent gave it, made stricter by its agent's own (explore reads).
    if (member) member.mode = stricterMode(spec.mode, member.mode)
    const description = member ? `${member.name}: ${member.role}` : (opts.description ?? prompt.split("\n")[0]!.slice(0, 60))
    const ownerSession = jobsSessionId()
    const childRow = store?.createSession(at?.root ?? project.root, m.ref, engine.sessionId)
    if (childRow) store!.setTitle(childRow.id, `${spec.name}: ${description}`)
    const childSessionId = childRow?.id ?? `${ownerSession}/${crypto.randomUUID().slice(0, 8)}`
    const childBus = new Bus()
    let job: Job
    // The asker is the session's; a child's ask says which subagent it comes from.
    const askerFor = (): Asker => ({
      ask: (req) => o.asker.ask({ ...req, source: { jobId: job.id, agent: spec.name, description, ...(member ? { subagent: { id: member.id, name: member.name, position: member.role } } : {}) } }),
      get question() {
        return o.asker.question
      },
      get plan() {
        return o.asker.plan
      },
    })
    const child = new Engine({
      bus: childBus,
      asker: askerFor(),
      client: m.ref === engine.model.ref ? engine.client : clientFor(m),
      model: m,
      tools: childTools,
      store,
      sessionId: childRow?.id,
      // An agent's own mode can make it stricter than its parent, never looser. A subagent of the
      // tree runs in the mode the main agent gave it (spec 3.4.0 §7), set above.
      mode: member ? member.mode : stricterMode(spec.mode, engine.mode),
      effort: m.ref === engine.model.ref ? engine.effort : startEffort(m),
      maxSteps: loaded.config.limits?.subagent_steps ?? LOOP.jobs.subagent_steps.default,
      compaction,
      perm: childPerm,
      toolCtx: {
        ...baseToolCtx(),
        ...(at ? { root: at.root, cwd: at.cwd, projectDir: undefined } : {}),
        jobs: { registry, owner: () => ({ sessionId: childSessionId, job }) },
        ...(member ? { team: { runtime: teamRt, as: member.name } } : {}),
      },
      ...(member
        ? {
            team: {
              fix: () => teamRt.team.offered,
              offered: () => teamRt.team.offered,
              refuse: (tool: Tool, args: unknown) => teamRt.refuse(member.name, tool, args),
              // Spec 3.4.0 §7: itself, the main agent through a request, or the person.
              permit: (request, ctx) => {
                const a = teamRt.team.get(member.name)
                return whoDecides(request, { ctx, mode: a?.mode ?? member.mode, main: engine.mode, request: a?.request ?? [], grants: a?.grants ?? [], unattended: o.unattended })
              },
              contextFull: (used: number, window: number) => (window ? teamRt.contextFull(member.name) : "go"),
              ended: () => teamRt.hasEnded(member.name),
            },
          }
        : {}),
      steerMark: MARKS.to_subagent,
      changing: () => changing(true, at),
      modeText: modeNote,
      system: (mode, current, plan, ch) =>
        system(
          mode,
          current,
          ch,
          {
            name: spec.name,
            instructions: wt
              ? `${spec.instructions}\n\nYou are working in a separate checkout of the repository — its root is your project root, so relative paths reach it — on the branch ${wt.branch} (made from the last commit — uncommitted work of the main agent is not here). Work only inside it. When you finish, your changes are committed on that branch for the main agent to merge: do not commit, merge or push yourself.`
              : spec.instructions,
            report: childTools.some((t) => t.name === "report"),
            skills: childTools.some((t) => t.name === "skill_view"),
            recall: childTools.some((t) => t.name === "recall"),
          },
          at,
          plan,
          member ? { id: member.id, name: member.name, manager: member.manager ?? TEAM.names.lead, role: member.role, goal: member.goal, lead: member.leads } : undefined,
        ),
    })
    // Its own background commands wake it at its next step while it runs; once it has ended they
    // are stopped with it, so nothing is left to wake.
    childDetach.push(registry.attach({ sessionId: () => childSessionId, bus: childBus, wake: (text) => void (child.busy && child.note(text)), store }))
    const finish = async (reason: string): Promise<SubagentResult> => {
      const last = [...child.messages].reverse().find((x) => x.role === "assistant")
      const text = last && last.role === "assistant" ? last.parts.map((p) => (p.type === "text" ? p.text : "")).join("") : ""
      // Cancelled or failed too: what it did is kept the same way, and the branch named.
      const worktree = wt ? finishWorktree(project.gitRoot!, wt, `${spec.name}: ${description}${reason === "stop" ? "" : " (stopped)"}`).summary : undefined
      wt = undefined
      const error = reason === "error" ? job.lastError : undefined
      const end = registry.finishSubagent(job, { reason, report: text, ...(error ? { error } : {}), ...(worktree ? { worktree } : {}) })
      return { text: worktree ? `${text}\n\n[worktree] ${worktree}` : text, steps: job.steps ?? 0, tools: job.tools ?? 0, reason, ...(error ? { error } : {}), ...(end.stopped ? { stopped: end.stopped } : {}) }
    }
    // A task subagent started inside a team counts toward its size and holds a slot while it runs
    // (team.md §3, §8).
    const counted = (p: Promise<SubagentResult>) => {
      if (member || !teamRt.team.offered) return p
      const id = teamRt.team.taskStart(TEAM.names.lead, m.ref)
      return p.finally(() => teamRt.team.taskDone(id))
    }
    const run = (text: string, machine = false, steps?: number) => counted(child.prompt(text, [], text, { ...(machine ? { machine: true as const } : {}), ...(steps ? { maxSteps: steps } : {}) }).then(finish, (e) => (job.lastError = (e as Error).message, finish("error"))))
    const handle: SubagentHandle = {
      bus: childBus,
      engine: child,
      send: (text) => child.enqueue(text),
      restart: (text) => run(text).then(() => undefined),
      cancel: () => child.cancel(),
    }
    job = registry.startSubagent({ sessionId: ownerSession, ownerCallId: opts.callId, ownerJobId: baseOwner().job?.id, agent: spec.name, model: m.ref, description, handle, childSessionId, silent: !opts.background || member !== undefined })
    if (member) {
      // A member's turn that ends is its report (team.md §5): the team, not a job note, carries it.
      job.team = member.name
      member.jobId = job.id
      // Its progress and context use, for the tree (spec 3.4.0 §12).
      childBus.on((e) => {
        if (e.type === "phase") {
          teamRt.team.setProgress(member.name, e.progress)
          teamRt.notify()
        } else if (e.type === "usage" && !e.child && e.context) {
          teamRt.team.setContext(member.name, e.used ?? e.usage.input + e.usage.output, e.context)
          teamRt.notify()
        }
      })
      const memberRun = (text: string, machine: boolean, steps?: number) => {
        if (job.state !== "running") registry.restartSubagent(job)
        void run(text, machine, steps).then((r) => {
          const leftover = [...child.takeNotes(), ...child.takeInbox()]
          const reason = r.reason === "error" ? `error — ${r.error ?? "unknown"}` : r.reason
          if (r.reason !== "cancelled") teamRt.memberDone(member.name, r.text, reason, leftover)
        })
      }
      const mh: MemberHandle = { engine: child, run: (text) => memberRun(text, true), cancel: () => child.cancel(), final: (text) => memberRun(text, true, TEAM.context.final_steps) }
      teamRt.attach(member.name, mh)
      memberRun(prompt, false)
      return { id: job.id, done: Promise.resolve({ text: "", steps: 0, tools: 0, reason: "stop" }), member: mh }
    }
    // A synchronous subagent goes with its parent's turn (Esc stops both); a background one does not.
    const onAbort = () => child.cancel()
    opts.signal?.addEventListener("abort", onAbort, { once: true })
    const done = run(prompt).finally(() => opts.signal?.removeEventListener("abort", onAbort))
    // Nobody awaits a background one here; its end is its note.
    if (opts.background) done.catch(() => {})
    return { id: job.id, done }
  }
  /** Whose jobs the session's own tools see. */
  const baseOwner = () => ({ sessionId: jobsSessionId(), job: undefined as Job | undefined })

  const engine = new Engine({
    bus,
    asker: o.asker,
    client: clientFor(model),
    model,
    tools,
    store,
    sessionId: session?.id,
    mode,
    effort,
    maxSteps: loaded.config.limits?.steps,
    budget: { wall_seconds: loaded.config.limits?.wall_seconds, output_bytes: loaded.config.limits?.output_bytes, completion_tokens: loaded.config.limits?.completion_tokens },
    compaction,
    perm,
    toolCtx: { ...baseToolCtx(), jobs: { registry, owner: baseOwner }, team: { get runtime() { return teamRt }, as: TEAM.names.lead } },
    system: (m, current, plan, ch) => system(m, current, ch, undefined, undefined, plan),
    team: {
      fix: (ref, offered) => teamRt.team.fix(ref, offered),
      offered: () => teamRt.team.offered,
      refuse: (tool, args) => teamRt.refuse(TEAM.names.lead, tool, args),
      note: () => teamRt.team.noteLines(),
      forget: () => teamRt.team.forgetTold(),
      beforeTurn: (signal) => teamRt.beforeLeadTurn(signal),
    },
    changing: () => changing(),
    modeText: modeNote,
    // The configured MCP servers, up to loop.json's wait: their tools in the first list.
    beforeFirst: () => Promise.race([mcpReady.catch(() => {}), Bun.sleep(LOOP.context.mcp_wait_ms)]),
    persistRule: trusted ? (rule) => persistProjectRule(project, rule) : undefined,
    forgetRule: trusted ? (rule) => forgetProjectRule(project, rule) : undefined,
    // subagents: false — no task tool, and no team (team.md §2).
    spawn: loaded.config.subagents === false ? undefined : spawn,
  })

  // The session's team (spec 3.2.0, team.md): its size from the configuration (the cap the global
  // one's), the capacity of each model as the server says it.
  const capacityOf = (ref: string): Capacity => {
    try {
      const s = ref === engine.model.ref ? engine.model.spec : resolveModel(loaded, ref).spec
      return { parallel: s.parallel, single_session: s.single_session, group: s.group }
    } catch {
      return {}
    }
  }
  // Every model the person may use: the server's, as the login read them (subagents.md §4).
  const usableModels = () => loaded.refs.map((r) => r.ref)
  // The size as set while the process runs (any scope): a new or resumed session keeps it.
  const teamSize: { min?: number; max?: number } = {}
  const newTeam = () =>
    new Team({
      min: teamSize.min ?? loaded.config.agents?.min,
      max: teamSize.max ?? loaded.config.agents?.max,
      cap: loaded.config.agents?.cap,
      subagents: loaded.config.subagents !== false,
      model: engine.model.ref,
      capacity: capacityOf,
      models: usableModels,
      leadState: "idle",
      readingBash: (command) => readingBashByDefault(command, project.root),
      mode: engine.mode,
      steps: { main: loaded.config.limits?.steps ?? LOOP.steps.default, sub: loaded.config.limits?.subagent_steps ?? LOOP.jobs.subagent_steps.default },
    })
  const teamRt: TeamRuntime = new TeamRuntime({
    team: newTeam(),
    bus,
    // spawn makes the member's engine and attaches it before its first await, so a message to it
    // finds it at once.
    spawnMember: (member: TeamAgent, text: string) => {
      spawn(member.agent, text, { member, model: member.model, background: true, description: `${member.name}: ${member.role}` }).catch((e) => {
        bus.emit({ type: "notice", level: "warn", message: `team: ${member.name} could not start: ${(e as Error).message}` })
        teamRt.memberDone(member.name, "", `error — ${(e as Error).message}`, [])
      })
    },
    lead: {
      note: (text) => engine.note(text),
      wake: (text) => wake(text, shownLine(text)),
      waiting: (model) => engine.progress.set({ phase: "waiting_for_model", model: engine.model.spec.name ?? model, reason: "slots" }),
    },
    tools: () => tools,
    resolve: (agent, model) => {
      if (!agentList.some((a) => a.name === agent)) return { error: `There is no agent "${agent}". The agents are: ${agentList.map((a) => a.name).join(", ")}.` }
      try {
          // Spec 3.3.0 (subagents.md): the session's model, unless the person named another.
        const wanted = model ? resolveModel(loaded, model) : undefined
        const r = subagentModel(modelInfo(engine.model), wanted && modelInfo(wanted), engine.personSaid())
        return "refused" in r ? { error: r.refused } : { model: r.model }
      } catch (e) {
        return { error: (e as Error).message }
      }
    },
  })
  // The lead's turn ended: it is idle, and its slot frees (team.md §8).
  bus.on((e) => e.type === "done" && teamRt.leadDone())
  // Spec 3.4.0: the main agent's mode reaches down the tree; its progress and context are in it.
  bus.on((e) => {
    if (e.type === "mode") teamRt.mainMode(e.mode)
    else if (e.type === "phase") {
      teamRt.team.setProgress(TEAM.names.lead, e.progress)
      if (teamRt.team.hasMembers()) teamRt.notify()
    } else if (e.type === "usage" && !e.child && e.context) teamRt.team.setContext(TEAM.names.lead, e.used ?? e.usage.input + e.usage.output, e.context)
  })

  // MCP tools join the engine's list as servers connect (the engine reads it at each prompt).
  let mcpNames = new Set<string>()
  const syncMcp = () => {
    const kept = tools.filter((t) => !t.name.startsWith("mcp__") && !mcpNames.has(t.name))
    const fresh = mcp.tools()
    mcpNames = new Set(fresh.map((t) => t.name))
    tools.splice(0, tools.length, ...kept, ...fresh)
  }
  const seen = new Map<string, string>()
  mcp.onChange(() => {
    syncMcp()
    for (const s of mcp.servers.values()) {
      if (seen.get(s.name) === s.status) continue
      seen.set(s.name, s.status)
      // A server that connected says nothing: that is what was meant to happen, and the status
      // bar counts it. One that did not gets one line that says which, why, and where to go.
      // One line, cleaned and with nothing secret in it (it goes to every front end, the link's
      // included), and promising only what every front end has: /mcp <name> shows the server.
      if (s.status === "failed") bus.emit({ type: "notice", level: "warn", message: `MCP ${cleanText(s.name)} did not connect: ${errorLine(s.error) || "no reason given"} — /mcp ${cleanText(s.name)} shows more` })
      else if (s.status === "needs_auth") bus.emit({ type: "notice", level: "warn", message: `MCP ${cleanText(s.name)} needs you to sign in — /mcp ${cleanText(s.name)}` })
    }
  })
  const mcpReady = mcp.start()
  /** The server's memory entries for the prompt (`lembas://memory`), read as a session starts, in
   *  the session's scope: in the prompt when it is made after this, else said in a note on the next
   *  user message — the prompt does not change under a session. */
  const readServerMemory = async () => {
    if (!lembasLibrary || !serverMemory) return
    try {
      const text = await mcp.readResource(LIBRARY_SERVER, MEMORY_RESOURCE, engine.o.toolCtx.libraryScope)
      serverMemory = { text }
    } catch (e) {
      bus.emit({ type: "notice", level: "warn", message: `memory: the server's entries could not be read (${(e as Error).message}); none are in this session's prompt` })
    }
  }
  void mcpReady.then(readServerMemory)

  // small_model when it resolves; a broken one is said once and the session's model used instead.
  let smallWarned = false
  const small = (): { model: ResolvedModel; client: Client } => {
    const ref = loaded.config.small_model
    if (ref && ref !== engine.model.ref)
      try {
        const m = resolveModel(loaded, ref)
        return { model: m, client: clientFor(m) }
      } catch (e) {
        if (!smallWarned) bus.emit({ type: "notice", message: `small_model: ${(e as Error).message} — using ${engine.model.ref}` })
        smallWarned = true
      }
    return { model: engine.model, client: engine.client }
  }

  // Titles: the first prompt names the session as it is sent; after the first reply the model may
  // rename it. `named` is how far this session has got.
  let named: "no" | "prompt" | "model" = "no"
  let firstShown = ""
  const byModel = () => o.modelTitles !== false && loaded.config.titles !== "prompt"
  const setTitle = (id: string, title: string) => {
    if (!title || !store) return
    store.setTitle(id, title)
    bus.emit({ type: "title", id, title })
  }
  bus.on((e) => {
    const id = engine.sessionId
    if (!store || !id) return
    if (e.type === "prompt" && named === "no") {
      named = "prompt"
      firstShown = e.text
      setTitle(id, promptTitle(e.text))
    } else if (e.type === "done" && e.reason === "stop" && named === "prompt" && byModel()) {
      named = "model"
      const first = firstShown || store.firstPrompt(id)
      const reply = firstReply(engine.messages)
      const { client } = small()
      const signal = AbortSignal.timeout(120_000)
      // Quietly: a title is not worth a warning, and the prompt's line is already there.
      void modelTitle(client, first, reply, signal)
        .then((t) => t && engine.sessionId === id && setTitle(id, t))
        .catch(() => {})
    }
  })

  const snapshots = o.snapshots === false ? undefined : new Snapshots(project.root, project.gitRoot)
  engine.busyInput = loaded.config.busy_input ?? "steer"
  const turns = new Turns(engine, snapshots, store)
  // By provider for an instance's models (`deepseek/deepseek-flash`), src/provider/refs.ts.
  const modelRefs = () => loaded.refs.map((r) => r.ref)
  const switchModel = (ref: string) => {
    const m = resolveModel(loaded, ref)
    engine.setModel(m, clientFor(m), startEffort(m))
  }
  const setIn = (key: string, value: unknown) => {
    const path = key.split(".")
    let o = loaded.config as Record<string, unknown>
    for (const k of path.slice(0, -1)) o = (o[k] ??= {}) as Record<string, unknown>
    o[path[path.length - 1]!] = value
  }
  const settings = new Settings({
    projectFile: trusted ? join(project.dir, "config.yaml") : undefined,
    // Logged in, personalization is the account's: written to the instance, not config.yaml.
    remote(key, v) {
      const from = loaded.personalFrom
      if (!from || !(PERSONAL_KEYS as readonly string[]).includes(key)) return undefined
      void pushPersonalization(key as (typeof PERSONAL_KEYS)[number], String(v ?? ""))
        // Opting in brings the other two back as they are saved there: the session uses them now.
        .then((saved) => saved && Object.assign(loaded.config, personalConfig(saved), { [key]: v }))
        .catch((e) =>
        bus.emit({ type: "notice", level: "warn", message: `${key} is set for this session, but could not be saved to your account on ${from}: ${(e as Error).message}` }),
      )
      return `on ${from}, shared with the web UI`
    },
    live(key) {
      if (key === "model") return engine.model.ref
      if (key === "effort") return engine.effort
      if (key === "mode") return engine.mode
      // The team's size as the session holds it (the cap applied).
      if (key === "agents.min") return teamRt.team.min
      if (key === "agents.max") return teamRt.team.max
      return key.split(".").reduce<unknown>((x, k) => (x && typeof x === "object" ? (x as Record<string, unknown>)[k] : undefined), loaded.config)
    },
    check(key, v) {
      if (key === "model" || key === "small_model") resolveModel(loaded, String(v))
      if (key === "effort" && !(levelsFor(engine.model).levels as string[]).includes(String(v)))
        throw new Error(`${engine.model.ref} offers the levels ${levelsFor(engine.model).levels.join(", ")}`)
      if (key === "knowledge") for (const b of v as string[]) if (!library.base(b)) throw new Error(`there is no knowledge base "${b}" — lembas kb lists them`)
      // The team's size (team.md §2): refused outside 1 ≤ min ≤ max ≤ cap, with the bounds.
      if (key === "agents.min" || key === "agents.max") {
        const t = teamRt.team
        const no = Team.check(key === "agents.min" ? Number(v) : t.min, key === "agents.max" ? Number(v) : t.max, t.cap)
        if (no) throw new Error(no)
      }
    },
    apply(key, v) {
      if (key === "model") switchModel(String(v))
      else if (key === "effort") engine.effort = v as Level
      else if (key === "mode") engine.mode = v as Mode
      else if (key === "limits.steps") engine.o.maxSteps = Number(v)
      else if (key === "busy_input") engine.busyInput = v as "steer" | "queue"
      else if (key === "limits.bash_timeout") engine.o.toolCtx.bashTimeoutMs = Number(v) * 1000
      else if (key === "limits.wall_seconds" || key === "limits.output_bytes" || key === "limits.completion_tokens") engine.o.budget = { ...engine.o.budget, [key.slice("limits.".length)]: Number(v) }
      else if (key === "compaction.auto_at") compaction.autoAt = Number(v)
      else if (key === "knowledge") libraryCtx.bases = (v as string[]).length ? (v as string[]) : undefined
      else if (key === "agents.min" || key === "agents.max") {
        // Said to the lead as a note on its next message (team.md §2), never in the prompt.
        const t = teamRt.team
        t.setSetting(key === "agents.min" ? Number(v) : t.min, key === "agents.max" ? Number(v) : t.max)
        teamSize.min = t.min
        teamSize.max = t.max
        bus.emit({ type: "team" })
      }
      if (key !== "model" && key !== "effort" && key !== "mode") setIn(key, v)
      bus.emit({ type: "setting", key, value: v })
    },
  })

  // A mode changed inside a turn (a plan approved) is the session's from then on.
  bus.on((e) => e.type === "mode" && settings.session.set("mode", e.mode))

  /** Delete a session that holds no messages, saying so on the bus. Whether the web UI was
   *  shown it is read first, as the delete takes its meta with it. */
  const discardEmpty = (id: string): boolean => {
    if (!store) return false
    try {
      if (!store.session(id) || !store.isEmpty(id)) return false
      const shown = store.meta<boolean>(id, REMOTE_META) === true
      if (!store.deleteSession(id)) return false
      bus.emit({ type: "discarded", id, shown })
      return true
    } catch {
      return false
    }
  }

  if (session) bus.emit({ type: "session", id: session.id, model: model.ref, mode })
  // A custom command named like a command of the program is hidden by it: said once at start,
  // with the way to it.
  for (const cc of customCommands(trusted ? project.dir : undefined))
    if ((TUI_COMMAND_NAMES as readonly string[]).includes(cc.name)) loaded.warnings.push(`the custom command /${cc.name} (${cc.file}) has the name of a built-in command, which wins — run it as /command ${cc.name}, or rename the file`)
  for (const w of loaded.warnings) bus.emit({ type: "notice", message: w })
  return {
    bus,
    engine,
    loaded,
    project,
    trusted,
    agents: agentList,
    store,
    turns,
    snapshots,
    modelRefs,
    canonicalRef(ref) {
      try {
        return resolveModel(loaded, ref).ref
      } catch {
        return ref
      }
    },
    switchModel,
    settings,
    memory,
    projectMemory,
    mcp,
    mcpReady,
    small,
    close: () => {
      teamRt.stopAll()
      detach()
      for (const d of childDetach.splice(0)) d()
      return mcp.close()
    },
    skills: skillList,
    library,
    embedder,
    cancel() {
      engine.cancel()
    },
    registry,
    jobsSessionId,
    jobs: () => registry.list(jobsSessionId()),
    wake,
    team: teamRt,
    get context() {
      return context
    },
    setContext(ctx, from) {
      context = ctx
      if (from) contextFrom = from
    },
    setScope(scope) {
      engine.o.toolCtx.libraryScope = scope
      void readServerMemory()
    },
    rename(title) {
      const id = engine.sessionId
      if (!id || !title.trim()) return
      named = "model"
      setTitle(id, title.trim())
    },
    newSession() {
      frozen = freeze()
      void readServerMemory()
      named = "no"
      firstShown = ""
      const s = store?.createSession(project.root, engine.model.ref)
      keepCwd(s?.id)
      standIn = `local_${crypto.randomUUID().slice(0, 8)}`
      teamRt.reset(newTeam())
      engine.newSession(s?.id)
      turns.reset()
      if (s) bus.emit({ type: "session", id: s.id, model: engine.model.ref, mode: engine.mode })
    },
    discardIfEmpty() {
      const id = engine.sessionId
      return id ? discardEmpty(id) : false
    },
    resume(id) {
      if (!store) return []
      const before = engine.sessionId
      frozen = freeze()
      void readServerMemory()
      teamRt.reset(newTeam())
      engine.resume(id, store.context(id))
      // A session from before titles gets its first prompt's line now, and the model's after the next reply.
      firstShown = ""
      const row = store.session(id)
      if (row?.title) named = "model"
      else {
        const first = promptTitle(store.firstPrompt(id))
        named = first ? "prompt" : "no"
        if (first) setTitle(id, first)
      }
      turns.reset()
      bus.emit({ type: "session", id, model: engine.model.ref, mode: engine.mode })
      // The session open until now, when nobody said anything in it: the one every start
      // makes, left behind by `-c` and /sessions as an empty, untitled row in /sessions and a chat
      // in the web UI that holds nothing. Only when it is empty: one with a word in it is kept.
      if (before && before !== id) discardEmpty(before)
      const messages = store.messages(id)
      // Notes its jobs left while nobody had it open: a turn of their own, now.
      setTimeout(() => registry.deliverPending(id), 0)
      return messages
    },
  }
}
