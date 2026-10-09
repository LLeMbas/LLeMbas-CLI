// `lembas kb`: knowledge bases from the shell — make one, put files, directories and pages
// into it, see what is there, search it, take things out.
import { loadConfig } from "../config/load.ts"
import { findProject, trustOf } from "../project/root.ts"
import { embedderFor } from "./embed.ts"
import { ingest } from "./ingest.ts"
import { Library, type Embedder } from "./store.ts"

export const KB_HELP = `lembas kb                          the knowledge bases
lembas kb create <name> [description]
lembas kb add <name> <file|directory|url>…
lembas kb docs <name>                what a base holds
lembas kb search <query> [--base name]
lembas kb rm <name> [document-id…]   a base (asks), or documents from it
lembas kb reindex                    embed what has no vector from the embedding model yet`

const kb = (n: number) => `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`

export async function kbCommand(args: string[]): Promise<number> {
  const lib = new Library()
  const p = findProject(process.cwd())
  const loaded = loadConfig({ projectConfigDir: p.dir, trusted: trustOf(p.root) === "trusted" })
  let embedder: Embedder | undefined
  try {
    embedder = embedderFor(loaded, loaded.config.embedding)
  } catch (e) {
    console.error(`⚠ ${(e as Error).message}`)
  }
  const [sub = "list", ...rest] = args
  const flag = (name: string) => {
    const i = rest.indexOf(name)
    if (i < 0) return undefined
    const v = rest[i + 1]
    rest.splice(i, 2)
    return v
  }
  const embed = async () => {
    if (!embedder) return
    process.stdout.write(`embedding with ${embedder.model}… `)
    try {
      console.log(`${await lib.embedAll(embedder)} pieces`)
    } catch (e) {
      console.log(`failed: ${(e as Error).message} — searching works by words until lembas kb reindex succeeds`)
    }
  }
  switch (sub) {
    case "list": {
      const all = lib.bases()
      if (!all.length) console.log("no knowledge bases yet — lembas kb create <name>, then lembas kb add <name> <files>")
      for (const b of all) console.log(`${b.name}  ${b.documents} document${b.documents === 1 ? "" : "s"}${b.description ? `  — ${b.description}` : ""}`)
      console.log(`\nsearch: ${embedder ? `words and meaning (${embedder.model})` : "words (set embedding: in config.yaml for meaning too)"}${loaded.config.knowledge ? ` · this project searches: ${loaded.config.knowledge.join(", ")}` : ""}`)
      return 0
    }
    case "create": {
      const [name, ...desc] = rest
      if (!name) return usage()
      lib.createBase(name, desc.join(" "))
      console.log(`made ${name} — lembas kb add ${name} <files, directories, urls>`)
      return 0
    }
    case "add": {
      const [name, ...inputs] = rest
      if (!name || !inputs.length) return usage()
      const added = await ingest(lib, name, inputs, {
        progress: (a) => console.log(`${a.error ? "✗" : a.changed ? "+" : "="} ${a.source}${a.error ? `  — ${a.error}` : `  ${kb(a.chars ?? 0)} chars${a.truncated ? " (cut at 120k)" : ""}${a.changed ? "" : " (unchanged)"}`}`),
      })
      console.log(`${added.filter((a) => a.changed).length} added or changed, ${added.filter((a) => !a.changed && !a.error).length} unchanged, ${added.filter((a) => a.error).length} with no text`)
      await embed()
      return 0
    }
    case "docs": {
      const [name] = rest
      if (!name || !lib.base(name)) return usage(name ? `there is no knowledge base "${name}"` : undefined)
      for (const d of lib.documents(name)) console.log(`[${d.id}] ${d.title}  ${d.error ? `✗ ${d.error}` : `${kb(d.chars)} chars${d.truncated ? " (cut)" : ""}`}${d.source !== d.title ? `  ${d.source}` : ""}`)
      return 0
    }
    case "search": {
      const base = flag("--base")
      const q = rest.join(" ")
      if (!q) return usage()
      const hits = await lib.search(q, { bases: base ? [base] : loaded.config.knowledge, embedder }).catch(() => lib.search(q, { bases: base ? [base] : loaded.config.knowledge }))
      if (!hits.length) console.log("nothing found")
      for (const h of hits) console.log(`[${h.id}] ${h.title} (${h.base})\n  ${h.snippet.replace(/\s+/g, " ").slice(0, 240)}\n`)
      return 0
    }
    case "rm": {
      const [name, ...ids] = rest.filter((a) => a !== "--yes")
      if (!name || !lib.base(name)) return usage(name ? `there is no knowledge base "${name}"` : undefined)
      if (ids.length) {
        for (const id of ids) lib.deleteDocument(Number(id))
        console.log(`removed ${ids.length} document${ids.length === 1 ? "" : "s"} from ${name}`)
        return 0
      }
      if (!args.includes("--yes")) {
        if (!process.stdin.isTTY) return usage(`removing the whole base ${name} needs --yes`)
        process.stdout.write(`remove the knowledge base ${name} and its ${lib.base(name)!.documents} documents? [y/N] `)
        const answer = await new Promise<string>((r) => process.stdin.once("data", (d) => r(d.toString().trim())))
        process.stdin.pause()
        if (!/^y/i.test(answer)) return 1
      }
      lib.deleteBase(name)
      console.log(`removed ${name}`)
      return 0
    }
    case "reindex":
      if (!embedder) return usage("no embedding model is set (embedding: in config.yaml)")
      await embed()
      return 0
  }
  return usage()
}

function usage(message?: string): number {
  if (message) console.error(`lembas kb: ${message}`)
  else console.error(KB_HELP)
  return 2
}
