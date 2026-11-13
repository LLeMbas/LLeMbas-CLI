#!/usr/bin/env bash
# The repository is public: nothing in it may name the private estate it was written on.
# The rule "everything public is current-state and estate-free", as a check that runs in CI on
# every push rather than a sentence somebody has to remember.
#
# Patterns are the kinds of thing that leak: a private domain, an internal `.lan` name, a
# container number, a private address range, a machine's name. This file is the one place that
# may spell them, and is skipped.
set -euo pipefail
cd "$(dirname "$0")/.."

patterns=(
  'houmeres'
  '\b[a-z0-9-]+\.lan\b'
  '\bCT ?2[0-9]{2}\b'
  '\b10\.0\.0\.[0-9]+'
  '\b192\.168\.[0-9]+\.[0-9]+'
  '\bgamebox\b'
  '\bthor\b'
)

# What is allowed to match, each for a reason — a line of `file:line:text` as grep prints it:
allowed=(
  # The public forge the releases are made on: the workflow that republishes them must name it.
  '^\.github/workflows/release\.yml:[0-9]+:.*git\.houmeres\.sk'
  # A theme's former name, still read from a configuration written before it was renamed.
  '^src/tui/palette\.ts:[0-9]+:export const RENAMED_THEMES'
  # Made-up private names and addresses the web tool must refuse to fetch: the test needs them.
  '^tests/web\.test\.ts:[0-9]+:.*(files\.lan|device\.lan|192\.168\.1\.10)'
)
allow="$(IFS='|'; echo "${allowed[*]}")"

found=0
for pattern in "${patterns[@]}"; do
  hits="$(git ls-files -z | grep -zv '^scripts/hygiene.sh$' | xargs -0 grep -nIEi -- "$pattern" | grep -vE -- "$allow" || true)"
  if [ -n "$hits" ]; then
    printf '%s\n' "$hits"
    echo "hygiene: the lines above match /$pattern/" >&2
    found=1
  fi
done
[ "$found" -eq 0 ] && echo "hygiene: nothing private in the tracked files"
exit "$found"
