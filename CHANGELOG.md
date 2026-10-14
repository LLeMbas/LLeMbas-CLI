# Changelog

All notable changes to LLeMbas CLI. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `lembas remote list | add <dir>… | remove <dir>… | enable | disable | mode <m> | terminal <on|off>`
  manages the `remote:` block without editing YAML, keeping the file's comments. `add` stores each
  directory as an absolute real path, skips one already covered by a root, refuses a missing one
  (nothing is written), and turns remote work on. `--json` prints one object,
  `{"enabled", "roots", "max_mode", "terminal"}`, with the defaults applied — for a program such as
  LLeMbas Desktop.

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
