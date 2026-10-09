#!/usr/bin/env bash
# The gate every change passes, here or on a runner: types, tests, the compiled binary in a PTY,
# the shell scripts, and the history for secrets. Fetches the tested Bun when there is none.
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n== %s ==\n' "$*"; }

if ! command -v bun >/dev/null 2>&1; then
  if [ -x "$HOME/.bun/bin/bun" ]; then
    PATH="$HOME/.bun/bin:$PATH"
  else
    # The version install.sh fetches, checked against the release's own SHA256SUMS.
    version="$(sed -n 's/^BUN_VERSION=//p' install.sh)"
    case "$(uname -m)" in
      x86_64) arch=x64; grep -qw avx2 /proc/cpuinfo 2>/dev/null || arch=x64-baseline ;;
      aarch64 | arm64) arch=aarch64 ;;
      *) echo "ci.sh: no Bun for $(uname -m)" >&2; exit 1 ;;
    esac
    step "Bun $version (bun-linux-$arch)"
    dir="${RUNNER_TEMP:-$(mktemp -d)}/bun-$version"
    mkdir -p "$dir"
    base="https://github.com/oven-sh/bun/releases/download/bun-v$version"
    curl -fsSL -o "$dir/bun.zip" "$base/bun-linux-$arch.zip"
    curl -fsSL -o "$dir/SHASUMS256.txt" "$base/SHASUMS256.txt"
    # The SHA-256 install.sh pins for this version, not the list downloaded beside the zip.
    want="$(sed -n "s/^BUN_SHA256_$(echo "$arch" | tr 'a-z-' 'A-Z_')=//p" install.sh)"
    [ -n "$want" ] && (cd "$dir" && echo "$want  bun.zip" | sha256sum -c --quiet -)
    unzip -q -o "$dir/bun.zip" -d "$dir"
    PATH="$dir/bun-linux-$arch:$PATH"
  fi
fi
bun --version

step "dependencies"
bun install --frozen-lockfile

step "types"
bun x tsc --noEmit  # `bun x`: the release zip CI fetches has no bunx link

step "tests"
bun test

step "the compiled binary (smoke)"
bun run smoke

step "licences of what the binary contains"
bun run licenses --check

# On a CI runner (CI set) a missing linter or scanner fails the run; by hand, it is said and skipped.
missing() {
  if [ -n "${CI:-}" ]; then echo "ci.sh: $1 is not installed on this runner" >&2; exit 1; fi
  echo "(no $1 here: $2)"
}

if command -v shellcheck >/dev/null 2>&1; then
  step "shell scripts"
  shellcheck install.sh get.sh scripts/*.sh
else
  missing shellcheck "the shell scripts were not linted"
fi

if command -v gitleaks >/dev/null 2>&1; then
  step "secrets in the history"
  gitleaks detect --source . --log-opts=--all --redact --no-banner
else
  missing gitleaks "the history was not scanned"
fi

step "all passed"
