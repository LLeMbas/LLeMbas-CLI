// Session-aware, situation-aware autocomplete context gathering with stable KV-cache ordering.
//
// Gathers ONLY what is needed for the cursor's current situation:
//   - Inside a comment -> no external context (fast, zero wasted tokens).
//   - On an import/include/require line -> compact workspace file list from the warmed FileIndex.
//   - Member access (`foo.`) or general code -> resolves local imports and referenced identifiers
//     from cached file summaries (preferring unsaved open buffers sent by the editor), returning
//     compact declarations/excerpts in a deterministic session order so KV-cache prefill hits
//     stay warm across keystrokes.
import { readFileSync, statSync } from "node:fs"
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path"
import type { FileIndex } from "../project/files.ts"

export interface ContextChunk {
  path: string
  text: string
}

export interface OpenSnippet {
  path: string
  text: string
}

export type Situation = "comment" | "import" | "member" | "code"

export interface SituationInfo {
  kind: Situation
  receiver?: string
  partialImport?: string
  identifiers: string[]
}

const MAX_CHUNKS = 6
const MAX_TOTAL_BYTES = 24 * 1024
const MAX_CHUNK_BYTES = 5 * 1024
const MAX_READ_BYTES = 128 * 1024
const SUMMARY_MAX_LINES = 80
const MAX_CACHED_FILES = 300

const CODE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".pyi", ".rs", ".go", ".lua", ".c", ".h", ".cc", ".cpp", ".hpp",
  ".java", ".kt", ".cs", ".rb", ".php", ".swift", ".sh", ".bash", ".zsh",
  ".css", ".scss", ".html", ".json", ".yaml", ".yml", ".toml", ".sql",
])

const KEYWORDS = new Set([
  "if", "else", "for", "while", "return", "const", "let", "var", "function", "class",
  "import", "from", "export", "default", "async", "await", "try", "catch", "finally",
  "throw", "new", "this", "super", "true", "false", "null", "undefined", "void",
  "def", "self", "None", "True", "False", "and", "or", "not", "in", "is", "as", "with",
  "pub", "fn", "struct", "enum", "impl", "trait", "mod", "use", "match", "mut", "ref",
  "local", "end", "then", "elseif", "do", "repeat", "until", "nil", "type", "interface",
  "string", "number", "boolean", "object", "any", "unknown", "never", "int", "str", "bool",
  "float", "list", "dict", "set", "tuple", "print", "console", "len", "range", "error",
])

interface CachedFile {
  mtimeMs: number
  size: number
  summary: string
  symbols: Set<string>
}

const bytes = (s: string) => Buffer.byteLength(s, "utf8")

function clipBytes(text: string, max: number): string {
  if (bytes(text) <= max) return text
  const b = Buffer.from(text, "utf8")
  let at = max
  while (at > 0 && (b[at]! & 0xc0) === 0x80) at--
  return b.subarray(0, at).toString("utf8")
}

/** Analyze the immediate cursor context to decide what external data is actually needed. */
export function analyzeSituation(prefix: string, suffix: string, language?: string): SituationInfo {
  const nl = prefix.lastIndexOf("\n")
  const rawLine = nl >= 0 ? prefix.slice(nl + 1) : prefix
  const currentLine = rawLine.length > 300 ? rawLine.slice(-300) : rawLine
  const trimmed = rawLine.trimStart().slice(0, 300)

  // 1. Inside a line comment -> no external file context needed.
  if (
    trimmed.startsWith("//") ||
    trimmed.startsWith("# ") ||
    trimmed === "#" ||
    trimmed.startsWith("--") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("* ")
  ) {
    // Exception: C/C++ #include or Python `#` is comment unless #include.
    if (!/^#\s*include\b/.test(trimmed)) {
      return { kind: "comment", identifiers: [] }
    }
  }
  // Unclosed block comment check in recent tail.
  const tail = prefix.slice(-1500)
  const lastOpen = tail.lastIndexOf("/*")
  const lastClose = tail.lastIndexOf("*/")
  if (lastOpen >= 0 && lastOpen > lastClose) {
    return { kind: "comment", identifiers: [] }
  }

  // 2. Import / include / require / use line -> needs workspace file paths, not file bodies.
  const importMatch =
    rawLine.length <= 300
      ? /(?:^|\s)(?:import\b.*?\bfrom\s+["']([^"']*)|import\s+["']([^"']*)|require\(\s*["']([^"']*)|from\s+([A-Za-z0-9_./]*)|^import\s+([A-Za-z0-9_.,\s]*)|use\s+([A-Za-z0-9_:]*)|#\s*include\s+["<]([^">]*))$/.exec(
          trimmed,
        )
      : null
  if (importMatch) {
    const partial = (importMatch.slice(1).find((g) => g !== undefined) ?? "").trim()
    return { kind: "import", partialImport: partial, identifiers: [] }
  }

  // Collect nearby identifiers from the bounded window around the cursor.
  const recentPrefix = prefix.slice(-2000).split("\n").slice(-15).join("\n")
  const recentSuffix = suffix.slice(0, 600).split("\n").slice(0, 5).join("\n")
  const recent = recentPrefix + "\n" + recentSuffix
  const idSet = new Set<string>()
  for (const m of recent.matchAll(/\b([A-Za-z_][A-Za-z0-9_]{2,64})\b/g)) {
    const id = m[1]!
    if (!KEYWORDS.has(id)) idSet.add(id)
  }

  // 3. Member access (`receiver.` / `receiver::` / `receiver->`)
  const memberMatch = /\b([A-Za-z_][A-Za-z0-9_]{0,64})\s*(?:\.|::|->)\s*[A-Za-z0-9_]{0,64}$/.exec(currentLine)
  if (memberMatch) {
    const receiver = memberMatch[1]!
    if (!KEYWORDS.has(receiver)) idSet.add(receiver)
    return { kind: "member", receiver, identifiers: [...idSet].slice(0, 40) }
  }

  void language
  return { kind: "code", identifiers: [...idSet].slice(0, 40) }
}

/** Extract local import specifiers from a source file's text. */
export function extractImports(text: string): string[] {
  const out = new Set<string>()
  // JS/TS: import ... from "...", export ... from "...", require("...")
  for (const m of text.matchAll(/(?:from|import)\s+["']([^"'\n]+)["']|require\(\s*["']([^"'\n]+)["']\s*\)/g)) {
    const spec = (m[1] ?? m[2] ?? "").trim()
    if (spec) out.add(spec)
  }
  // Python: from foo.bar import ..., import foo.bar
  for (const m of text.matchAll(/^\s*from\s+(\.{0,3}[A-Za-z0-9_.]+)\s+import\b|^\s*import\s+([A-Za-z0-9_.]+)/gm)) {
    const spec = (m[1] ?? m[2] ?? "").trim()
    if (spec) out.add(spec)
  }
  // Rust: use crate::foo::bar, mod foo;
  for (const m of text.matchAll(/^\s*use\s+(?:crate|super|self)::([A-Za-z0-9_:]+)|^\s*(?:pub\s+)?mod\s+([A-Za-z0-9_]+)\s*;/gm)) {
    const spec = (m[1] ?? m[2] ?? "").trim()
    if (spec) out.add(spec)
  }
  // C/C++: #include "foo.h"
  for (const m of text.matchAll(/^\s*#\s*include\s+"([^"\n]+)"/gm)) {
    const spec = m[1]!.trim()
    if (spec) out.add(spec)
  }
  return [...out].slice(0, 40)
}

/** Extract compact declarations/signatures and symbol names from a source file. */
export function summarizeSource(text: string): { summary: string; symbols: Set<string> } {
  const lines = text.split("\n")
  const symbols = new Set<string>()
  const picked: string[] = []
  const declRe =
    /^(?:(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var|def|fn|pub\s+(?:async\s+)?(?:fn|struct|enum|trait|type|const)|struct|impl|trait|local\s+function|function\s+[A-Za-z0-9_.:]+|func)\b|\s{1,4}(?:async\s+)?(?:def|fn|pub\s+(?:async\s+)?fn|function)\b)/
  const symRe =
    /\b(?:function|class|interface|type|enum|const|let|var|def|fn|struct|trait|func)\s+([A-Za-z_][A-Za-z0-9_]*)/

  if (lines.length <= SUMMARY_MAX_LINES && bytes(text) <= MAX_CHUNK_BYTES) {
    for (const line of lines) {
      const sm = symRe.exec(line)
      if (sm && !KEYWORDS.has(sm[1]!)) symbols.add(sm[1]!)
    }
    return { summary: text, symbols }
  }

  for (let i = 0; i < lines.length && picked.length < SUMMARY_MAX_LINES; i++) {
    const line = lines[i]!
    const sm = symRe.exec(line)
    if (sm && !KEYWORDS.has(sm[1]!)) symbols.add(sm[1]!)
    if (declRe.test(line)) {
      // Include a 1-line doc comment above if present.
      const prev = i > 0 ? lines[i - 1]!.trim() : ""
      if (
        (prev.startsWith("/**") || prev.startsWith("///") || prev.startsWith("--- ") || prev.startsWith("# ")) &&
        picked[picked.length - 1] !== lines[i - 1]
      ) {
        picked.push(lines[i - 1]!)
      }
      picked.push(line)
      // For interfaces/structs/type blocks, include up to 8 member lines.
      if (/\b(?:interface|struct|enum|type)\b/.test(line) && line.includes("{") && !line.includes("}")) {
        for (let k = 1; k <= 8 && i + k < lines.length && picked.length < SUMMARY_MAX_LINES; k++) {
          picked.push(lines[i + k]!)
          if (lines[i + k]!.includes("}")) break
        }
      }
    }
  }

  const body = picked.length ? picked.join("\n") : lines.slice(0, 40).join("\n")
  return { summary: clipBytes(body, MAX_CHUNK_BYTES), symbols }
}

/** Resolve an import specifier to a relative project path in `allFiles`. */
function resolveImport(spec: string, currentRel: string, fileSet: Set<string>, allFiles: readonly string[]): string | undefined {
  const dir = currentRel ? dirname(currentRel).replace(/^\.$/, "") : ""
  const candidates: string[] = []

  const addWithExts = (base: string) => {
    const clean = base.replace(/^\.\//, "").replace(/\/+/g, "/")
    candidates.push(clean)
    if (!extname(clean)) {
      for (const ext of [".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".lua", ".go", ".h", ".hpp"]) {
        candidates.push(clean + ext)
      }
      for (const idx of ["/index.ts", "/index.js", "/__init__.py", "/mod.rs", "/init.lua"]) {
        candidates.push(clean + idx)
      }
    }
  }

  if (spec.startsWith("./") || spec.startsWith("../")) {
    const joined = dir ? join(dir, spec) : spec
    addWithExts(joined.replace(/\\/g, "/"))
  } else if (spec.includes("::")) {
    // Rust crate::a::b -> src/a/b.rs or src/a.rs
    const parts = spec.split("::").filter(Boolean)
    if (parts.length) {
      addWithExts("src/" + parts.join("/"))
      if (parts.length > 1) addWithExts("src/" + parts.slice(0, -1).join("/"))
    }
  } else if (spec.startsWith(".")) {
    // Python relative import `.foo` / `..bar`
    const dots = /^\.+/.exec(spec)![0].length
    const rest = spec.slice(dots).replace(/\./g, "/")
    let baseDir = dir
    for (let i = 1; i < dots; i++) baseDir = dirname(baseDir).replace(/^\.$/, "")
    addWithExts(baseDir ? (rest ? `${baseDir}/${rest}` : baseDir) : rest)
  } else {
    // Dotted Python/Lua module or workspace-root path (`lembas.services.foo` or `llembas.chat`)
    const slash = spec.replace(/\./g, "/")
    addWithExts(slash)
    addWithExts("src/" + slash)
    if (dir) addWithExts(`${dir}/${slash}`)
  }

  for (const c of candidates) {
    if (fileSet.has(c)) return c
  }
  // Tail match for unique module suffix (e.g. `llembas/chat.lua` in `nvim/lua/llembas/chat.lua`).
  const tailSlash = "/" + spec.replace(/\./g, "/")
  for (const f of allFiles) {
    const noExt = f.replace(/\.[^/.]+$/, "")
    if (noExt.endsWith(tailSlash)) return f
  }
  return undefined
}

/** Session-scoped cache & selective context gatherer for autocomplete. */
export class CompletionContext {
  private files = new Map<string, CachedFile>()
  /** Stable order in which context files were introduced per workspace (keeps KV-cache prefix stable). */
  private order = new Map<string, string[]>()

  constructor(private indexFor: (root: string) => FileIndex) {}

  private relOf(root: string, filePath?: string): string {
    if (!filePath) return ""
    if (!isAbsolute(filePath)) return filePath.replace(/\\/g, "/")
    const rel = relative(root, resolve(filePath)).replace(/\\/g, "/")
    return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : ""
  }

  private readCached(root: string, rel: string): CachedFile | undefined {
    const abs = join(root, rel)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(abs)
    } catch {
      return undefined
    }
    if (!st.isFile() || st.size === 0 || st.size > MAX_READ_BYTES) return undefined
    const prev = this.files.get(abs)
    if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) return prev
    let text: string
    try {
      text = readFileSync(abs, "utf8")
    } catch {
      return undefined
    }
    if (text.includes("\0")) return undefined
    const entry: CachedFile = { mtimeMs: st.mtimeMs, size: st.size, ...summarizeSource(text) }
    this.files.set(abs, entry)
    if (this.files.size > MAX_CACHED_FILES) {
      const oldest = this.files.keys().next().value
      if (oldest) this.files.delete(oldest)
    }
    return entry
  }

  private rankInOrder(root: string, rel: string): number {
    let list = this.order.get(root)
    if (!list) {
      list = []
      this.order.set(root, list)
    }
    let idx = list.indexOf(rel)
    if (idx < 0) {
      idx = list.length
      list.push(rel)
      if (list.length > 200) list.shift()
    }
    return idx
  }

  /** Pre-warm the file index and direct imports for a file in `root` so the first completion is prefilled. */
  warm(root: string, filePath?: string, text?: string): void {
    const idx = this.indexFor(root)
    const allFiles = idx.allFiles()
    const fileSet = new Set(allFiles)
    const currentRel = this.relOf(root, filePath)
    if (!currentRel) return
    let source = text
    if (source === undefined) {
      try {
        const abs = isAbsolute(filePath!) ? filePath! : join(root, currentRel)
        const st = statSync(abs)
        if (st.isFile() && st.size <= MAX_READ_BYTES) source = readFileSync(abs, "utf8")
      } catch {
        return
      }
    }
    if (!source) return
    for (const spec of extractImports(source).slice(0, 12)) {
      const target = resolveImport(spec, currentRel, fileSet, allFiles)
      if (target && target !== currentRel) {
        this.readCached(root, target)
        this.rankInOrder(root, target)
      }
    }
  }

  /** Gather only the context needed for the cursor's current situation, in a stable session order. */
  gather(o: {
    root?: string
    path?: string
    language?: string
    prefix: string
    suffix: string
    open?: OpenSnippet[]
    clientContext?: ContextChunk[]
  }): ContextChunk[] {
    const sit = analyzeSituation(o.prefix, o.suffix, o.language)
    const clientChunks = (o.clientContext ?? []).filter((c) => c && c.path && c.text)

    // Comments need no external project context.
    if (sit.kind === "comment") return clientChunks.slice(0, MAX_CHUNKS)

    if (!o.root) return clientChunks.slice(0, MAX_CHUNKS)

    const idx = this.indexFor(o.root)
    const allFiles = idx.allFiles()

    // Import line: return a compact list of matching project paths from the file index.
    if (sit.kind === "import") {
      const query = (sit.partialImport ?? "").replace(/^\.+\//, "").replace(/\./g, "/")
      const matches = query ? idx.search(query, 30) : allFiles.slice(0, 40)
      const list = matches.filter((f) => !f.endsWith("/")).slice(0, 30)
      if (!list.length) return clientChunks.slice(0, MAX_CHUNKS)
      return [
        ...clientChunks,
        { path: "<workspace-files>", text: list.join("\n") },
      ].slice(0, MAX_CHUNKS)
    }

    const fileSet = new Set(allFiles)
    const currentRel = this.relOf(o.root, o.path)
    const openMap = new Map<string, { rel: string; summary: string; symbols: Set<string> }>()
    for (const s of o.open ?? []) {
      if (!s?.path || !s.text) continue
      const rel = this.relOf(o.root, s.path) || s.path
      if (rel === currentRel) continue
      const parsed = summarizeSource(s.text)
      openMap.set(rel, { rel, ...parsed })
    }

    const scores = new Map<string, { score: number; text: string }>()
    const idSet = new Set(sit.identifiers)
    const imports = extractImports(o.prefix + "\n" + o.suffix)

    // 1. Directly imported local files (highest relevance).
    for (const spec of imports) {
      const target = resolveImport(spec, currentRel, fileSet, allFiles)
      if (!target || target === currentRel) continue
      const openHit = openMap.get(target)
      const entry = openHit ?? this.readCached(o.root, target)
      if (!entry) continue
      let overlap = 0
      for (const sym of entry.symbols) {
        if (sit.receiver && sym === sit.receiver) overlap += 5
        else if (idSet.has(sym)) overlap += 2
      }
      const prev = scores.get(target)
      const score = 10 + overlap
      if (!prev || score > prev.score) scores.set(target, { score, text: entry.summary })
    }

    // 2. Open editor buffers that share symbols referenced near the cursor (unsaved text included!).
    for (const [rel, entry] of openMap) {
      if (scores.has(rel)) continue
      let overlap = 0
      for (const sym of entry.symbols) {
        if (sit.receiver && sym === sit.receiver) overlap += 5
        else if (idSet.has(sym)) overlap += 2
      }
      if (overlap > 0) {
        scores.set(rel, { score: 4 + overlap, text: entry.summary })
      }
    }

    // 3. If still very sparse and we have specific symbols, check same-directory sibling code files.
    if (scores.size < 2 && currentRel && idSet.size > 0) {
      const currentDir = dirname(currentRel).replace(/^\.$/, "")
      const currentExt = extname(currentRel)
      let checked = 0
      for (const f of allFiles) {
        if (checked >= 8) break
        if (f === currentRel || scores.has(f)) continue
        if (dirname(f).replace(/^\.$/, "") !== currentDir) continue
        const ext = extname(f)
        if (!CODE_EXTS.has(ext) || (currentExt && ext !== currentExt)) continue
        checked++
        const entry = this.readCached(o.root, f)
        if (!entry) continue
        let overlap = 0
        for (const sym of entry.symbols) {
          if (sit.receiver && sym === sit.receiver) overlap += 5
          else if (idSet.has(sym)) overlap += 2
        }
        if (overlap > 0) {
          scores.set(f, { score: 2 + overlap, text: entry.summary })
        }
      }
    }

    // Pick top-K candidates by relevance, then sort by STABLE session order so the KV cache stays hot!
    const top = [...scores.entries()]
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, MAX_CHUNKS)
    for (const [rel] of top) this.rankInOrder(o.root, rel)
    top.sort((a, b) => this.rankInOrder(o.root!, a[0]) - this.rankInOrder(o.root!, b[0]))

    const seenPaths = new Set<string>()
    const result: ContextChunk[] = []
    let total = 0

    const push = (path: string, text: string) => {
      if (!path || !text || seenPaths.has(path) || result.length >= MAX_CHUNKS) return
      const clipped = clipBytes(text, MAX_CHUNK_BYTES)
      const cost = bytes(clipped)
      if (total + cost > MAX_TOTAL_BYTES) return
      seenPaths.add(path)
      total += cost
      result.push({ path, text: clipped })
    }

    // Client-supplied explicit context first (e.g., pinned/unsaved), then gathered session context.
    for (const c of clientChunks) push(c.path, c.text)
    for (const [rel, item] of top) push(rel, item.text)
    return result
  }
}
