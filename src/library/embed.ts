// Embeddings for the library: `embedding: connection/model` in config.yaml, over the connection's
// OpenAI-shaped /embeddings (llama.cpp with --embedding, vLLM, LM Studio, OpenAI…) or Ollama's
// /api/embed. Vectors are made unit length here, so a dot product is the cosine.
import { resolveKey, type Loaded } from "../config/load.ts"
import { authHeaders, joinUrl, request, tlsFor } from "../provider/http.ts"
import { resolveModel } from "../provider/index.ts"
import type { Embedder } from "./store.ts"

function unit(v: number[]): Float32Array {
  let n = 0
  for (const x of v) n += x * x
  n = Math.sqrt(n) || 1
  return Float32Array.from(v, (x) => x / n)
}

export function embedderFor(loaded: Loaded, ref: string | undefined): Embedder | undefined {
  if (!ref) return undefined
  // Through the same resolver as every model ref: an instance's model by its provider
  // (`llama/nomic-embed`) or in the older form (`example/nomic-embed`). The name stored with the
  // vectors stays the ref as written, so a library indexed under it is still found.
  // An embedding model need not be listed on its connection (`connection/<any id>`, as before).
  let name: string
  let id: string
  try {
    const resolved = resolveModel(loaded, ref)
    name = resolved.connectionName
    id = resolved.id
  } catch (e) {
    // An instance's embedding model by its served id (`llama/nomic-embed`): not a
    // model ref, since only chat models are (lembas/webui.ts, isChatModel), so found by the ids
    // its connection says it serves.
    const served = Object.entries(loaded.connections).find(([, c]) => (c as { webui?: { embeddings?: string[] } }).webui?.embeddings?.includes(ref))
    const slash = ref.indexOf("/")
    if (served) {
      name = served[0]
      id = ref
    } else {
      if (slash <= 0) throw new Error(`embedding: "${ref}" must be written connection/model`)
      name = ref.slice(0, slash)
      id = ref.slice(slash + 1)
      if (!loaded.connections[name]) throw new Error(`embedding: ${(e as Error).message}`)
    }
  }
  const c = loaded.connections[name]!
  if (c.dialect === "anthropic" || c.dialect === "gemini") throw new Error(`embedding: the ${c.dialect} dialect has no embeddings here; use an OpenAI-compatible or Ollama connection`)
  const ollama = c.dialect === "ollama"
  return {
    model: ref,
    async embed(texts, signal) {
      const res = await request(
        joinUrl(c.base_url, ollama ? "api/embed" : "embeddings"),
        { method: "POST", headers: authHeaders(c, resolveKey(name, c)), body: JSON.stringify({ model: id, input: texts }), signal, timeoutMs: (c.timeout ?? 120) * 1000, tls: tlsFor(c) },
        `${ref} (embeddings)`,
      )
      const j = (await res.json()) as { data?: { embedding: number[]; index?: number }[]; embeddings?: number[][] }
      const rows = ollama ? (j.embeddings ?? []) : [...(j.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding)
      return rows.map(unit)
    },
  }
}
