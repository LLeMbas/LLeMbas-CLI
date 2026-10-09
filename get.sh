#!/usr/bin/env bash
# LLeMbas CLI (the `lembas` command) from nothing: the newest release's binary for this machine, its SHA256SUMS checked
# against the release key's signature and the binary against SHA256SUMS, installed by the
# release's own install.sh. Running it again updates (the binary also updates itself).
#
#   curl -fsSL https://github.com/LLeMbas/LLeMbas-CLI/releases/latest/download/get.sh | bash
#   curl -fsSL <…>/get.sh | bash -s -- --aliases        # options go on to install.sh
#   curl -fsSL <…>/get.sh | bash -s -- --uninstall      # remove it (--purge: settings too)
#
# Nothing unsigned is installed unless asked for: when no release can be found or fetched, it
# stops and says so — it does not quietly build whatever the main branch holds instead.
#
# Environment:
#   LEMBAS_FORGE    where releases come from (default https://github.com); a Gitea or Forgejo
#                   (https://git.example.org) is told apart by its API
#   LEMBAS_SLUG     owner/name of the repository (default LLeMbas/LLeMbas-CLI)
#   LEMBAS_CHANNEL  stable (default) or beta: also vX.Y.Z-beta.N, whichever is newest
#   LEMBAS_REF      a release tag (v1.2.3) to install instead of the newest; or a branch (main),
#                   which is built from source
#   LEMBAS_PUBKEY   the ssh-ed25519 key SHA256SUMS.sig must be signed with (a build of your own)
#   LEMBAS_VERIFY   signature (default) or checksum: no signature asked for (an unsigned source)
#   LEMBAS_TOKEN    for a private repository on the forge
#   LEMBAS_FROM     source: clone and build instead (needs git; fetches Bun if it is missing)
#   LEMBAS_REPO     what to clone for a source build (default: the forge's <slug>.git)
#   LEMBAS_SRC      where a source build keeps the source (default ~/.local/share/lembas/src)
#   LEMBAS_API      the releases API, when it is not where the forge's name says
#
# A release needs curl, sha256sum, gzip and ssh-keygen (openssh-client). Nothing runs as root.
# Linux only: x86-64 and arm64.
set -euo pipefail

FORGE="${LEMBAS_FORGE:-https://github.com}"
FORGE="${FORGE%/}"
# The same owner/name on GitHub and on the Gitea it is made on.
SLUG="${LEMBAS_SLUG:-LLeMbas/LLeMbas-CLI}"
CHANNEL="${LEMBAS_CHANNEL:-stable}"
VERIFY="${LEMBAS_VERIFY:-signature}"
# The release key (its private half signs every release's SHA256SUMS).
PUBKEY="${LEMBAS_PUBKEY:-ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDSZO3Byow7R3ZpOH3MCvpPIga2pZBzhfX5wXfNP1cLa}"
TMP=""

# Everything is inside functions called on the last line: a download cut short runs nothing at all.
say() { printf '%s\n' "$*"; }
die() { printf 'get.sh: %s\n' "$*" >&2; exit 1; }
cleanup() { [ -z "$TMP" ] || rm -rf "$TMP"; }
trap cleanup EXIT

api_base() {
  if [ -n "${LEMBAS_API:-}" ]; then echo "${LEMBAS_API%/}"
  elif [ "$FORGE" = https://github.com ]; then echo https://api.github.com
  else echo "$FORGE/api/v1"
  fi
}

# curl with the token, when there is one (GitHub and Gitea both take Bearer). The token goes to curl
# through a file descriptor, never on its command line, where other users could read it.
get() {
  if [ -n "${LEMBAS_TOKEN:-}" ]; then curl -fsSL -H @<(printf 'Authorization: Bearer %s\n' "$LEMBAS_TOKEN") "$@"
  else curl -fsSL "$@"
  fi
}

# Piped into bash, this script's stdin is the script itself; questions are asked on the terminal.
run_installer() {
  local installer="$1"
  shift
  if [ -r /dev/tty ] && { : </dev/tty; } 2>/dev/null; then
    bash "$installer" ${1+"$@"} </dev/tty
  else
    bash "$installer" --yes ${1+"$@"}
  fi
}

# Which release binary this machine runs: x64 needs AVX2, else the baseline build.
asset_for_machine() {
  [ "$(uname -s)" = Linux ] || { echo "get.sh: LLeMbas CLI supports Linux only for now (this is $(uname -s))" >&2; return 1; }
  case "$(uname -m)" in
    x86_64) if grep -qw avx2 /proc/cpuinfo 2>/dev/null; then echo lembas-linux-x64; else echo lembas-linux-x64-baseline; fi ;;
    aarch64 | arm64) echo lembas-linux-arm64 ;;
    *) echo "get.sh: no LLeMbas CLI build for $(uname -m) (x86-64 and arm64 only)" >&2; return 1 ;;
  esac
}

# The tag to install: LEMBAS_REF when it is a tag, else the newest release tag of the channel by
# version (vX.Y.Z; for beta also vX.Y.Z-beta.N, a beta below its own release). Fails when the
# releases cannot be listed — a rate limit, a private repository without a token, no network.
release_tag() {
  local ref="${LEMBAS_REF:-}" json tags
  if [ -n "$ref" ]; then
    echo "$ref"
    return 0
  fi
  json="$(get "$(api_base)/repos/$SLUG/releases?per_page=50&limit=50")" || return 1
  tags="$(printf '%s' "$json" | tr ',' '\n' | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p')"
  if [ "$CHANNEL" = beta ]; then tags="$(printf '%s\n' "$tags" | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+(-beta\.[0-9]+)?$' || true)"
  else tags="$(printf '%s\n' "$tags" | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' || true)"
  fi
  # Sorted as versions, with a release above its own betas: v1.2.0 → 1.2.0.zz, v1.2.0-beta.3 → 1.2.0.beta.3.
  printf '%s\n' "$tags" | sed '/^$/d' | sed -E 's/^v//; s/-beta\.([0-9]+)$/.beta.\1/; /beta/!s/$/.zz/' | sort -V | tail -n1 |
    sed -E 's/\.zz$//; s/\.beta\.([0-9]+)$/-beta.\1/; s/^/v/'
}

# SHA256SUMS signed by the release key, checked with ssh-keygen; and it names the version it is for.
check_signature() {
  local dir="$1" tag="$2"
  if [ "$VERIFY" = checksum ]; then
    say "  (LEMBAS_VERIFY=checksum: the release's signature is not checked)"
  else
    command -v ssh-keygen >/dev/null 2>&1 || {
      echo "get.sh: ssh-keygen is not installed, so the release's signature cannot be checked — nothing installed." >&2
      echo "get.sh: install openssh-client (sudo apt install openssh-client), or set LEMBAS_VERIFY=checksum to trust the checksums alone." >&2
      return 1
    }
    [ -s "$dir/SHA256SUMS.sig" ] || { echo "get.sh: the release is not signed (no SHA256SUMS.sig) — nothing installed (LEMBAS_VERIFY=checksum to accept that)" >&2; return 1; }
    # Signed in the namespace lembas-release.
    printf 'lembas-release %s\n' "$PUBKEY" >"$dir/allowed"
    if ! ssh-keygen -Y verify -f "$dir/allowed" -I lembas-release -n lembas-release -s "$dir/SHA256SUMS.sig" <"$dir/SHA256SUMS" >/dev/null 2>&1; then
      echo "get.sh: SHA256SUMS is not signed by the release key — nothing installed" >&2
      return 1
    fi
    say "  signature good (release key)"
  fi
  # The signed list says which version it is for: an old release's files under a new tag are refused.
  local version
  version="$(sed -n -E 's/^# lembas (.*)$/\1/p' "$dir/SHA256SUMS" | head -n1)"
  if [ -n "$version" ] && [ "v$version" != "$tag" ]; then
    echo "get.sh: release $tag carries the files of $version — nothing installed" >&2
    return 1
  fi
}

# Fetch a release's SHA256SUMS (+ signature) and the named files into $TMP, and check them all.
fetch_checked() {
  local tag="$1" f base
  shift
  base="$FORGE/$SLUG/releases/download/$tag"
  for f in "$@" SHA256SUMS; do
    get -o "$TMP/$f" "$base/$f" || { echo "get.sh: could not download $f from release $tag" >&2; return 1; }
  done
  get -o "$TMP/SHA256SUMS.sig" "$base/SHA256SUMS.sig" 2>/dev/null || rm -f "$TMP/SHA256SUMS.sig"
  check_signature "$TMP" "$tag" || return 1
  # Every file must be listed exactly once, and match.
  for f in "$@"; do
    [ "$(grep -c "  $f\$" "$TMP/SHA256SUMS")" = 1 ] || { echo "get.sh: SHA256SUMS does not list $f once — nothing installed" >&2; return 1; }
    (cd "$TMP" && grep "  $f\$" SHA256SUMS | sha256sum -c --quiet - >/dev/null 2>&1) || { echo "get.sh: checksums did not match — nothing installed" >&2; return 1; }
  done
}

from_release() {
  local tag="$1" asset said
  shift
  asset="$(asset_for_machine)" || exit 1
  for tool in curl sha256sum gzip; do
    command -v "$tool" >/dev/null 2>&1 || die "needs $tool (sudo apt install $tool)"
  done
  TMP="$(mktemp -d)"
  say "LLeMbas CLI $tag ($asset)…"
  fetch_checked "$tag" "$asset.gz" install.sh || exit 1
  gzip -dc "$TMP/$asset.gz" >"$TMP/lembas"
  chmod 755 "$TMP/lembas"
  # And the binary is the version the tag says.
  said="$("$TMP/lembas" --version 2>/dev/null || true)"
  [ "v$said" = "$tag" ] || die "release $tag's binary says it is ${said:-nothing} — nothing installed"
  run_installer "$TMP/install.sh" --binary "$TMP/lembas" ${1+"$@"} || exit 1
}

# Where the binary keeps its data, as it works it out: under LEMBAS_HOME (tests), else
# XDG_DATA_HOME when it is absolute (the XDG spec ignores a relative one), else ~/.local/share.
data_parent() {
  local root="${LEMBAS_HOME:-}"
  if [ -n "$root" ]; then printf '%s/share' "$root"
  else case "${XDG_DATA_HOME:-}" in /*) printf '%s' "$XDG_DATA_HOME" ;; *) printf '%s/.local/share' "$HOME" ;; esac
  fi
}

from_source() {
  local repo="${LEMBAS_REPO:-$FORGE/$SLUG.git}"
  local ref="${LEMBAS_REF:-main}"
  local src="${LEMBAS_SRC:-$(data_parent)/lembas/src}"

  command -v git >/dev/null 2>&1 || die "needs git (sudo apt install git)"

  if [ -d "$src/.git" ]; then
    say "Updating $src ($ref)…"
    # Only ever fast-forwards: local changes in the source are the user's, and are not discarded.
    git -C "$src" fetch --quiet --tags origin "$ref"
    git -C "$src" checkout --quiet "$ref" 2>/dev/null || git -C "$src" checkout --quiet -B "$ref" "origin/$ref"
    git -C "$src" merge --quiet --ff-only FETCH_HEAD || die "$src has changes of its own; update it by hand"
  elif [ -e "$src" ] && [ -n "$(ls -A "$src" 2>/dev/null)" ]; then
    die "$src exists and is not a git checkout; set LEMBAS_SRC to somewhere else"
  else
    say "Cloning $repo ($ref) into $src…"
    mkdir -p "$(dirname "$src")"
    git clone --quiet --branch "$ref" "$repo" "$src"
  fi
  run_installer "$src/install.sh" ${1+"$@"}
}

# --uninstall: the installed binary does it; without one, the newest release's install.sh — checked
# like any release file, since it is what removes things.
uninstall() {
  local bin="$HOME/.local/bin/lembas" args=() a tag
  for a in "$@"; do [ "$a" = --uninstall ] || args+=("$a"); done
  if [ -x "$bin" ] && "$bin" --version >/dev/null 2>&1; then
    if [ -r /dev/tty ] && { : </dev/tty; } 2>/dev/null; then "$bin" uninstall ${args[@]+"${args[@]}"} </dev/tty; else "$bin" uninstall --yes ${args[@]+"${args[@]}"}; fi
    return
  fi
  if ! tag="$(release_tag)" || [ -z "$tag" ]; then die "no lembas binary here, and no release to fetch install.sh from"; fi
  TMP="$(mktemp -d)"
  fetch_checked "$tag" install.sh || exit 1
  run_installer "$TMP/install.sh" --uninstall ${args[@]+"${args[@]}"}
}

main() {
  local a tag
  for a in "$@"; do [ "$a" = --uninstall ] && { uninstall "$@"; return; }; done
  # A source build only when asked for: LEMBAS_FROM=source, or a branch in LEMBAS_REF.
  if [ "${LEMBAS_FROM:-}" = source ] || { [ -n "${LEMBAS_REF:-}" ] && ! [[ "$LEMBAS_REF" =~ ^v[0-9] ]]; }; then
    from_source "$@"
    return
  fi
  tag="$(release_tag)" || die "could not list the releases at $FORGE/$SLUG (rate limit, network, or a private repository without LEMBAS_TOKEN) — nothing installed. LEMBAS_FROM=source builds from source instead."
  [ -n "$tag" ] || die "no $CHANNEL release at $FORGE/$SLUG — nothing installed. LEMBAS_FROM=source builds from source instead."
  from_release "$tag" "$@"
}

main "$@"
