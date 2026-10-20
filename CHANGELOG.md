# Changelog

All notable changes to LLeMbas CLI. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
