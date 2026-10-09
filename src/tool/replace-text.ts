// OpenCode's replacer cascade (replace.ts, kept byte-for-byte with upstream) with one fix that has
// to live outside it: with replaceAll, upstream hands the new text to String.replaceAll, which
// reads $&, $$, $` and $' in it as patterns ("$$HOME" became "$HOME"). Escaping $ for that path
// makes it literal. Upstream has the same bug (packages/opencode/src/tool/edit.ts).
import { replace as cascade } from "./replace.ts"

export function replace(content: string, oldString: string, newString: string, replaceAll = false): string {
  return cascade(content, oldString, replaceAll && oldString !== newString ? newString.replaceAll("$", "$$$$") : newString, replaceAll)
}
