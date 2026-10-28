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
import type { Effort, Mode } from "./config/schema.ts"
import { DEFAULT_RULES, toRules } from "./permission/evaluate.ts"
import { hardlineRules } from "./permission/hardline.ts"
import { defaultEffort } from "./provider/effort.ts"
import { clientFor, familyOf, resolveModel } from "./provider/index.ts"
import { assembleSystem, instructionFiles, knowledgeScope } from "./prompt/assemble.ts"
import { describeRepo, repoState } from "./git/repo.ts"
import { findProject, persistProjectRule, trustOf, type Project } from "./project/root.ts"
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
import { LIBRARY_SERVER } from "./mcp/index.ts"
import type { McpServer } from "./config/schema.ts"
import { embedderFor } from "./library/embed.ts"
import { effortsFor } from "./provider/effort.ts"

export interface AppOptions {
  cwd: string
  model?: string
  mode?: Mode
  /** undefined = the model's default; "off" = none */
  effort?: Effort | "off"
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
  /** Whether the model may write a prototype, and what a page may load. */
  prototypes?: { offered: boolean; sources: string }
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

/** Tools the spec offers to subagents only (`offered: subagent`): never a session's own model's. */
export const SUBAGENT_ONLY = new Set(Object.values(TOOL_SPECS).filter((t) => t.offered === "subagent").map((t) => t.name))

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
  // `effort:` in config when this model takes it, else the model's own default.
  const startEffort = (m: ResolvedModel) => {
    const e = loaded.config.effort
    if (e === "off") return null
    return e && effortsFor(m).includes(e) ? e : defaultEffort(m)
  }
  const effort = o.effort === "off" ? null : (o.effort ?? startEffort(model))
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

  // Memory and skills go into the system prompt as they stood when the session started: a write
  // during the session reaches the file, not the prompt (Hermes' frozen snapshot).
  const memoryOn = loaded.config.memory?.enabled !== false
  const memory = new MemoryStore({ memory: loaded.config.memory?.memory_chars ?? DEFAULT_LIMITS.memory, user: loaded.config.memory?.user_chars ?? DEFAULT_LIMITS.user })
  const projectDir = () => (trusted && existsSync(project.dir) ? project.dir : undefined)
  // The project's own memory: .agent/local (gitignored), in a trusted project that has one.
  const projectMemory = projectDir() && !unsafeProjectFile(join(project.dir, "local", "MEMORY.md"), project.root)
    ? new MemoryStore({ memory: loaded.config.memory?.memory_chars ?? DEFAULT_LIMITS.memory, user: 0 }, join(project.dir, "local"), { memory: "PROJECT MEMORY (this project only)" })
    : undefined
  const skillList = () => loadSkills({ projectDir: projectDir(), external: loaded.config.skills?.external_dirs, disabled: loaded.config.skills?.disabled })
  // Everything in the system prompt that could change during a session is taken once, here, for
  // the same reason as the git block: the prompt must stay byte for byte the same, or the server
  // reads the whole conversation again.
  const freeze = () => ({
    // The server's memory, when it is the server's: as last read for this session (readServerMemory).
    memory: !memoryOn ? undefined : serverMemory !== undefined ? serverMemory.text : [memory.snapshot(), projectMemory?.block("memory") ?? ""].filter(Boolean).join("\n\n"),
    skills: skillLines(skillList()),
    git: gitSummary(),
    tasks: projectDir() && !unsafeProjectFile(join(project.dir, "tasks.md"), project.root) ? boardSummary(project.dir) : undefined,
    files: instructionFiles(o.cwd, project.root, loaded.instructions),
  })
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
  if (memoryOnServer && !lembasLibrary) serverMemory = undefined, frozen = freeze()
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
  /** Prototypes: offered by the client for this session, or by `prototypes: true` for a terminal's. */
  const prototypesBlock = () => (context.prototypes?.offered || (!context.prototypes && loaded.config.prototypes === true) ? { sources: context.prototypes?.sources ?? "" } : undefined)
  /** The three personal keys this session uses: the client's for it, else the config's. */
  const personal = () => (context.personalization ? personalConfig({ enabled: true, available: true, ...context.personalization }) : loaded.config)
  const system = (m: Mode, current: ResolvedModel, subagent?: { name: string; instructions: string; report: boolean; skills: boolean; recall: boolean }, at?: { cwd: string; root: string }, plan?: Plan) =>
    assembleSystem({
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
      files: at ? undefined : frozen.files,
      subagent,
      memory: frozen.memory,
      // The skills block tells of skill_view; a subagent without the tool gets no block.
      skills: subagent && !subagent.skills ? undefined : frozen.skills,
      manageSkills: true,
      // Read on every prompt: /personality and /settings change it without a restart.
      ...personalityOf(personal()),
      mcp: mcp.instructions(),
      roster: roster(current.ref),
      plan,
      ...(context.instructions ? { instance: { name: contextFrom, instructions: context.instructions } } : {}),
      library: libraryBlock(),
      prototypes: prototypesBlock(),
      context: subagent ? subagent.recall : true,
    })
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
    const m = opts.model ? resolveModel(loaded, opts.model) : spec.model ? resolveModel(loaded, spec.model) : engine.model
    const refused = capacityRefusal(engine.model, m) || registry.running(jobsSessionId()).filter((j) => j.kind === "subagent" && j.subagent).map((j) => capacityBeside(j.subagent!.engine.model, m)).find(Boolean)
    if (refused) throw new ToolError(`${refused} Do this part yourself, or hand it to a model on another connection.`)
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
    const childTools = [...tools.filter((t) => !NOT_FOR_SUBAGENTS.has(t.name) && (!spec.tools || spec.tools.includes(t.name))), ...BUILTIN_TOOLS.filter((t) => SUBAGENT_ONLY.has(t.name))]
    const description = opts.description ?? prompt.split("\n")[0]!.slice(0, 60)
    const ownerSession = jobsSessionId()
    const childRow = store?.createSession(at?.root ?? project.root, m.ref, engine.sessionId)
    if (childRow) store!.setTitle(childRow.id, `${spec.name}: ${description}`)
    const childSessionId = childRow?.id ?? `${ownerSession}/${crypto.randomUUID().slice(0, 8)}`
    const childBus = new Bus()
    let job: Job
    // The asker is the session's; a child's ask says which subagent it comes from.
    const askerFor = (): Asker => ({
      ask: (req) => o.asker.ask({ ...req, source: { jobId: job.id, agent: spec.name, description } }),
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
      // An agent's own mode can make it stricter than its parent, never looser.
      mode: stricterMode(spec.mode, engine.mode),
      effort: m.ref === engine.model.ref ? engine.effort : startEffort(m),
      maxSteps: loaded.config.limits?.subagent_steps ?? LOOP.jobs.subagent_steps.default,
      compaction,
      perm: childPerm,
      toolCtx: {
        ...baseToolCtx(),
        ...(at ? { root: at.root, cwd: at.cwd, projectDir: undefined } : {}),
        jobs: { registry, owner: () => ({ sessionId: childSessionId, job }) },
      },
      steerMark: MARKS.to_subagent,
      system: (mode, current, plan) =>
        system(
          mode,
          current,
          {
            name: spec.name,
            instructions: wt
              ? `${spec.instructions}\n\nYou are working in a separate checkout of the repository, at ${at!.root}, on the branch ${wt.branch} (made from the last commit — uncommitted work of the main agent is not here). Work only inside it. When you finish, your changes are committed on that branch for the main agent to merge: do not commit, merge or push yourself.`
              : spec.instructions,
            report: childTools.some((t) => t.name === "report"),
            skills: childTools.some((t) => t.name === "skill_view"),
            recall: childTools.some((t) => t.name === "recall"),
          },
          at,
          plan,
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
    const run = (text: string) => child.prompt(text).then(finish, (e) => (job.lastError = (e as Error).message, finish("error")))
    const handle: SubagentHandle = {
      bus: childBus,
      engine: child,
      send: (text) => child.enqueue(text),
      restart: (text) => run(text).then(() => undefined),
      cancel: () => child.cancel(),
    }
    job = registry.startSubagent({ sessionId: ownerSession, ownerCallId: opts.callId, ownerJobId: baseOwner().job?.id, agent: spec.name, model: m.ref, description, handle, childSessionId, silent: !opts.background })
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
    toolCtx: { ...baseToolCtx(), jobs: { registry, owner: baseOwner } },
    system: (m, current, plan) => system(m, current, undefined, undefined, plan),
    persistRule: trusted ? (rule) => persistProjectRule(project, rule) : undefined,
    spawn,
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
      if (s.status === "connected") bus.emit({ type: "notice", message: `MCP ${s.name}: connected — ${s.tools.length} tool${s.tools.length === 1 ? "" : "s"}${s.prompts.length ? `, ${s.prompts.length} prompt${s.prompts.length === 1 ? "" : "s"}` : ""}` })
      else if (s.status === "failed" || s.status === "needs_auth") bus.emit({ type: "notice", message: `MCP ${s.name}: ${s.error ?? s.status}` })
    }
  })
  const mcpReady = mcp.start()
  /** The server's memory entries for the prompt (`lembas://memory`), read as a session starts, in
   *  the session's scope: put into the prompt while nothing has been sent yet, kept for the next
   *  session otherwise — the prompt does not change under a session. */
  const readServerMemory = async () => {
    if (!lembasLibrary || !serverMemory) return
    try {
      const text = await mcp.readResource(LIBRARY_SERVER, MEMORY_RESOURCE, engine.o.toolCtx.libraryScope)
      serverMemory = { text }
      if (!engine.messages.length && memoryOn) frozen = { ...frozen, memory: text }
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
      if (key === "effort") return engine.effort ?? "off"
      if (key === "mode") return engine.mode
      return key.split(".").reduce<unknown>((x, k) => (x && typeof x === "object" ? (x as Record<string, unknown>)[k] : undefined), loaded.config)
    },
    check(key, v) {
      if (key === "model" || key === "small_model") resolveModel(loaded, String(v))
      if (key === "effort" && v !== "off" && !effortsFor(engine.model).includes(v as Effort))
        throw new Error(`${engine.model.ref} takes ${effortsFor(engine.model).join(", ")} or off`)
      if (key === "knowledge") for (const b of v as string[]) if (!library.base(b)) throw new Error(`there is no knowledge base "${b}" — lembas kb lists them`)
    },
    apply(key, v) {
      if (key === "model") switchModel(String(v))
      else if (key === "effort") engine.effort = v === "off" ? null : (v as Effort)
      else if (key === "mode") engine.mode = v as Mode
      else if (key === "limits.steps") engine.o.maxSteps = Number(v)
      else if (key === "busy_input") engine.busyInput = v as "steer" | "queue"
      else if (key === "limits.bash_timeout") engine.o.toolCtx.bashTimeoutMs = Number(v) * 1000
      else if (key === "limits.wall_seconds" || key === "limits.output_bytes" || key === "limits.completion_tokens") engine.o.budget = { ...engine.o.budget, [key.slice("limits.".length)]: Number(v) }
      else if (key === "compaction.auto_at") compaction.autoAt = Number(v)
      else if (key === "knowledge") libraryCtx.bases = (v as string[]).length ? (v as string[]) : undefined
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
