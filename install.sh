#!/usr/bin/env bash
# Install LLeMbas CLI (the `lembas` command) for the current user.
#
#   ./install.sh [--binary PATH] [--aliases | --no-aliases] [--no-config] [--yes]
#   ./install.sh --uninstall [--purge] [--yes]
#
# - From a checkout, builds dist/lembas first, every time (a binary left from an older
#   checkout is never installed). Bun builds it: when Bun is missing, offers to fetch it into
#   ~/.bun (the release LLeMbas CLI is tested with, checked against its published SHA-256).
# - Copies the binary to ~/.local/bin/lembas.
# - Writes starter ~/.config/lembas/config.yaml and connections.yaml (0600), commented, where
#   there are none (--no-config: none at all, for a deploy that writes its own). Existing files
#   are never touched. The JSON Schemas editors check them with (~/.config/lembas/schema/)
#   are written every time, so they match the binary.
# - For bash (~/.bashrc) and zsh (${ZDOTDIR:-~}/.zshrc) — whichever exist, or the one for $SHELL
#   if neither does — writes one marked block that puts ~/.local/bin on PATH and, if wanted,
#   the alias `agent`. Re-running replaces the block; nothing is appended twice.
# - --uninstall says what it will remove and asks: the service (stopped first), the binary (and
#   the one an update kept), the editor schemas and the rc block.
#   Settings, sessions and memory stay, for a later reinstall; --purge removes them too
#   (~/.config, ~/.local/share and ~/.local/state /lembas). A project's own .agent/ is never
#   touched. `lembas uninstall` does the same.
set -euo pipefail

BIN_DIR="$HOME/.local/bin"
TARGET="$BIN_DIR/lembas"
BEGIN="# >>> lembas >>>"
END="# <<< lembas <<<"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# A relative XDG_* is ignored, as the XDG spec says (it would mean wherever this was started).
xdg() { case "${1:-}" in /*) printf '%s' "$1" ;; *) printf '%s' "$2" ;; esac; }
CONFIG="$(xdg "${XDG_CONFIG_HOME:-}" "$HOME/.config")/lembas"
# The Bun release LLeMbas CLI is built and tested with.
BUN_VERSION=1.4.2
BUN_SHA256_X64=36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913
BUN_SHA256_X64_BASELINE=c678040f14fe0440eb839d37cbd0ce4c051a32da72806ac97de6a6aab6bf728f
BUN_SHA256_AARCH64=54328bbc2d9c8e0c9f892c544d66c57a83b84139e34909e5ee81758f1ac8fda7

binary="" aliases="ask" yes=0 uninstall=0 starter=1 purge=0
while [ $# -gt 0 ]; do
  case "$1" in
    --binary) binary="$2"; shift 2 ;;
    --aliases) aliases=yes; shift ;;
    --no-aliases) aliases=no; shift ;;
    --no-config) starter=0; shift ;;
    --yes|-y) yes=1; shift ;;
    --uninstall) uninstall=1; shift ;;
    --purge) purge=1; shift ;;
    -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install.sh: unknown option $1" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }

rc_files() {
  local files=() zrc="${ZDOTDIR:-$HOME}/.zshrc"
  [ -f "$HOME/.bashrc" ] && files+=("$HOME/.bashrc")
  [ -f "$zrc" ] && files+=("$zrc")
  if [ ${#files[@]} -eq 0 ]; then
    case "${SHELL##*/}" in
      zsh) files+=("$zrc") ;;
      *) files+=("$HOME/.bashrc") ;;
    esac
  fi
  printf '%s\n' "${files[@]}"
}

# Remove our block from a file, leaving everything else byte-for-byte.
strip_block() {
  local f="$1"
  [ -f "$f" ] || return 0
  grep -qF "$BEGIN" "$f" || return 0
  # Only a whole block: with its end marker gone, everything after the start would go with it.
  if ! awk -v b="$BEGIN" -v e="$END" '$0==b{open=1;next} $0==e&&open{open=0;ok=1} END{exit !(ok && !open)}' "$f"; then
    echo "install.sh: $f has \"$BEGIN\" without its \"$END\" — left as it is; remove the block by hand" >&2
    return 1
  fi
  local tmp
  tmp="$(mktemp)"
  awk -v b="$BEGIN" -v e="$END" '$0==b{skip=1;next} $0==e{skip=0;next} !skip' "$f" >"$tmp"
  cat "$tmp" >"$f"
  rm -f "$tmp"
}

confirm() {
  [ "$yes" -eq 1 ] && return 0
  [ -t 0 ] || return 1
  local answer
  read -r -p "  $1 [Y/n] " answer
  [[ ! "$answer" =~ ^[Nn] ]]
}

if [ "$uninstall" -eq 1 ]; then
  DATA="$(xdg "${XDG_DATA_HOME:-}" "$HOME/.local/share")/lembas"
  STATE="$(xdg "${XDG_STATE_HOME:-}" "$HOME/.local/state")/lembas"
  # `lembas service` as a systemd user unit: left running with its binary gone,
  # it restart-loops on 203/EXEC every 10 s, so it is stopped, disabled and removed first.
  UNITS="$(xdg "${XDG_CONFIG_HOME:-}" "$HOME/.config")/systemd/user"
  gone=() kept=() units=()
  u=lembas.service
  if [ -e "$UNITS/$u" ]; then units+=("$u"); gone+=("$UNITS/$u (stopped and disabled first)"); fi
  for f in "$TARGET" "$TARGET.prev" "$CONFIG/schema"; do [ -e "$f" ] || [ -L "$f" ] && gone+=("$f"); done
  while IFS= read -r f; do
    [ -f "$f" ] && grep -qF "$BEGIN" "$f" && gone+=("the LLeMbas CLI block in $f")
  done < <(rc_files)
  for d in "$CONFIG" "$DATA" "$STATE"; do
    [ -e "$d" ] || continue
    if [ "$purge" -eq 1 ]; then gone+=("$d"); else kept+=("$d"); fi
  done
  if [ ${#gone[@]} -eq 0 ]; then
    say "Nothing of LLeMbas CLI's to remove here."
    exit 0
  fi
  say "This removes:"
  printf '  %s\n' "${gone[@]}"
  if [ ${#kept[@]} -gt 0 ]; then
    say "and keeps your settings, sessions and memory (--purge removes them too):"
    printf '  %s\n' "${kept[@]}"
  fi
  [ "$purge" -eq 1 ] && say "(--purge: settings, connections, memory, skills, every session and snapshot.)"
  confirm "Uninstall?" || { say "Nothing removed."; exit 1; }
  if [ ${#units[@]} -gt 0 ]; then
    for u in "${units[@]}"; do
      systemctl --user disable --now "$u" >/dev/null 2>&1 || true
      rm -f "$UNITS/$u"
    done
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
  while IFS= read -r f; do strip_block "$f"; done < <(rc_files)
  rm -rf "$TARGET" "$TARGET.prev" "$CONFIG/schema"
  [ "$purge" -eq 1 ] && rm -rf "$CONFIG" "$DATA" "$STATE"
  say "LLeMbas CLI is uninstalled. A project's own .agent/ directory is left as it is."
  exit 0
fi

# Bun, user-local, without its install script (which edits rc files): the release zip, checked
# against the release's SHASUMS256.txt.
fetch_bun() {
  local arch asset tmp base="https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION"
  case "$(uname -m)" in
    x86_64) arch=x64; grep -qw avx2 /proc/cpuinfo 2>/dev/null || arch=x64-baseline ;;
    aarch64 | arm64) arch=aarch64 ;;
    *) echo "install.sh: no Bun build for $(uname -m)" >&2; return 1 ;;
  esac
  asset="bun-linux-$arch"
  for tool in curl sha256sum unzip; do
    command -v "$tool" >/dev/null 2>&1 || { echo "install.sh: fetching Bun needs $tool (sudo apt install $tool)" >&2; return 1; }
  done
  tmp="$(mktemp -d)"
  say "  fetching Bun $BUN_VERSION ($asset)…"
  if ! curl -fsSL -o "$tmp/$asset.zip" "$base/$asset.zip" || ! curl -fsSL -o "$tmp/SHASUMS256.txt" "$base/SHASUMS256.txt"; then
    rm -rf "$tmp"
    echo "install.sh: could not download Bun" >&2
    return 1
  fi
  # Checked against the SHA-256 written here for this version, not only against the list that came
  # with the download (the same place could have changed both).
  local want
  case "$asset" in
    bun-linux-x64) want="$BUN_SHA256_X64" ;;
    bun-linux-x64-baseline) want="$BUN_SHA256_X64_BASELINE" ;;
    bun-linux-aarch64) want="$BUN_SHA256_AARCH64" ;;
  esac
  { (cd "$tmp" && grep " $asset.zip\$" SHASUMS256.txt | sha256sum -c --quiet -) && [ "$(sha256sum "$tmp/$asset.zip" | cut -d' ' -f1)" = "$want" ]; } || { rm -rf "$tmp"; echo "install.sh: Bun's checksum did not match — not installed" >&2; return 1; }
  unzip -q "$tmp/$asset.zip" -d "$tmp"
  mkdir -p "$HOME/.bun/bin"
  install -m 0755 "$tmp/$asset/bun" "$HOME/.bun/bin/bun"
  rm -rf "$tmp"
  say "  installed $HOME/.bun/bin/bun ($("$HOME/.bun/bin/bun" --version))"
}

# ── the binary ─────────────────────────────────────────────────────────────────────────────
if [ -z "$binary" ]; then
  binary="$HERE/dist/lembas"
  if [ -f "$HERE/package.json" ]; then
    bun="$(command -v bun || true)"
    [ -n "$bun" ] || { [ -x "$HOME/.bun/bin/bun" ] && bun="$HOME/.bun/bin/bun"; } || true
    if [ -z "$bun" ]; then
      say "LLeMbas CLI is built with Bun, which is not installed here."
      if confirm "Fetch Bun $BUN_VERSION into ~/.bun (checked against its published SHA-256)?"; then
        fetch_bun || exit 1
        bun="$HOME/.bun/bin/bun"
      else
        echo "install.sh: no Bun, so nothing to build. Install Bun (https://bun.sh) and run this again, or pass --binary PATH." >&2
        exit 1
      fi
    fi
    say "Building $binary…"
    log="$(mktemp)"
    if ! (cd "$HERE" && "$bun" install --frozen-lockfile && "$bun" run scripts/build.ts) >"$log" 2>&1; then
      cat "$log" >&2
      rm -f "$log"
      echo "install.sh: the build failed (output above)" >&2
      exit 1
    fi
    rm -f "$log"
  fi
fi
[ -x "$binary" ] || { echo "install.sh: no binary at $binary (build it with: bun run build)" >&2; exit 1; }
"$binary" --version >/dev/null 2>&1 || { echo "install.sh: $binary does not run" >&2; exit 1; }
mkdir -p "$BIN_DIR"
install -m 0755 "$binary" "$TARGET.new" && mv -f "$TARGET.new" "$TARGET"
say "  installed $TARGET ($("$TARGET" --version))"

# ── where the config is ────────────────────────────────────────────────────────────────────
# Asked of the binary before anything is written there: where it says is where the starter files
# go. A binary that does not know the question (a stand-in) leaves the default.
if where="$("$TARGET" __paths 2>/dev/null)"; then
  said="$(printf '%s\n' "$where" | sed -n 's/^config=//p' | head -n1)"
  case "$said" in /*) CONFIG="$said" ;; esac
fi

# ── starter config ─────────────────────────────────────────────────────────────────────────
# Only where there is none: an existing file is the user's, whatever is in it.
[ "$starter" -eq 1 ] && mkdir -p "$CONFIG"
if [ "$starter" -eq 1 ] && [ ! -e "$CONFIG/config.yaml" ]; then
  cat >"$CONFIG/config.yaml" <<'YAML'
# yaml-language-server: $schema=schema/config.schema.json
# LLeMbas CLI settings. Every key is optional; `lembas config check` validates this file.
# The full list: https://llembas.eu/docs/. An editor with a YAML language server
# completes and checks keys as you type (the first line points it at the schema).

# The model to start with, as connection/model from connections.yaml.
# model: local/qwen3

# manual (asks before changes) | edit (changes files in the project freely) | plan
mode: manual

# personality: concise   # concise | pragmatic | optimistic | funny | formal | socratic | custom
# instructions: "Answer in Slovak; I know Python well."   # how you want to be helped
# icons: plain     # one-column symbols, for a terminal font without emoji
# mouse: false     # leave the mouse to the terminal (its own selection and copy)
YAML
  say "  wrote $CONFIG/config.yaml"
fi
if [ "$starter" -eq 1 ] && [ ! -e "$CONFIG/connections.yaml" ]; then
  (umask 077 && cat >"$CONFIG/connections.yaml" <<'YAML'
# yaml-language-server: $schema=schema/connections.schema.json
# Where the models are. Global only: a project can never point LLeMbas CLI elsewhere.
# Keys are never written here in plain text: {env:VAR}, {file:~/path}, or key_cmd.
# Then set `model: <connection>/<model>` in config.yaml, and check with `lembas models`.
connections: {}
#
# connections:
#   local:                              # llama.cpp / llama-swap / vLLM / LM Studio — OpenAI-compatible
#     dialect: openai-chat
#     base_url: http://127.0.0.1:8080/v1
#     models:
#       qwen3: { context: 131072, max_output: 65536 }
#   anthropic:
#     dialect: anthropic
#     base_url: https://api.anthropic.com
#     api_key: "{env:ANTHROPIC_API_KEY}"
#     models:
#       claude-sonnet-5: { context: 200000 }
YAML
  )
  chmod 600 "$CONFIG/connections.yaml"
  say "  wrote $CONFIG/connections.yaml (0600) — add a connection there"
fi
# The schemas for editors follow the binary, so they are rewritten on every install.
"$TARGET" config schema >/dev/null && say "  wrote $CONFIG/schema/ (JSON Schemas for editors)"

# ── aliases ────────────────────────────────────────────────────────────────────────────────
# A name is free when no command, function or alias of that name exists already — checked in
# this shell and in the rc files, since an alias defined there is invisible to this script.
taken() {
  local name="$1" f
  command -v "$name" >/dev/null 2>&1 && return 0
  while IFS= read -r f; do
    [ -f "$f" ] || continue
    # Our block is left out: the alias there is the one this replaces.
    awk -v b="$BEGIN" -v e="$END" '$0==b{skip=1;next} $0==e{skip=0;next} !skip' "$f" |
      grep -Eq "^[[:space:]]*(alias[[:space:]]+${name}=|${name}[[:space:]]*\(\)|function[[:space:]]+${name}\b)" && return 0
  done < <(rc_files)
  return 1
}

want_alias() {
  local name="$1"
  if taken "$name"; then
    say "  '$name' is already a command or alias here — not adding it"
    return 1
  fi
  case "$aliases" in
    yes) return 0 ;;
    no) return 1 ;;
  esac
  [ "$yes" -eq 1 ] && return 1
  [ -t 0 ] || return 1
  local answer
  read -r -p "  Add the alias '$name' for lembas? [y/N] " answer
  [[ "$answer" =~ ^[Yy] ]]
}

extra=""
# One alias, `agent`.
if want_alias agent; then extra+="alias agent='lembas'"$'\n'; fi

# ── rc files ───────────────────────────────────────────────────────────────────────────────
block="$BEGIN
# Added by LLeMbas CLI's install.sh; re-run it to change, or ./install.sh --uninstall.
case \":\$PATH:\" in *\":\$HOME/.local/bin:\"*) ;; *) export PATH=\"\$HOME/.local/bin:\$PATH\" ;; esac
${extra}$END"

while IFS= read -r f; do
  strip_block "$f"
  [ -f "$f" ] || : >"$f"
  # Keep a blank line between the user's content and ours.
  [ -s "$f" ] && [ -n "$(tail -c 1 "$f")" ] && printf '\n' >>"$f"
  printf '%s\n' "$block" >>"$f"
  say "  updated $f"
done < <(rc_files)

# ── another `lembas` first on PATH ─────────────────────────────────────────────────────────
# A LLeMbas server installed with pip may bring a console script called `lembas` too (the server
# itself runs as `lembas-server`). Whichever comes first on PATH is what `lembas` runs, so a server
# installed into ~/.local or a venv on PATH would shadow this one. The PATH
# a new shell gets: ours first when the rc block adds it, as it is when it is already there.
eff="$PATH"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) eff="$BIN_DIR:$PATH" ;; esac
first="$(PATH="$eff"; hash -r; command -v lembas 2>/dev/null || true)"
if [ -n "$first" ] && [ "$(readlink -f "$first")" != "$(readlink -f "$TARGET")" ]; then
  what="another program"
  if head -c 300 "$first" 2>/dev/null | head -n 1 | grep -q '^#!.*python'; then
    what="a Python console script, most likely the LLeMbas server's own \`lembas\`"
  fi
  say ""
  say "⚠ $first comes before $TARGET on PATH. It is $what,"
  say "  so \`lembas\` would run it, not LLeMbas CLI. Fix: put $BIN_DIR before $(dirname "$first") in PATH,"
  say "  or remove that one (the server itself runs as lembas-server). lembas config check says it too."
fi

say ""
say "Done. Open a new shell (or: source your rc file), then run: lembas"
[ -n "$extra" ] && say "Aliases: $(printf '%s' "$extra" | sed -n "s/^alias \([a-z]*\)=.*/\1/p" | paste -sd' ')"
if [ "$starter" -eq 1 ] && [ -z "$(sed -n 's/^model: *//p' "$CONFIG/config.yaml")" ]; then
  say "Next: add a connection to $CONFIG/connections.yaml and set model: in config.yaml."
fi
