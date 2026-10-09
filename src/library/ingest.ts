// Putting things into a knowledge base: a file, every readable file under a directory (what git
// tracks, in a repository; otherwise what is not hidden or vendored), or a web page. Text and code
// as they are; HTML as markdown; a PDF through pdftotext when it is installed. LLeMbas's limits:
// 20 MB a file, 120,000 characters of text a document (the rest is cut, and said).
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs"
import { basename, extname, join, relative, resolve } from "node:path"
import { fetchPage, htmlToMarkdown } from "../search/fetch.ts"
import type { Library } from "./store.ts"

export const MAX_FILE_BYTES = 20 * 1024 * 1024
export const MAX_TEXT_CHARS = 120_000
const MAX_FILES = 5000
const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", "target", ".next", ".cache"])
const BINARY = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".zip", ".gz", ".tar", ".7z", ".so", ".dylib", ".dll", ".exe", ".bin", ".wasm", ".mp3", ".mp4", ".wav", ".ogg", ".woff", ".woff2", ".ttf", ".otf", ".db", ".sqlite", ".pyc", ".class", ".jar"])

export interface Added {
  source: string
  id?: number
  changed?: boolean
  chars?: number
  truncated?: boolean
  error?: string
}

function cap(text: string): { text: string; truncated: boolean } {
  return text.length > MAX_TEXT_CHARS ? { text: text.slice(0, MAX_TEXT_CHARS), truncated: true } : { text, truncated: false }
}

/** A file's text, or why there is none. */
export function readText(path: string): { text?: string; error?: string } {
  const size = statSync(path).size
  if (size > MAX_FILE_BYTES) return { error: `${Math.round(size / 1048576)} MB — over the 20 MB a file may be` }
  const ext = extname(path).toLowerCase()
  if (BINARY.has(ext)) return { error: "not a text file" }
  if (ext === ".pdf") {
    const r = Bun.spawnSync(["pdftotext", "-layout", "-enc", "UTF-8", path, "-"], { stdout: "pipe", stderr: "pipe", timeout: 120_000 })
    if (r.exitCode === null || r.exitCode === undefined || (r as { error?: unknown }).error) return { error: "a PDF needs pdftotext (sudo apt install poppler-utils)" }
    if (r.exitCode !== 0) return { error: `pdftotext: ${r.stderr.toString().trim().slice(0, 200) || `exit ${r.exitCode}`}` }
    const text = r.stdout.toString().trim()
    return text ? { text } : { error: "the PDF has no text layer (a scan?) — no OCR here" }
  }
  const bytes = readFileSync(path)
  if (bytes.subarray(0, 8000).includes(0)) return { error: "not a text file" }
  const raw = new TextDecoder("utf-8", { fatal: false }).decode(bytes)
  if (ext === ".html" || ext === ".htm") return { text: htmlToMarkdown(raw) }
  return { text: raw }
}

/** The files to take from a directory: git's list where it is a repository, else a walk. */
function filesUnder(dir: string): string[] {
  const git = Bun.spawnSync(["git", "-C", dir, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { stdout: "pipe", stderr: "ignore" })
  if (git.exitCode === 0) return git.stdout.toString().split("\0").filter(Boolean).slice(0, MAX_FILES).map((f) => join(dir, f))
  const out: string[] = []
  for (const f of new Bun.Glob("**/*").scanSync({ cwd: dir, dot: false, followSymlinks: false })) {
    if (f.split("/").some((p) => SKIP_DIRS.has(p))) continue
    out.push(join(dir, f))
    if (out.length >= MAX_FILES) break
  }
  return out
}

/** Add files, directories and URLs to a base. Each one says what became of it. */
export async function ingest(lib: Library, base: string, inputs: string[], o: { cwd?: string; signal?: AbortSignal; progress?: (a: Added) => void } = {}): Promise<Added[]> {
  if (!lib.base(base)) throw new Error(`there is no knowledge base "${base}" — create it first`)
  const out: Added[] = []
  const put = (source: string, title: string, r: { text?: string; error?: string }) => {
    const { text, truncated } = cap(r.text ?? "")
    const { id, changed } = lib.putDocument(base, { title, source, text, truncated, error: r.error })
    const a: Added = { source, id, changed, chars: text.length, truncated, error: r.error }
    out.push(a)
    o.progress?.(a)
  }
  for (const input of inputs) {
    if (o.signal?.aborted) break
    if (/^https?:\/\//i.test(input)) {
      try {
        // The user names it on the command line: a local address is theirs to add.
        const page = await fetchPage(input, o.signal ?? new AbortController().signal, { allowPrivate: true })
        if (page.status >= 400) put(input, input, { error: `HTTP ${page.status}` })
        else put(input, page.title || input, { text: page.text })
      } catch (e) {
        put(input, input, { error: (e as Error).message })
      }
      continue
    }
    const path = resolve(o.cwd ?? process.cwd(), input.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"))
    if (!existsSync(path)) {
      out.push({ source: path, error: "no such file or directory" })
      o.progress?.(out.at(-1)!)
      continue
    }
    if (statSync(path).isDirectory()) {
      const root = realpathSync(path)
      for (const f of filesUnder(path)) {
        if (o.signal?.aborted) break
        // A link that leads out of the directory is not part of it.
        let real: string
        try {
          if (!lstatSync(f).isFile() && !lstatSync(f).isSymbolicLink()) continue
          real = realpathSync(f)
          if (!statSync(real).isFile()) continue
        } catch {
          continue
        }
        if (real !== root && !real.startsWith(`${root}/`)) continue
        const r = readText(real)
        if (r.error === "not a text file") continue
        put(real, relative(path, f), r)
      }
      continue
    }
    put(realpathSync(path), basename(path), readText(path))
  }
  return out
}
