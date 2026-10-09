// Lifted from OpenCode packages/opencode/src/util/wildcard.ts (MIT, © 2025 opencode).
// `*` matches anything (including `/` and spaces), `?` one character. A pattern ending in
// " *" also matches the bare command, so `ls *` matches both `ls` and `ls -la`.
const cache = new Map<string, RegExp>()

export function match(str: string, pattern: string): boolean {
  let re = cache.get(pattern)
  if (!re) {
    let escaped = pattern
      .replaceAll("\\", "/")
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")
    if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"
    re = new RegExp("^" + escaped + "$", "s")
    cache.set(pattern, re)
  }
  return re.test(str.replaceAll("\\", "/"))
}
