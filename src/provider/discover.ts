// A model's context window when the config does not give one. Config always wins; what is found
// here is kept in learned.json. Tried in order: the server's model list; llama-server's /props
// (directly, or through llama-swap's /upstream/<model>/ passthrough); Ollama's /api/show.
import { learned, learnContext } from "./learned.ts"
import { authHeaders, request, tlsFor } from "./http.ts"
import { OllamaClient } from "./ollama.ts"
import type { Client, ResolvedModel } from "./types.ts"
import { resolveKey } from "../config/load.ts"

/** The window to plan with: configured, else learned, else undefined (unknown). */
export function contextWindow(m: ResolvedModel): number | undefined {
  return m.spec.context || learned().contexts[m.ref] || undefined
}

export async function discoverContext(m: ResolvedModel, client: Client): Promise<number | undefined> {
  if (m.spec.context) return m.spec.context
  const known = learned().contexts[m.ref]
  if (known) return known
  const found = (await fromList(m, client)) ?? (await fromProps(m)) ?? (m.connection.dialect === "ollama" ? await (client as OllamaClient).contextOf(m.id).catch(() => undefined) : undefined)
  if (found && found > 0) learnContext(m.ref, found)
  return found
}

async function fromList(m: ResolvedModel, client: Client): Promise<number | undefined> {
  try {
    return (await client.listModels()).find((d) => d.id === m.id)?.context
  } catch {
    return undefined
  }
}

async function fromProps(m: ResolvedModel): Promise<number | undefined> {
  const base = m.connection.base_url.replace(/\/+$/, "")
  const origin = base.replace(/\/v1$/, "")
  const headers = authHeaders(m.connection, resolveKey(m.connectionName, m.connection))
  for (const url of [`${origin}/upstream/${encodeURIComponent(m.id)}/props`, `${origin}/props`]) {
    try {
      const res = await request(url, { headers, timeoutMs: 15_000, tls: tlsFor(m.connection) }, m.ref)
      const j = (await res.json()) as any
      const n = Number(j?.default_generation_settings?.n_ctx ?? j?.n_ctx)
      if (Number.isFinite(n) && n > 0) return n
    } catch {}
  }
  return undefined
}

/** llama-swap and friends: free the connection's memory when the session moves elsewhere. */
export async function unload(m: ResolvedModel): Promise<void> {
  if (!m.connection.unload_url) return
  try {
    await request(m.connection.unload_url, { method: m.connection.unload_method ?? "POST", headers: authHeaders(m.connection, resolveKey(m.connectionName, m.connection)), timeoutMs: 10_000, tls: tlsFor(m.connection) }, m.ref)
  } catch {}
}
