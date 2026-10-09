import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { paths } from "../config/paths.ts"

// Prompt history, shared across projects, newest last: ~/.local/state/lembas/history.jsonl.
const MAX = 500

export class History {
  private items: string[] = []
  private pos = -1
  private draft = ""

  constructor(private file = join(paths.state, "history.jsonl")) {
    try {
      this.items = readFileSync(this.file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as string)
        .slice(-MAX)
    } catch {}
  }

  add(text: string) {
    if (!text.trim() || this.items[this.items.length - 1] === text) return this.reset()
    this.items.push(text)
    try {
      mkdirSync(paths.state, { recursive: true })
      appendFileSync(this.file, JSON.stringify(text) + "\n")
    } catch {}
    this.reset()
  }

  reset() {
    this.pos = -1
    this.draft = ""
  }

  /** Where it is, to come back to (a wheel burst undoing what its first arrow did). */
  mark(): { pos: number; draft: string } {
    return { pos: this.pos, draft: this.draft }
  }

  restore(m: { pos: number; draft: string }) {
    this.pos = m.pos
    this.draft = m.draft
  }

  /** -1 = older, +1 = newer. Returns the text to show, or undefined when there is nowhere to go. */
  move(dir: -1 | 1, current: string): string | undefined {
    if (this.pos === -1) {
      if (dir === 1) return undefined
      this.draft = current
      this.pos = this.items.length
    }
    const next = this.pos + dir
    if (next < 0) return undefined
    if (next >= this.items.length) {
      this.pos = -1
      return this.draft
    }
    this.pos = next
    return this.items[next]
  }
}
