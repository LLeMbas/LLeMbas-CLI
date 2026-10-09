// Files LLeMbas CLI itself writes or reads inside a project (.agent/config.yaml, tasks.md,
// decisions.md, local/MEMORY.md): a cloned repository can commit any of them as a symbolic link,
// and a write that follows one lands wherever it points. Such a file is refused.
import { lstatSync, realpathSync } from "node:fs"
import { dirname } from "node:path"

const inside = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith("/") ? dir : `${dir}/`)

/** Why `file` (in `root`) may not be used, or undefined when it is an ordinary file — or not there
 *  yet — in a directory that really is inside the root. */
export function unsafeProjectFile(file: string, root: string): string | undefined {
  try {
    const st = lstatSync(file)
    if (st.isSymbolicLink()) return `${file} is a symbolic link`
    if (!st.isFile()) return `${file} is not a regular file`
  } catch {}
  try {
    if (!inside(realpathSync(dirname(file)), realpathSync(root))) return `${dirname(file)} leads out of ${root}`
  } catch {}
  return undefined
}

export function assertProjectFile(file: string, root: string) {
  const why = unsafeProjectFile(file, root)
  if (why) throw new Error(`refused: ${why} — LLeMbas CLI does not follow links out of its own files`)
}
