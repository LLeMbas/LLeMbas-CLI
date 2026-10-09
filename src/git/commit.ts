// /commit: what to commit, a drafted message, and the commit itself. Files are always staged by
// name — never `git add -A` — so nothing the session did not touch rides along.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Client } from "../provider/types.ts"
import { git } from "./run.ts"

export interface CommitPlan {
  files: string[]
  /** true: the user had already staged these; commit exactly the index. */
  staged: boolean
}

/** The index if anything is staged; otherwise the session's changed files that git sees as changed. */
export function commitPlan(root: string, touched: string[], all = false): CommitPlan {
  const staged = git(root, ["diff", "--cached", "--name-only", "-z"]).out.split("\0").filter(Boolean)
  if (staged.length && !all) return { files: staged, staged: true }
  const status = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).out.split("\0").filter(Boolean)
  const changed = status.map((l) => l.slice(3))
  const files = all ? changed : changed.filter((f) => touched.includes(f))
  return { files, staged: false }
}

const PROMPT = `Write a git commit message for the change below.

- First line: a summary under 72 characters, imperative mood, in the style of the recent commits shown.
- Then, only if the change needs explaining, a blank line and a short body saying what changed and why — not a list of files.
- Reply with the message only: no quotes, no code fences, no preamble.

Recent commits, for style:
{{recent}}

The change:
{{diff}}`

export async function draftMessage(client: Client, root: string, plan: CommitPlan, signal?: AbortSignal): Promise<string> {
  const recent = git(root, ["log", "-10", "--format=%s"]).out || "(none yet)"
  const diff = plan.staged
    ? git(root, ["diff", "--cached", "--no-color", "--stat", "-p"]).out
    : [
        git(root, ["diff", "--no-color", "--stat", "-p", "HEAD", "--", ...plan.files]).out ||
          git(root, ["diff", "--no-color", "-p", "--", ...plan.files]).out,
        ...untrackedPreview(root, plan.files),
      ].join("\n")
  const prompt = PROMPT.replace("{{recent}}", () => recent).replace("{{diff}}", () => diff.slice(0, 24_000))
  let text = ""
  for await (const ev of client.stream({ system: "", messages: [{ role: "user", parts: [{ type: "text", text: prompt }] }], tools: [], effort: null, signal }))
    if (ev.type === "finish") text = ev.message.parts.map((p) => (p.type === "text" ? p.text : "")).join("")
  return cleanMessage(text)
}

/** New files have no diff against HEAD; show the model their first lines instead. */
function untrackedPreview(root: string, files: string[]): string[] {
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...files]).out.split("\0").filter(Boolean)
  return untracked.map((f) => {
    let head = ""
    try {
      head = readFileSync(join(root, f), "utf8").split("\n").slice(0, 40).join("\n")
    } catch {}
    return `new file ${f}:\n${head}`
  })
}

export function cleanMessage(text: string): string {
  let t = text.trim().replace(/^```\w*\n?/, "").replace(/\n?```$/, "").trim()
  t = t.replace(/^(commit message|message):\s*/i, "").replace(/^["'](.*)["']$/s, "$1")
  return t
}

export function commit(root: string, plan: CommitPlan, message: string): { ok: boolean; text: string } {
  if (!plan.staged && plan.files.length) {
    const add = git(root, ["add", "--", ...plan.files])
    if (add.code !== 0) return { ok: false, text: add.err }
  }
  const r = git(root, ["commit", "-q", "-F", "-"], { input: message })
  if (r.code !== 0) return { ok: false, text: r.err || r.out }
  const head = git(root, ["log", "-1", "--format=%h %s"]).out
  return { ok: true, text: head }
}
