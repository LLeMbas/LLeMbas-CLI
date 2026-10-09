// Lifted from OpenCode packages/opencode/src/permission/arity.ts (MIT, © 2025 opencode).
import SPEC from "../../harness/permission/arity.json"
// The human-meaningful prefix of a command, used to build "always allow" patterns: `git commit -m x` → `git commit`.
export function prefix(tokens: string[]) {
  // Options before the subcommand do not count ("options never count", in the table's rules): `git -C dir
  // commit` is `git commit` — and an "always" for `git -C *` would cover every git command.
  if (tokens.length > 1 && tokens.slice(1).some((t) => t.startsWith("-")) && ARITY[tokens[0]!] !== undefined && ARITY[tokens[0]!]! > 1 && tokens[1]!.startsWith("-")) return tokens
  for (let len = tokens.length; len > 0; len--) {
    const prefix = tokens.slice(0, len).join(" ")
    const arity = ARITY[prefix]
    if (arity !== undefined) return tokens.slice(0, arity)
  }
  if (tokens.length === 0) return []
  return tokens.slice(0, 1)
}

// The table is the harness spec's (harness/permission/arity.json), shared with LLeMbas. OpenCode
// generated it with a prompt; its rules: each entry maps a command prefix to how many words define
// the command, options never count, the longest matching prefix wins.
const ARITY: Record<string, number> = SPEC.arity

