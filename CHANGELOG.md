# Changelog

All notable changes to LLeMbas CLI. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

LLeMbas CLI 2.0 works with LLeMbas 2.0 and nothing else: it uses the server it is logged in to,
keeps tool results short without ever rewriting what the model has already read, and reads every
instruction file on the way down to where it was started. Harness spec 3.0.0.

### Changed

- **The CLI talks only to the LLeMbas server it is logged in to.** Custom connections are gone:
  the OpenAI-compatible, Responses, Anthropic, Gemini and Ollama connections in `connections.yaml`,
  with their `dialect`, `key_cmd`, `auth`, `discover`, `unload_url` and `one_model_at_a_time`,
  and a model's `fallback`. Log in with `lembas login <address>`; without a login the CLI says so
  and how. An old `connections.yaml` still starts: an entry that is not the login is named in a
  warning and ignored. One server at a time: logging in to another signs this machine out of the
  first.
- **Models are named as the server serves them** (`deepseek/deepseek-flash`), with no connection
  in front; a `config.yaml` naming one the old way is rewritten once. The context window,
  efforts and capacity are the server's word.
- **Memory is the server's**, shared with your chats there (when the login's token may reach it):
  the `memory` tool and the memory in the prompt. Notes, knowledge bases and skills stay on this
  machine.
- **Logging in asks for the `memory` scope** in place of `library`; a login made before keeps
  working with the one it has.
- **Usage is money, not credits.** The status bar shows what the month has cost so far, and
  `/usage` the month's tokens and cost and this device's tokens — each currency's amount on its
  own (`€2.00 · $0.75`), never added together. Plans, balances, rolling windows and the
  `unlimited` of an administrator are gone with the server's credits.
- **Instruction files stack.** Every `AGENTS.md` (or `CLAUDE.md`) from the project root down to the
  working directory goes to the model, outermost first — not only the nearest one.
- **Tool results are kept short when they come in, and never changed afterwards**, so the server's
  prompt cache holds. Every result has an id (`[#0001]`); a read says its lines and a hash of the
  file; reading an unchanged file again, or the same listing or search with the same result,
  answers with a pointer to the earlier result; output over 400 lines or 40,000 characters keeps its
  beginning and its end; edits answer with their diff. `compaction.prune`, which cut old outputs
  and made the server read the whole conversation again, is removed.
- **The link speaks protocol 3** with a LLeMbas 2.0 server. A 1.x server is refused at login and by
  the link, saying to update the server (or use LLeMbas CLI 1.x); a newer one says to update the CLI.
- **A chat started on a model runs on that model.** When the web UI opens a session on this device
  with a model the device cannot run, it is refused with the reason instead of being answered on
  the device's own model.
- **File tools speak the server's words.** A missing file is `No such file or directory: <path>`
  from `read`, `edit`, `multiedit`, `show`, `list`, `glob` and `grep` alike; a file `write` or
  `edit` may not change yet says it has not been read, or changed since it was last read, with its
  full path. `glob` and `grep` give full paths. `list` sorts names exactly (capitals first) and says
  when it stopped at 400 lines.
- **A new skill's name** is lowercase letters, digits and `-`, up to 64 characters, as the Agent
  Skills format has it; `_` and `.` are no longer accepted when `skill_manage` makes one. Skills
  that already have such a name still load.

### Added

- **`recall`**: the model can see any earlier tool result again, in full or from a line on — the
  part of a long output left out, or a result from before the conversation was summarised. After
  a summary the model also gets a table of the files it had read.
- **`show`**, in a session the web UI or LLeMbas Desktop opened: the model can open a file it made
  — a page, a document — in your viewer beside the chat.

## [1.5.2] — 2026-10-25

Logging in again leaves one device, and a link that cannot connect says why.

### Fixed

- **Logging in again left an offline twin of this device on the instance.** A second
  `lembas login` to the same instance overwrote the old token without signing it out, so the web
  UI showed the device twice -- the new one linked, the old one offline and holding its agent
  chats. The old token is now signed out, naming the new one, and a LLeMbas server 1.7.2 or later
  moves the old device's agent chats to it. A sign-out that fails is said, with where to revoke it.
- **`lembas service` could not link when the login was given its CA as a relative path.** `login
  --ca` kept the path as typed, and the service, started in another directory, did not find it and
  dialled with no CA at all. The path is now kept in full, and a link to an instance whose
  certificate is signed by a CA in the system's store gets through even without `--ca`, as the
  rest of the CLI already did.
- **"Could not reach the instance" now says why**: a CA file given at login that is gone, a
  certificate that is not trusted, or what else the connection met.

## [1.5.1] — 2026-10-23

A screenshot no longer makes the session compact.

### Fixed

- **An image counted as half a million tokens.** The context estimate measured an image's base64
  as text, so a 1–3 MB screenshot read as "context at 150–280%" the moment `view_image` (or an
  `@` attachment) added it, and the session was compacted -- after every image, since the summary
  drops pictures and the model looked again. The provider's own count, a few thousand tokens, was
  never in question. An image now counts by its dimensions (28-pixel patches, at most 16k tokens;
  a flat 1600 when the size cannot be read), everywhere the CLI estimates: the context meter,
  pruning, `/context`, and the estimate a provider that reports no usage falls back to.
- **Screenshots are sent at 1600 px.** Any image over 1600 px or 500 KB is shrunk to 1600 px on
  its longer edge when ImageMagick is there (only files over 3.5 MB were before): no more detail
  than the model is billed for, and a lighter request.

## [1.5.0] — 2026-10-20

Harness spec 2.0.0: background work is one thing — a job — for commands and subagents alike, and
the person sees it.

### Added

- **Subagents in the background.** `task` takes `background: true`: the call returns at once with
  a job id and the model carries on; the subagent's report arrives as a message in the
  conversation when it ends — at the next step while the model works, as a turn of its own
  otherwise. A running subagent can be messaged (`job_send`: given to it at its next step) and a
  finished one started again with its context intact; a subagent can message the main agent
  before its final reply (`report`: a finding to act on now, or a question). Approval cards from
  a subagent say which one asks.
- **A subagent has a session of its own**, kept with the parent: its transcript survives a
  resume and can be read later; `/sessions` and `session_search` leave children out.
- **`job_list`, `job_output`, `job_stop`, `job_send`** replace `bash_list`, `bash_output` and
  `bash_kill` (which still work as former names, and a rule written for them still applies): one
  list of the session's background commands and subagents, one way to read, stop and message.
- **Jobs belong to the session** that started them, not to the process: another session's jobs
  are invisible, ids run per session, and a job's end note goes to its own session — kept for it
  when it is not open, delivered when it is resumed. Jobs are stored: a resumed session lists
  what finished while it was away, and a job the process died under is shown as lost with the
  output it had.
- **Jobs in the terminal.** The status bar counts the session's running jobs (`2 jobs`, with `!`
  when one ended unseen or has output the model has not read). `/jobs` lists them — kind, id,
  description or command, state, duration — and from there `Enter` opens one and `k` stops it: a
  command opens as its live output; a subagent is *entered*, its transcript shown in the
  conversation's place with a header saying where it is, and anything typed goes to it (a
  finished one starts again with the message, context intact). `Esc` leaves. `/jobs <id>` and
  `/jobs stop <id>` do the same from the prompt. A background call's line shows its job under it
  (`→ job7 (explore: description) running…`), and an approval card from a subagent names it.
- **Ctrl+B** moves the command the model is running in the foreground to the background now;
  the call returns with what it had printed and the job id.
- Quitting (`/quit`, Ctrl+C twice, Ctrl+D on an empty box) or `/reload` with jobs running asks
  first: `N jobs running — stop them and quit?`
- **Over the link** (capability `jobs`, harness spec 2.0.0): a LLeMbas server lists a session's
  jobs, reads a job's output, stops one, messages a subagent and reads its transcript
  (`_lembas/jobs`, `_lembas/job/output|stop|send|transcript`); `job` and `job_note` events, the
  jobs in `_lembas/session/status`, the subagent on an approval request, and a job's note as a
  `machine` prompt. A session a terminal holds answers the same through the hub.
- `limits.jobs` (background commands a session may run at once, default 8) and
  `limits.subagent_steps` (a subagent's step backstop, default 50) in the configuration.
- `lembas -p` waits for the jobs the prompt started and gives the model their notes before it
  exits (`--no-wait` skips that); `/agents` lists and describes agents over the link too.

### Changed

- **A command's `timeout` is when it stops blocking, not when it dies.** A foreground `bash`
  still running at its timeout (default `limits.bash_timeout`, 2 minutes) goes on in the
  background as a job, and the call returns what it had printed with the job id; `Esc` still
  kills it, so does `job_stop`. `background: true` returns at once instead of after 300 ms.
- A finished job wakes the model in every front end — the terminal, `lembas -p` and a session
  the web UI holds — where it used to reach only the terminal, and there as an unmarked message
  to whatever session was open. Every such message now carries its mark, and the terminal shows
  it as the harness's turn, not the person's.
- A stopped command reads "stopped (SIGTERM)" rather than "exited with null".
- The subagent's preamble and the built-in `explore` and `general` instructions are prompt texts
  of the harness spec (`blocks/subagent.md`, `agents/*.md`), shared with the server; a subagent
  is no longer told about `plan_write` and `ask_user`, which it does not have, nor about
  `skill_view` when it lacks it. `explore` gets the job tools; every subagent gets `report`.
- The capacity rule also counts the subagents already running.

### Fixed

- A subagent in a worktree that was stopped or failed kept its branch silently; the branch is
  named in its report now. In a worktree, the edit-mode guard and the plan directory pointed at
  the main checkout's `.agent`.
- A subagent's error or notice was dropped: its report said `ended: error` with no message.
- `/reload` with background jobs running lost them as orphans; so did quitting with one that
  ignored SIGTERM (the kill timer never fired at exit). A command whose child kept stdout open
  stayed "running" after it had exited.
- An agent file with broken YAML frontmatter was silently taken as having none; it is reported
  at start.
- A `!command` in the terminal could not be stopped.
- Headless runs opened a second line-reader for a parallel subagent's approval.
- Ctrl+D on an empty prompt quit only in a comment; it does now.
- `bun test` ran with a 5-second timeout per test, whatever `bunfig.toml` said: Bun 1.4 does not
  read `[test] timeout`. The test script and `scripts/ci.sh` pass `--timeout` explicitly.

## [1.4.0] — 2026-10-20

Harness spec 1.2.0: the library's tools are the same tools in LLeMbas.

### Changed

- The harness spec's memory, notes and skills tools now fit both projects. The CLI's facts in
  their descriptions — memory files and targets, project notes, supporting files, project skills,
  `session_search` — are the spec's `variables`, filled with the CLI's own values, so what a model
  is sent here is word for word what it was; LLeMbas sends the same tools with its own facts
  (LLeMbas 1.5.0). A CLI linked to an instance (`library: lembas`) therefore sees `memory`,
  `note_view`, `note_manage`, `skills_list`, `skill_view` and `skill_manage` whether the library is
  its own or the instance's, where it used to see the instance's `memory_add`, `notes_create` and
  the rest.
- Note and knowledge-document ids are strings in the tools' parameters, as they are on an instance;
  the number is still accepted.
- Tool descriptions are filled by the prompt texts' rules, and the descriptions inside a tool's
  parameters are filled too.

### Added

- `narrow` in the harness spec: what a project offers of a shared tool's parameters where it offers
  less than all. Three conformance areas, run by both projects: `fill`, `narrow`, and `memory` —
  one change or a batch, applied together, against the size limit, messages included.

## [1.3.0] — 2026-10-18

Harness spec 1.1.0: planning as one structure shared with LLeMbas.

### Added

- `plan_write` and `plan_update`, offered in every mode: the model writes its plan as a structure
  — title, summary, findings, objectives, phases of tasks — and keeps it current as it works
  (a task doing, done, or dropped with why; work added; a finding recorded). Ids (`p1`, `t3`,
  `o2`…) are given by the CLI, never by the model, and an unknown id is an error naming the known
  ones. The plan is the session's: it is stored with it, comes back on resume, and is gone on
  `/new`. The panel above the prompt shows the active phase, the task being done, what is next,
  the last two done and the count while anything is open; `/plan show` prints the whole plan
  with its ids, `/plan clear` drops it, and `/plans` says whether this session has one.
- A `plan` block kind: a plan change is not drawn as a tool line in the transcript; the panel
  and the card follow the plan itself.
- Over the link, an instance now hands the device what only it knows about a chat
  (`_meta.lembas` of `session/new` and `session/prompt`, capabilities `context`, `library`,
  `prototypes`): the chat's own instructions reach the prompt under `## Instructions from
  <instance>`, the account's personalization is used for that session in place of the device's,
  the knowledge bases the chat may search are named to the model, and whether it may write a
  prototype. A later prompt's context replaces the earlier one.
- The plan travels as a structure (capability `plan_state`): the `plan` session update carries it
  as `_meta.lembas.plan` beside ACP's flat entries (null when cleared), `_lembas/plan` carries it
  with the card, `_lembas/session/status` answers it, and a session opened from the store says
  its plan at once.
- `_lembas/session/rewind` (capability `rewind`): the web UI editing or regenerating from a turn
  takes that turn and every later one out of the conversation and the history — as `/undo`
  does, through the same store marking — without touching the files; a session a terminal runs
  is rewound there, and its transcript redrawn. A rewound turn's id is forgotten, so the web UI re-sending it runs the turn anew rather than being answered what the reverted turn said.
- Prototypes in the terminal: a completed `prototype-chat` / `prototype-page` fence in a reply
  is saved as a file — the model's output as it is, under
  `~/.local/state/lembas/prototypes/<session>/<n>-<slug>.html`, never in the project — and drawn
  as one line saying where; `/prototype` lists this session's, `/prototype <n>` prints one's
  path. The prompt offers them only when the instance says so for the chat, or with
  `prototypes: true` in the global config for a terminal session.
- The library's scope: every call to the instance's library made for a session the instance
  gave a library context carries `_meta.lembas.scope` (the session id), so the instance answers
  within that chat's bases and data group; `knowledge_search`'s `base` is read against the bases
  in scope as LLeMbas reads it — by id, then by name whatever its case, an unknown one answered
  with the bases there are (`resolveBase`).
- Conformance areas `plan` (normalise, update, todos), `toolcall_index`, `prototype` and
  `library_scope`; an area the spec has and this implementation does not answer yet is skipped by
  name rather than failed.

### Changed

- `plan_submit` presents the plan written with `plan_write`, not a file: the card shows the plan
  with its ids, and a copy still goes under `.agent/plans/<date>-<slug>.md` for the record. Its
  `path` argument is kept for callers that send it and ignored. With no plan written it says to
  call `plan_write` first.
- The system prompt is the spec's one shared text (`system/default.md`), with the CLI's facts
  filled into its variables — the opening line, the terminal as the surface, the file tools, the
  background-command and git sections, and the current plan with its ids on every step while one
  exists; the shared `blocks/library.md` and `blocks/prototypes.md` join it when their tools are
  offered. A bullet whose variable is empty is left out, and a variable left unfilled is an error
  rather than text sent to a model.
- The loop's numbers come from the spec's `loop.json` (the step backstop, how many calls run
  together, how often an empty reply is asked again), and so does the wrap-up message, which now
  names the limit reached: "The time budget for this prompt has been reached…".
- The default theme is `moria`, the LLeMbas web UI's own; `lembas` and `lembas-light` remain
  selectable. The working line is a plain braille spinner with the verb, without the faces, and
  the welcome box no longer carries the ☤ glyph.
- A tool-call fragment streamed without an index continues the call started last, not call 0,
  so a server that numbers only the first fragment of each call no longer merges two calls.
- A permission rule written for `todo` applies to `plan` (the key `plan_write` and `plan_update`
  are checked under), as `question` applies to `ask_user`.

### Removed

- The `todo` tool. `todo` is now a former name of `plan_write`: a call under it — from a stored
  session, an agent file, or a model trained on it — becomes one phase called "Work" with its
  items translated (pending → todo, in_progress → doing, completed → done, cancelled → dropped).
- The `☤` glyph and the face frames of the spinner, from the TUI.

## [1.2.0] — 2026-10-14

### Added

- `lembas remote list | add <dir>… | remove <dir>… | enable | disable | mode <m> | terminal <on|off>`
  manages the `remote:` block without editing YAML, keeping the file's comments. `add` stores each
  directory as an absolute real path, skips one already covered by a root, refuses a missing one
  (nothing is written), and turns remote work on. `--json` prints one object,
  `{"enabled", "roots", "max_mode", "terminal"}`, with the defaults applied — for a program such as
  LLeMbas Desktop.
- `lembas -l` / `lembas --local`: local mode. Config, sessions, memory, skills, the library,
  snapshots, worktrees, caches, trust and history live in the project's git-ignored
  `.agent/local/lembas/` (`.lembas/` where `.agent` is another tool's), and nothing is written
  anywhere else — not even temporary files: the TUI starts with TMPDIR there, and the TUI library's
  cache goes there too (the commands the agent runs keep your TMPDIR). Your logins and
  connections.yaml are read, never written; your config.yaml is not read. A LLeMbas instance is
  used for its models, chat, speech in and out and the balance only: no link, `/remote`, service or
  hub, no deletes sent, no server library, no search, fetch or embeddings through it, no account
  personalization, and no self-update. The instance still records each request's usage, as any API
  does. `-l` does not trust the project by itself; the first start asks, and the answer is kept in
  the local directory. A local directory the repository carries is refused, `hardline_disable` is
  ignored, and tools treat the local directory as outside the project: no tool writes there (but
  in its worktrees), and reading it asks as anything outside the project does. The status bar says
  `local`, and `lembas -l --help` explains it.

### Changed

- A running `lembas service` follows the `remote:` block without a restart: roots, mode, trust,
  terminals and `enabled` are read again whenever they are used (a stat of config.yaml; parsed only
  when it changed). When what the instance was told changes, the link is dialled again once nothing
  is working, so the web UI hears the new limits.
- `lembas service` links even before any folder is allowed; it then accepts no session until one is
  added. With remote work off or no roots it tells the instance `roots: []` and refuses every
  session, directory and terminal; before, `service run` exited at once and the instance could not
  tell "remote off" from "not running".
- Harness spec 1.0.1: `acp.md` says so.

## [1.1.0] — 2026-10-14

### Added

- `lembas login --json` prints the code to approve and the outcome as one JSON object per line,
  for a program that drives the login (LLeMbas Desktop).

## [1.0.0] — 2026-10-09

The first public release of LLeMbas CLI: a terminal coding agent and project manager for any LLM
API, with permission modes, git snapshots, memory and skills, knowledge bases, MCP, voice, and a
link to a LLeMbas instance whose web UI can work its sessions too. Signed Linux binaries for x64
and arm64.
