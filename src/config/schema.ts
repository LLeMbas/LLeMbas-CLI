import { z } from "zod"

export const DIALECTS = ["openai-chat", "responses", "anthropic", "gemini", "ollama"] as const
export const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const
export const MODES = ["manual", "edit", "auto", "plan"] as const
/** The personality presets (harness/prompts/personality/, shared with the web UI), then custom. */
export const PERSONALITY_PRESETS = ["concise", "pragmatic", "optimistic", "funny", "formal", "socratic"] as const
export const PERSONALITIES = [...PERSONALITY_PRESETS, "custom"] as const
/** Older names of a mode, still read wherever a mode is written by hand (harness spec v1 renamed
 *  `unrestricted` to `auto`, LLeMbas's word). */
export const MODE_ALIASES: Record<string, (typeof MODES)[number]> = { unrestricted: "auto" }
export const ACTIONS = ["allow", "ask", "deny"] as const

export type Effort = (typeof EFFORTS)[number]
export type Mode = (typeof MODES)[number]
export type Action = (typeof ACTIONS)[number]

/** Permission keys the harness spec renamed (v1; 1.1.0 folded todo into the plan tools, whose key
 *  is `plan`), read as the new ones in a config's `permission:` and in the spec's own defaults. */
export const PERMISSION_ALIASES: Record<string, string> = { question: "ask_user", plan_exit: "plan_submit", websearch: "web_search", webfetch: "web_fetch", todo: "plan", bash_output: "job_output", bash_list: "job_list", bash_kill: "job_stop" }

export function renamePermissionKeys(p: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(p)) {
    const to = PERMISSION_ALIASES[k]
    // The new name written as well wins: it is the one somebody wrote on purpose.
    if (to) out[to] ??= v
    else out[k] = v
  }
  return out
}

/** A mode as written (a config file, --mode, /mode, an agent file, the settings tool), with the
 *  old names read as the new; undefined when it is not one. */
export function asMode(v: unknown): Mode | undefined {
  if (typeof v !== "string") return undefined
  const t = v.trim()
  if ((MODES as readonly string[]).includes(t)) return t as Mode
  return MODE_ALIASES[t]
}

const Tristate = z.enum(["auto", "on", "off"])
/** A URL — or a string that becomes one when its {env:}/{file:} is filled in. Files are validated
 *  before substitution, so the placeholder must pass here; the loader checks the result again. */
const Url = z.string().refine((s) => /\{(env|file):[^}]+\}/.test(s) || URL.canParse(s), { message: "Invalid URL" })
const Tls = z.strictObject({ ca: z.string().optional(), insecure: z.boolean().optional() })

export const ModelSpec = z.strictObject({
  name: z.string().optional().describe("A display name; the id is what is sent."),
  family: z.string().optional().describe("Picks the prompt overlay: anthropic | gpt | gemini | local. Guessed from the id when absent."),
  context: z.number().int().nonnegative().optional().describe("Total context window in tokens. 0 / absent = unknown: no percentage, no auto-compaction."),
  max_output: z.number().int().positive().optional().describe("Max tokens per reply."),
  temperature: z.number().min(0).max(2).optional().describe("Sampling temperature; absent = the server's default."),
  top_p: z.number().min(0).max(1).optional().describe("Nucleus sampling; absent = the server's default."),
  efforts: z.array(z.enum(EFFORTS)).optional().describe("The model's own effort vocabulary, in offering order."),
  effort: z.union([z.enum(EFFORTS), z.literal("off")]).optional().describe("Default effort; `off` sends none."),
  effort_style: z.enum(["top", "kwargs", "both"]).optional().describe("openai-chat only: where the effort goes. llama.cpp drops top-level, so `both` is the default."),
  effort_map: z.partialRecord(z.enum(EFFORTS), z.number().int().positive()).optional().describe("anthropic/gemini: effort → thinking budget tokens."),
  vision: z.boolean().optional().describe("The model reads images: @image files, pasted paths and view_image."),
  tools: z.boolean().optional().describe("false: a model without tool calls — it can only talk."),
  cache: z.boolean().optional().describe("anthropic: prompt caching breakpoints."),
  headers: z.record(z.string(), z.string()).optional().describe("Extra HTTP headers for this model's requests."),
  body: z.record(z.string(), z.unknown()).optional().describe("Merged into every request body for this model."),
  notes: z.string().max(300).optional().describe("What this model is good at, in a line: the model in use is told which others there are, for handing work over (task) or switching."),
  fallback: z.array(z.string()).optional().describe("Other models (connection/model), in order, to switch to when this one's server cannot be reached at all — never once a reply has begun."),
  single_session: z.boolean().optional().describe("The server serves one request at a time: a subagent on this same model would take its only slot and push the session's cached prompt out, so it is refused."),
  group: z.string().optional().describe("Models sharing one server that holds one model at a time (llama-swap), named by any string: a subagent on another model of the same group would unload this one, so it is refused. One connection's one_model_at_a_time is the same rule for all its models; this is for models one connection serves from several such servers (a LLeMbas instance)."),
})
export type ModelSpec = z.infer<typeof ModelSpec>

export const Connection = z.strictObject({
  dialect: z.enum(DIALECTS).describe("The API it speaks: openai-chat (llama.cpp, vLLM, LM Studio, OpenAI…), responses (OpenAI Responses), anthropic, gemini, ollama (its native /api/chat)."),
  base_url: Url.describe("Where the API is, e.g. https://api.openai.com/v1 or http://localhost:8080/v1."),
  api_key: z.string().optional().describe("Never pasted: {env:NAME} or {file:~/path}. Or use key_cmd."),
  key_cmd: z.string().optional().describe("A command whose output is the key, e.g. pass show openai."),
  auth: z.enum(["bearer", "x-api-key", "x-goog-api-key", "none"]).optional().describe("How the key is sent. Default per dialect: anthropic x-api-key, gemini x-goog-api-key, others bearer."),
  headers: z.record(z.string(), z.string()).optional().describe("Extra HTTP headers for every request."),
  body: z.record(z.string(), z.unknown()).optional().describe("Merged into every request body."),
  tls: Tls.optional().describe("TLS for endpoints behind a private CA. `ca` is a PEM file added to the trusted roots; `insecure` skips verification entirely (last resort). The system store is always trusted."),
  timeout: z.number().positive().optional().describe("Seconds of silence allowed: waiting for the response, then between two pieces of a streamed reply. Not a limit on how long a reply may take. Default 600."),
  discover: z.boolean().optional().describe("Merge ids and context lengths from GET /models."),
  unload_url: Url.optional().describe("llama-swap style: frees VRAM when switching away."),
  one_model_at_a_time: z.boolean().optional().describe("The server holds one model at a time (llama-swap in front of one GPU): a subagent on another of its models would unload the session's, so it is refused. The session's own model may still be its own subagent."),
  unload_method: z.enum(["GET", "POST"]).optional().describe("How unload_url is called (default POST)."),
  quirks: z
    .strictObject({
      stream_usage: Tristate.optional().describe("Ask for token usage in the stream (stream_options); auto learns when a server refuses it."),
      prompt_progress: Tristate.optional().describe("Ask how far the server is through reading the prompt (llama.cpp's return_progress), shown while it reads; auto learns when a server refuses it, and one that ignores it shows nothing."),
      think_tags: Tristate.optional().describe("<think>…</think> in a reply is taken as reasoning; off leaves it as text."),
      max_tokens_field: z.enum(["max_tokens", "max_completion_tokens"]).optional().describe("OpenAI reasoning models refuse `max_tokens`; most local servers only know it."),
    })
    .optional()
    .describe("Server oddities; auto is right almost always."),
  models: z.record(z.string(), ModelSpec).default({}).describe("The models to offer, by the id the server knows them by."),
})
export type Connection = z.infer<typeof Connection>

/** A LLeMbas instance: its address and this machine's key, and nothing else. The models,
 *  their settings, and — where config.yaml says `provider: webui` — the voice and the web search come
 *  from the instance at every start. `lembas login` writes it. */
export const WebuiConnection = z.strictObject({
  type: z.literal("webui").describe("A LLeMbas instance: its models, their settings, its voice and its web search."),
  url: Url.describe("The instance's address, e.g. https://ai.example.org (no /v1)."),
  api_key: z.string().optional().describe("This machine's token, as login wrote it: {file:~/.config/lembas/lembas/<name>.key}. Or key_cmd."),
  key_cmd: z.string().optional(),
  tls: Tls.optional().describe("For an instance behind a private CA: `ca`, the PEM file that signed its certificate."),
  timeout: z.number().positive().optional().describe("Seconds of silence allowed in a reply, as for any connection (default 600)."),
  quirks: Connection.shape.quirks,
  models: z.record(z.string(), ModelSpec).optional().describe("Only to change what the instance says about a model, here: each entry goes over the instance's. Usually absent."),
})
export type WebuiConnection = z.infer<typeof WebuiConnection>

export const ConnectionsFile = z.strictObject({
  connections: z
    .record(z.string(), z.union([WebuiConnection, Connection]))
    .default({})
    .describe("Each LLM endpoint by a name of your choosing; a model is then `name/model-id`. `type: webui` is a LLeMbas instance, whose models come from it."),
})
export type ConnectionsFile = z.infer<typeof ConnectionsFile>

const ActionSchema = z.enum(ACTIONS)
/** `tool: action` or `tool: { pattern: action }` — order matters, last match wins. */
export const PermissionConfig = z.record(z.string(), z.union([ActionSchema, z.record(z.string(), ActionSchema)]))
export type PermissionConfig = z.infer<typeof PermissionConfig>

const Section = z.record(z.string(), z.unknown())

const VoiceEndpoint = {
  base_url: z.string().optional(),
  api_key: z.string().optional(),
  key_cmd: z.string().optional(),
  tls: Tls.optional(),
  timeout: z.number().positive().optional(),
}

/** `provider: webui`: through a LLeMbas instance's own speech servers, with the account's
 *  voice, speed and language. */
const WebuiVoice = {
  connection: z.string().optional().describe("webui: which webui connection (default: the only one there is)."),
}

const SttEndpoint = z.strictObject({
  provider: z.enum(["openai", "whispercpp", "webui"]).optional().describe("openai: POST {base_url}/audio/transcriptions (OpenAI, whisper.cpp's server with its OpenAI path, faster-whisper servers). whispercpp: POST {base_url}/inference (whisper.cpp's own). webui: the LLeMbas instance's."),
  ...VoiceEndpoint,
  ...WebuiVoice,
  model: z.string().optional(),
  language: z.string().optional(),
  prompt: z.string().optional().describe("Words it should expect: names, jargon."),
})

const TtsEndpoint = z.strictObject({
  provider: z.enum(["openai", "piper-http", "piper-cli", "webui"]).optional().describe("openai: POST {base_url}/audio/speech (OpenAI, Kokoro-FastAPI). piper-http: POST {base_url} with {text} (piper's http_server). piper-cli: the piper program. webui: the LLeMbas instance's, in the account's voice."),
  ...VoiceEndpoint,
  ...WebuiVoice,
  model: z.string().optional(),
  voice: z.string().optional(),
  speed: z.number().min(0.25).max(4).optional(),
  command: z.string().optional().describe("piper-cli: the program (default piper) and the voice model file (.onnx)."),
  model_path: z.string().optional(),
})

/** Voice: speech to text, text to speech, and how to record and play. Global only — it
 *  carries endpoints and keys, like a connection. */
export const Voice = z.strictObject({
  stt: SttEndpoint.extend({ fallback: SttEndpoint.optional().describe("Used when the provider above cannot be reached — for webui, when the instance is down. Same fields.") }).optional(),
  tts: TtsEndpoint.extend({ fallback: TtsEndpoint.optional().describe("Used when the provider above cannot be reached — for webui, when the instance is down. Same fields.") }).optional(),
  record_key: z.string().optional().describe("The key that starts and stops recording (default ctrl+t)."),
  record_mode: z.enum(["toggle", "hold"]).optional().describe("toggle (default): press to start, press again (or silence) to stop. hold: also stops when the key is let go, in terminals that report it (the kitty keyboard protocol)."),
  submit: z.enum(["draft", "send"]).optional().describe("What happens to what you said: draft (default) puts it in the prompt to check; send sends it."),
  speak: z.boolean().optional().describe("Speak every reply (default false; /speak toggles it)."),
  silence_seconds: z.number().positive().optional().describe("Seconds of silence after speech that end a recording (default 3), and the longest one (120)."),
  max_seconds: z.number().positive().optional(),
  silence_threshold: z.number().positive().optional().describe("Loudness (RMS of 16-bit samples) below which it counts as silence (default 200)."),
  recorder: z.enum(["auto", "arecord", "pw-record", "parec", "sox", "ffmpeg"]).optional().describe("auto, or a program: arecord, pw-record, parec, sox, ffmpeg. `recorder_command` instead: any command printing raw 16 kHz mono signed 16-bit little-endian audio to stdout."),
  recorder_command: z.array(z.string()).min(1).optional(),
  player: z.enum(["auto", "pw-play", "paplay", "aplay", "ffplay", "mpv", "afplay"]).optional().describe("auto, or a program: pw-play, paplay, aplay, ffplay, mpv, afplay. `player_command` instead: any command; the WAV file's path is added at the end."),
  player_command: z.array(z.string()).min(1).optional(),
})
export type Voice = z.infer<typeof Voice>

/** One MCP server: `command` (stdio, a local process) or `url` (streamable HTTP, SSE fallback). */
export const McpServer = z
  .strictObject({
    command: z.union([z.string(), z.array(z.string()).min(1)]).optional().describe("A local server: the program (and its arguments, as a list). Either this or url."),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional().describe("Environment for the local server; {env:}/{file:} work here."),
    cwd: z.string().optional(),
    url: z.string().optional().describe("A remote server: its streamable HTTP (or SSE) address. Either this or command."),
    headers: z.record(z.string(), z.string()).optional().describe("Extra HTTP headers, e.g. Authorization: Bearer {env:TOKEN}."),
    transport: z.enum(["http", "sse"]).optional().describe("http (default: streamable HTTP, falling back to SSE) or sse."),
    oauth: z
      .union([
        z.literal(false),
        z.strictObject({ client_id: z.string().optional(), client_secret: z.string().optional(), scope: z.string().optional(), callback_port: z.number().int().positive().optional() }),
      ])
      .optional()
      .describe("OAuth for a remote server: on by default when the server asks for it; false turns it off."),
    tls: Tls.optional(),
    enabled: z.boolean().optional().describe("false: configured but not started (/mcp on starts it)."),
    timeout: z.number().positive().optional().describe("Seconds: one tool call (default 120), connecting (default 30)."),
    connect_timeout: z.number().positive().optional(),
    tools: z.strictObject({ include: z.array(z.string()).optional(), exclude: z.array(z.string()).optional() }).optional().describe("Which of its tools to offer: include wins; names or globs (`create_*`)."),
    prompts: z.boolean().optional().describe("Offer its prompts as /server:prompt commands (default true)."),
    resources: z.boolean().optional().describe("Offer list/read tools for its resources, if it has any (default true)."),
    instructions: z.boolean().optional().describe("Put the server's own instructions into the system prompt (default true)."),
  })
  .refine((s) => (s.command === undefined) !== (s.url === undefined), { message: "give either command (a local server) or url (a remote one)" })
export type McpServer = z.infer<typeof McpServer>

export const UPDATE_CHANNELS = ["stable", "beta"] as const

/** Where updates come from and how they are checked. Global only: a project never decides
 *  what binary runs. */
export const Update = z.strictObject({
  channel: z.enum(UPDATE_CHANNELS).optional().describe("stable (default): releases vX.Y.Z only. beta: also vX.Y.Z-beta.N — whichever is newest."),
  auto: z.enum(["install", "notify", "off"]).optional().describe("On start: install (default) — fetch, verify and install a newer release, then say so; notify — only say one is out; off — never look."),
  source: z
    .strictObject({
      type: z.enum(["github", "gitea", "static"]).describe("github or gitea (Forgejo too): their releases API. static: any web directory with files `stable` and `beta` naming a tag, and the assets under <tag>/."),
      url: Url.optional().describe("gitea: the forge (https://git.example.org). github: the API (default https://api.github.com). static: the directory."),
      repo: z.string().regex(/^(?!\.\.?\/)[\w.-]+\/(?!\.\.?$)[\w.-]+$/).optional().describe("owner/name, for github and gitea."),
      token: z.string().optional().describe("For a private repository: {env:NAME} or {file:~/path}, never pasted. Or key_cmd."),
      key_cmd: z.string().optional(),
      tls: Tls.optional(),
    })
    .optional()
    .describe("Default: the public LLeMbas CLI releases on GitHub."),
  public_key: z.union([z.string(), z.array(z.string())]).optional().describe("The ssh-ed25519 key(s) a release's SHA256SUMS.sig must be signed with — instead of LLeMbas CLI's own. For your own builds."),
  verify: z.enum(["signature", "checksum"]).optional().describe("signature (default): SHA256SUMS must carry a valid signature. checksum: checksums only — for a source of your own that does not sign."),
})
export type Update = z.infer<typeof Update>

export const Config = z.strictObject({
  model: z.string().optional().describe("The model a session starts with: `connection/model`, a connection from connections.yaml and one of its models."),
  small_model: z.string().optional().describe("`connection/model` for small jobs — session titles, commit messages. Default: the session's model. On a server that holds one model at a time (llama-swap), another model here swaps."),
  titles: z.enum(["model", "prompt"]).optional().describe("Session titles: model (default) — named from the first prompt, then by the model after its first reply; prompt — only from the first prompt, no extra request."),
  mode: z.enum(MODES).optional().describe("The permission mode a session starts in (default manual)."),
  theme: z.string().optional().describe("Colours: moria (default), shire, lembas, lembas-light, hermes, mono, or a themes/<name>.yaml of your own."),
  theme_background: z.enum(["theme", "terminal"]).optional().describe("theme (default): the theme paints the whole screen; terminal: the terminal's own background shows, and the theme colours only text, panels and accents."),
  skin: z.string().optional().describe("The old name of `theme`; still read when `theme` is not set."),
  busy_input: z.enum(["steer", "queue"]).optional().describe("A message sent while the agent works: steer (default) — it goes in at the next step, after the running tools finish, and the agent carries on with it; queue — it is sent as the next prompt once the task is done."),
  mouse: z.boolean().optional().describe("false: leave the mouse to the terminal — its own selection and Ctrl+Shift+C work without Shift, and the wheel no longer scrolls the transcript (pgup/pgdn do). Default true."),
  icons: z.enum(["emoji", "plain"]).optional().describe("emoji (default), or plain: one-column symbols for a terminal font that has no emoji."),
  personality: z
    .enum(PERSONALITIES)
    .or(z.literal(""))
    .optional()
    .describe("How the agent talks: concise, pragmatic, optimistic, funny, formal, socratic, custom (personality_custom's text), or empty for none (the default). The same presets as the LLeMbas web UI; appended last to the system prompt, under \"## Personality\"."),
  personality_custom: z.string().max(1500).optional().describe("The personality, in your own words: used when personality is custom (at most 1500 characters)."),
  memory: z
    .strictObject({
      enabled: z.boolean().optional().describe("false: no memory tool and nothing remembered in the prompt."),
      memory_chars: z.number().int().positive().optional().describe("Size limits in characters: memory 2200, user 1375 by default."),
      user_chars: z.number().int().positive().optional(),
    })
    .optional()
    .describe("Persistent memory (MEMORY.md, USER.md in ~/.config/lembas/memory/)."),
  skills: z
    .strictObject({
      external_dirs: z.array(z.string()).optional().describe("More directories of skills, read-only; a skill of the same name elsewhere wins."),
      disabled: z.array(z.string()).optional().describe("Skill names not to offer."),
    })
    .optional(),
  permission: PermissionConfig.optional().describe("Rules per tool: `tool: allow|ask|deny` or `tool: { pattern: action }`; the last match wins."),
  hardline_extra: z.array(z.string()).optional().describe("Global config only: extra never-allowed bash regexes."),
  hardline_disable: z.array(z.string()).optional().describe("Global config only: ids of built-in hardline rules to switch off."),
  limits: z
    .strictObject({
      steps: z.number().int().positive().optional().describe("Most model steps in one prompt (default 200) — a runaway backstop, not a budget."),
      bash_timeout: z.number().positive().optional().describe("Seconds a bash command may run in the foreground before it goes on in the background as a job (default 120)."),
      jobs: z.number().int().positive().optional().describe("Background commands one session may have running at once (default 8)."),
      subagent_steps: z.number().int().positive().optional().describe("Most model steps in one subagent run (default 50) — a runaway backstop, not a budget."),
      wall_seconds: z.number().positive().optional().describe("Budget for one prompt: seconds of work, not counting time spent waiting for you. Past it the model answers from what it has. Unset: none."),
      output_bytes: z.number().int().positive().optional().describe("Budget for one prompt: bytes of tool output read. Unset: none."),
      completion_tokens: z.number().int().positive().optional().describe("Budget for one prompt: tokens the model writes. Unset: none."),
    })
    .optional(),
  question: z.strictObject({ unattended: z.enum(["recommended", "first", "fail"]).optional().describe("With nobody to answer (headless): take the recommended option, the first, or fail.") }).optional(),
  compaction: z.strictObject({ auto_at: z.number().min(0.1).max(1).optional(), prune: z.boolean().optional() }).optional().describe("Automatic context management: past auto_at of the window, old tool outputs are pruned, then the conversation is compacted. auto_at: 1 turns it off."),
  instructions: z.string().max(4000).optional().describe("Custom instructions: how you want to be helped, in your own words (at most 4000 characters). Appended near the end of the system prompt, under \"## How the person you are talking to wants to be helped\" — as in the LLeMbas web UI. (A list of files here, from an older config, is read as instruction_files.)"),
  instruction_files: z.array(z.string()).optional().describe("More instruction files for the system prompt, besides AGENTS.md / CLAUDE.md."),
  search: z
    .strictObject({
      order: z.array(z.enum(["webui", "searxng", "firecrawl", "ddg"])).optional().describe("Providers to try, in order; the first that answers wins. Default: those configured (webui first), then ddg. webui: the LLeMbas instance's own search."),
      max_results: z.number().int().min(1).max(30).optional().describe("Results per search (default 8)."),
      searxng: z.strictObject({ base_url: Url, api_key: z.string().optional(), tls: Tls.optional(), categories: z.string().optional(), language: z.string().optional() }).optional(),
      firecrawl: z.strictObject({ base_url: Url.optional(), api_key: z.string().optional(), tls: Tls.optional() }).optional().describe("API (api.firecrawl.dev, with a key) or self-hosted (its own URL, no key needed)."),
      ddg: z.strictObject({ region: z.string().optional(), safe: z.enum(["strict", "moderate", "off"]).optional() }).optional(),
      webui: z.strictObject({ connection: z.string().optional().describe("Which webui connection (default: the only one there is).") }).optional().describe("Search through a LLeMbas instance: its provider, its settings, its keys."),
      fetch: z.enum(["local", "firecrawl", "webui"]).optional().describe("How web_fetch reads a page: here, through Firecrawl's scrape, or through the LLeMbas instance."),
    })
    .optional(),
  voice: Voice.optional().describe("Voice in and out. Global only — it carries endpoints and keys, like a connection."),
  mcp: z.record(z.string(), McpServer).optional().describe("MCP servers by name. `{env:}`/`{file:}` are filled in per server (a missing one disables that server only). A project's servers count only once the project is trusted."),
  knowledge: z.array(z.string()).optional().describe("The knowledge bases searched (lembas kb); absent: all of them. A project's own config narrows it to what that project needs."),
  embedding: z.string().optional().describe("Global config only. connection/model of an embedding model (OpenAI-shaped /embeddings, or Ollama): knowledge bases are then searched by meaning as well as by words. lembas kb reindex after changing it."),
  effort: z.union([z.enum(EFFORTS), z.literal("off")]).optional().describe("The effort a session starts with, when the model takes it; otherwise the model's own default."),
  settings_tool: z.enum(["ask", "allow", "off"]).optional().describe("Global config only. The agent's settings tool: ask (default) — each change is approved like any tool call; allow — changes go through without asking (a less strict mode still asks); off — no settings tool."),
  update: Update.optional().describe("Global config only. Updating LLeMbas CLI itself."),
  prototypes: z.boolean().optional().describe("Global config only. Offer the model prototypes: a complete HTML page in a `prototype-chat` or `prototype-page` fence, saved as a file under the state directory (prototypes/<session>/) and listed by /prototype; the LLeMbas web UI renders the same fences live. Default false."),
  library: z.enum(["local", "lembas"]).optional().describe("Global config only. local (default): memory, notes, skills and knowledge on this machine. lembas: the account's on the LLeMbas instance you are logged in to, through its /mcp — the same tools its chats have (needs a login with the library scope)."),
  remote: z
    .strictObject({
      enabled: z.boolean().optional().describe("Accept work from a LLeMbas instance this machine is logged in to (lembas service). Default false."),
      roots: z.array(z.string()).optional().describe("The directories a remote session may be opened in, and anything under them. Empty: none."),
      max_mode: z.enum(MODES).optional().describe("The most permissive mode a remote session may run in (default edit). auto only when set here."),
      approval_timeout: z.number().int().positive().optional().describe("Seconds an approval waits for an answer from the web before it counts as a denial (default 600)."),
      require_trust: z.boolean().optional().describe("Only projects trusted on this machine (default true)."),
      terminal: z.boolean().optional().describe("Let the web UI open a terminal here (LLeMbas's terminal panel on a chat on this device): a login shell as this user, in a directory remote sessions may use. Default false."),
      terminal_integration: z.boolean().optional().describe("Shell integration in those terminals (bash, zsh, fish): after your own startup files, the shell marks each prompt, command and exit status (OSC 133) and its directory (OSC 7), so the web UI shows the directory, a mark beside each finished command, and can jump between commands. false: the shell starts as it is. Default true."),
    })
    .optional()
    .describe("Global config only. What a LLeMbas instance may ask of this machine over the link: the device decides, never the server."),
})
export type Config = z.infer<typeof Config>
