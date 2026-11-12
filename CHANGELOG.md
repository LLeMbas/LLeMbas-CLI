# Changelog

All notable changes to LLeMbas CLI. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

Harness spec 3.7.0: one display in every client.

### Added

- **Harness spec 3.7.0: one display everywhere** (`harness/display.md`). The spec now says how
  every client — the web UI, Desktop, the CLI, Android — shows a tool call: one short title made
  from the call's arguments (the same in the transcript, on the progress line and over the link),
  the four states running, done, failed and denied, how long a finished call took, `+added
  −removed` for an edit, and the kinds of block. A reply that was stopped or failed keeps the
  spec's line (`Stopped: by you`, `Failed: …`) on it. The approval, question and plan cards offer
  the same actions everywhere, and numbers are written in the client's locale format.
- **Harness spec 3.7.0: `python` says why it could not run.** The server's `python` tool had one
  answer for three situations; the spec now has one each — no page of the chat is open (and where
  to open it), the page did not answer, the run took too long.

### Changed

- **The terminal opened from the web UI or Desktop picks a shell that exists.** `$SHELL` when
  it is there, else bash, zsh or sh; on Windows PowerShell 7, then Windows PowerShell, then
  `cmd.exe` — started without `-l`, which none of them takes. (The runtime's pseudo-terminal is
  documented for Linux and macOS only, and there is no Windows build of the CLI yet: where a
  terminal cannot be opened, the refusal now says so in a sentence.)
- **Plainer refusals when a terminal or a folder cannot be used**: each says what to do —
  `lembas remote terminal on`, `lembas remote add <dir>`, close one of the open terminals.

## [2.0.0-beta.8] — 2026-11-10

### Added

- **Harness spec 3.6.0: phone actions.** The spec now describes `phone_action`, the LLeMbas
  server's tool for doing something on the person's phone when they write from the LLeMbas app on
  it — alarms and timers, calendar events, SMS and email drafts, the dialer, routes (start one,
  add a stop, search nearby, stop), opening an app or an address, media, the torch, settings
  panels and automations — confirmed on the phone every time (`harness/phone.md`). The server's
  alone: the CLI does not offer it, and its conformance area is the server's.

## [2.0.0-beta.7] — 2026-11-10

Harness spec 3.5.0: scheduled work on a linked computer.

### Added

- **Accept scheduled work.** A new switch, off by default: `lembas service scheduled on` (or
  `lembas remote scheduled on`; `remote.scheduled` in the global config). On, the schedules you
  make on your LLeMbas server may run on this computer as agent turns, in the folders remote work
  may use. `lembas remote list --json` says `scheduled`; the server is told at once (the link
  dials again once nothing is working).
- **Scheduled turns.** A run is an agent session in the schedule's mode — Edit unless the schedule
  says Auto, never Plan, and never beyond `remote.max_mode` — with the schedule's Subagents
  Min/Max. Its answer reports the run: `ok`, `silent` (the reply said `[SILENT]` on its first or
  last line), `failed` or `cancelled`, and the final reply. A switch turned off is a fixed refusal
  the server shows as it is.
- **Approvals in a scheduled run** go to you through the server (a notification on your phone)
  and wait the schedule's wait — 30 minutes unless it says otherwise — then count as denied, and
  the model is told so. Questions and plans have nobody to answer in a scheduled run.
- **Watch commands** (monitor mode): the server asks this computer to run a schedule's watch
  command in its folder, with a timeout, and gets back a hash of the output and a short excerpt;
  the model runs only when the output changed. A command the schedule's mode would ask about is
  refused rather than run.

- **`/schedule`**: your schedules on the LLeMbas server from the terminal — the list with each
  one's next run and last result, `new <words>` (the server works out the rule; you see what it
  understood and the next runs before anything is made, and may have it run on this computer in
  the current folder), `pause`, `resume`, `run` (now, without using up the next scheduled run) and
  `history`. It uses this computer's sign-in; a server too old to allow that says so.

- **A notice when a reply finishes** — or when the agent waits for your answer — while the
  terminal is not focused: the bell, and a desktop notification (OSC 9, in terminals that show
  one) naming the session, never what the reply says. `notify: false` (or `/settings`) turns it
  off.
- **`/rename <title>`** names this session — in `/sessions`, and in the web UI when it is shared.
- **`/search <words>`** finds a past session in this project by what was said in it (add `all`
  for every project) and resumes the one you pick.
- **`/memory` shows the server's memory** when the server keeps it (`library: lembas`): its
  entries beside this machine's files, each one to change or forget, through the server.

### Changed

- `team_add` under a sub-manager says where the report goes: "Its report goes to <sub-manager>
  when it finishes", not "comes to you".

## [2.0.0-beta.6] — 2026-11-10

Harness spec 3.4.0 (spec commits 4b8786b, b66891e): one progress vocabulary for every client, and
subagents organised as the main agent's tree.

### Added

- **Progress phases.** The line under the conversation says what the agent is doing in the words
  every LLeMbas client uses — *Queued*, *Waiting for {model}*, *Reading the prompt: n / total
  tokens (p%)*, *Thinking*, *Writing: n tok/s*, *Running {tool}: {what}*, *Waiting for you*,
  *Waiting for subagents*, *Compacting the conversation*, *Retrying in n s*, *Stopped*, *Failed* —
  with how long it has lasted, then the turn's time and tokens. The CLI keeps its own estimate of
  how long the rest of a long prompt will take. Over the link each phase is a `phase` event and is
  in the session's status (capability `progress`).
- **The main agent and its subagents.** Only the main agent adds, reassigns (`team_assign`),
  replaces (`team_replace`), stops and decides; a subagent added with `lead: true` is a
  sub-manager that directs the subagents placed under it (`parent`) and adds none. Each subagent
  has an id (`s1`, `s2`, …), a name, a position, a parent, a task, a mode and a model, and can ask
  `team_whoami`. With Min above 1 the main agent starts with Min − 1 open slots to fill.
- **Permissions only go down.** A subagent's mode is its parent's or stricter. A narrowed one may
  be given request options (read, write, execute) and ask the main agent with `team_request`; the
  main agent decides with `team_decide`, and never allows more than its own mode would. What
  nobody in the tree could allow — a `bash` call in an all-Edit tree — is put to you, on an
  approval card that names the subagent.
- **A subagent's end.** It reports and ends with `team_finish`. Its findings (`team_findings`) are
  kept after it ends. When its context fills it does not compact: it is paused, gets one last
  turn of at most 8 steps to save its findings and tell its parent, and ends; the main agent
  replaces it or uses what it found.
- **Seeing the tree.** `/team` draws every agent with its position, state, model, mode, context
  use, current phase and messages, the open slots and the subagents that ended; `/team open
  <name>` shows a subagent's session read-only, live or after it ended; `/team findings <name>`;
  `/context <name>` for a subagent's context.
- **An agent chat's subagents run on this device.** The chat's Min and Max come with every turn
  (capability `agents`) and the tree, progress, findings and transcripts go back to the server
  (capability `tree`: the `team` event with the tree, `_lembas/team`, `/transcript`, `/findings`,
  `/stop`).

### Changed

- A subagent can no longer add subagents of its own or start a `task`; it asks the main agent.
  `team_stop` is the main agent's alone.

## [2.0.0-beta.5] — 2026-11-09

Harness spec 3.3.0 (spec commit 02c7282): subagents run on your model unless you name another,
and `/context` shows where the window goes the way the side panel of the other apps does.

### Changed

- **Subagents run on the session's model**, unless you named another model in this session's own
  messages — its id, the part after its provider, or its display name, as a whole word, in any
  letter case. A `task` or `team_add` that asks for any other model is refused ("Use another
  model for subagents only when the person names it."), and an agent file's own `model:` is no
  longer used. Nothing in the settings chooses a subagent's model.
- **Only the logical capacity limits remain.** A named model on the same one-model server as the
  session's model is refused ("That model is on the same one-model server as this chat's model;
  name a model on another server."). On a model that serves one request at a time, a subagent on
  that same model is refused ("This model serves one request at a time: name another model, on
  another server, for subagents.") and nothing else is picked instead.
- **Subagents are offered** — the size setting, the team tools — when subagents are on and some
  model could serve one: the session's, when it serves two requests at once, or any model of the
  server that is not on its one-model server. When the session's model cannot serve its own
  subagents, the agent is told so in its first note, and `/effort`, `/team size` and `/team` say it
  beside the setting.
- **"Subagents" is the word** for the setting, with **Min** and **Max**: the row beside the effort
  in `/effort`, `/team size`, `/settings`. "Helper" is gone. The status bar reads
  `agents 3/4 · 2 subagents working` while there is a team.
- **The numbers count this agent**: `Subagents: Min 1, Max 4 — 1 is this agent alone`. Max 1 is
  the agent alone, with no subagents; Max 4 is the agent and up to three subagents.
- **The setting is one range with two handles.** In `/effort` and `/team size` the Subagents row
  shows `Min 1`, a track from 1 to the cap with a handle for each, and `Max 4`: ←→ move the handle in focus, tab switches to the other, enter
  sets both for the session (Min never passes Max; Max goes up to `agents.cap`). `/team size` also
  keeps the usual pairs and `<min> <max>` typed.
- **`/context`** shows the window as used tokens of the window and a percentage, one bar split by
  category, every category with its tokens and its share of the window, what is free, and how far
  it is to automatic compaction (`N until auto-compact`, with `/compact` to do it now).

## [2.0.0-beta.4] — 2026-11-09

### Fixed

- **`lembas login` no longer loops on a sign-in the server stopped accepting.** With an earlier login
  for the same server kept here (from an older install, or LLeMbas Desktop), login only refreshed it;
  when the server refused the old token it said “run login again”, and running it again did the same.
  Now a refused sign-in starts a new one, which replaces the old.
- The installer's last line says to run `lembas login`, not to edit `connections.yaml` (gone in 2.0).

## [2.0.0-beta.3] — 2026-11-09

Harness spec 3.2.0: teams, effort levels that mean what they say, the model's reasoning sent
back while it works, and no absolute paths in the prompt.

### Added

- **Teams.** Where the model serves at least two requests at once, the agent can add **members**
  (`team_add`): background agents that each own a part of the work, briefed on their own and told
  the team's goal. Once it has a member the agent **leads**: tools that change things answer that
  it should give the work to a member, while reading, reviewing and managing stay. Members and the
  lead talk in the team's **room** (`team_send`, to a name or to `all`); a member's final reply
  comes back as its report and wakes the lead if it was idle, and a message wakes a member that
  had finished. A member made with `lead: true` leads an area with members of its own.
  `team_read` shows the team and the room, `team_stop` stops a member and everything under it.
- **How many agents a team may have**: the `agents` setting (`min` 1 and `max` 4 by default, at
  most `agents.cap`, 32), changed with `/team size <min> <max>`, from the **agents** row beside the
  effort in `/effort`, or in `/settings`; the agent is told the size and every change in a note.
  `max: 1` means one agent and no helpers; `min: 2` or more makes the agent lead from the start.
  `subagents: false` switches teams off together with `task`.
- **`/team`** shows the team as a tree and the room, and stops a member (`/team stop <name>`); the
  agent is told who you stopped. The status bar shows `team 3/4 · 2 working` while there is a team.
- When every slot of the model is busy, a member (or the agent itself) **waits for a free slot**
  and starts when one frees, instead of being refused; one-off `task` helpers count toward the
  team's size.
- **A Thinking switch.** A model that can switch thinking off offers `off` as a real level: no
  thinking at all, not the model's default. `/effort` shows a list for several levels, an on/off
  switch where that is the only choice, and nothing where there is nothing to choose.

### Changed

- **The model's reasoning goes back to it during its turn**, so it carries on from what it thought
  instead of working it out again at every step; earlier turns are sent without it, as before.
- **No absolute paths in the prompt.** The agent is told the project's name and, when you started
  below its root, that directory relative to it. Relative paths in every file tool and the
  directory `bash` starts in are taken from the project root; absolute paths still work.
  Instruction files are named from the project root or as `~/…`.

## [2.0.0-beta.2] — 2026-11-07

Harness spec 3.1.0: what the model has already read stays exactly as it was, so its server
can reuse it instead of reading the whole session again.

### Changed

- **The system prompt is made once per session** — at the start, after a compaction, on a model
  switch — kept with the session and sent byte for byte on every request; a resumed session sends
  the one it kept. It holds no date any more.
- **What changes during a session is said in a note** after your words on your next message: the
  date (on the first message, and when it changes), a permission mode you chose, a plan you
  changed, memory or an instruction file you edited, a personality you picked, an MCP server's
  instructions that arrived later. The model's own changes (its plan, its edits, a plan approval)
  are not said again. Notes are not shown as your words.
- **The tool list is the same for the whole session.** `plan_submit` is offered in every mode and
  answers that it works only in plan mode; `show` is offered from the start where the session can
  have a viewer; knowledge search is decided as the session starts. The tools stay listed when a
  step limit or budget winds a prompt up (a call in that answer is not run), and a tool refused
  for good stays listed and answers that refusal. The first request waits up to 3 seconds for the
  configured MCP servers, so their tools are in the first list.
- **Compaction asks for its summary as the next turn of the same conversation** instead of a
  separate request with a pasted transcript, so it reuses what the server has read and no longer
  loses the middle of a long session. A tool call in the summary's reply is not run.

### Added

- **Cached input tokens are recorded for every request** (the usage's own count, or llama.cpp's
  `timings` and progress), kept with the session, and shown by `/context` for the last request.

## [2.0.0-beta.1] — 2026-11-03

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
- **`lembas login --token-stdin --server <url>`**: sign in with a token a program already holds —
  LLeMbas Desktop, from the one approval that gives it the agent's token beside its own. The token
  is read from stdin only, never from an argument or the environment, and checked against the
  server first: it must speak protocol 3, accept the token, and say it carries `link`. The login
  is then stored exactly as a sign-in by code (an earlier one replaced and its token signed out),
  and `--json` prints the same `done` (or `error`) line.

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
