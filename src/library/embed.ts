// Embeddings for the library: `embedding:` in config.yaml names an embedding model of the LLeMbas
// server, reached at its OpenAI-shaped /v1/embeddings. Vectors are made unit length here, so a dot
// product is the cosine.
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
  // An embedding model of the server, by its served id (`llama/nomic-embed`) — not a chat model, so
  // not a model ref (lembas/webui.ts, isChatModel): found among the ids the server says it serves
  // for embeddings, or as a ref in any of its forms. The name stored with the vectors stays the ref
  // as written, so a library indexed under it is still found.
  const [name, c] = Object.entries(loaded.connections)[0] ?? []
  if (!name || !c) throw new Error("embedding: not logged in to a LLeMbas server (lembas login)")
  let id: string
  if (c.webui?.embeddings?.includes(ref)) id = ref
  else if (ref.startsWith(`${name}/`) && c.webui?.embeddings?.includes(ref.slice(name.length + 1))) id = ref.slice(name.length + 1)
  else {
    try {
      id = resolveModel(loaded, ref).id
    } catch (e) {
      throw new Error(`embedding: ${(e as Error).message}`)
    }
  }
  return {
    model: ref,
    async embed(texts, signal) {
      const res = await request(
        joinUrl(c.base_url, "embeddings"),
        { method: "POST", headers: authHeaders(c, resolveKey(name, c)), body: JSON.stringify({ model: id, input: texts }), signal, timeoutMs: (c.timeout ?? 120) * 1000, tls: tlsFor(c) },
        `${ref} (embeddings)`,
      )
      const j = (await res.json()) as { data?: { embedding: number[]; index?: number }[] }
      return [...(j.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => unit(d.embedding))
    },
  }
}
