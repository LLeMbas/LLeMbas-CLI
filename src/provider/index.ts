import { findRef, modelRefs } from "./refs.ts"
import type { Loaded } from "../config/load.ts"
import { AnthropicClient } from "./anthropic.ts"
import { OpenAIChatClient } from "./openai-chat.ts"
import { ResponsesClient } from "./responses.ts"
import { GeminiClient } from "./gemini.ts"
import { OllamaClient } from "./ollama.ts"
import { ProviderError, type Client, type ResolvedModel } from "./types.ts"

export class ModelError extends Error {}

/** `connection/model`. The model part may itself contain slashes (`openrouter/qwen/qwen3-coder`). */
export function resolveModel(loaded: Loaded, ref: string | undefined): ResolvedModel {
  const refs = loaded.refs ?? modelRefs(loaded.connections)
  if (!ref) {
    // A LLeMbas instance says which model its account starts on; that, before anything else.
    const instance = Object.entries(loaded.connections).find(([, c]) => c.webui?.default && c.models[c.webui.default])
    if (instance) ref = refs.find((r) => r.connection === instance[0] && r.id === instance[1].webui!.default)?.ref ?? `${instance[0]}/${instance[1].webui!.default}`
  }
  if (!ref) {
    const first = refs[0]
    if (!first) throw new ModelError("No model configured. Add a connection to ~/.config/lembas/connections.yaml and set `model:` in config.yaml.")
    ref = first.ref
  }
  // Any form of the name (`deepseek/x`, or the old `example/x`): the model it names, under
  // the ref it has now.
  const known = findRef(loaded.connections, refs, ref)
  if (known) {
    const connection = loaded.connections[known.connection]!
    if (loaded.broken?.[known.connection]) throw new ModelError(`Connection "${known.connection}" is unusable: ${loaded.broken?.[known.connection]}`)
    return { ref: known.ref, connectionName: known.connection, connection, id: known.id, spec: connection.models[known.id] ?? {} }
  }
  const slash = ref.indexOf("/")
  if (slash <= 0) throw new ModelError(`Model "${ref}" must be written connection/model`)
  const connectionName = ref.slice(0, slash)
  const id = ref.slice(slash + 1)
  if (loaded.broken?.[connectionName]) throw new ModelError(`Connection "${connectionName}" is unusable: ${loaded.broken[connectionName]}`)
  const connection = loaded.connections[connectionName]
  if (!connection) throw new ModelError(`No connection named "${connectionName}" (have: ${Object.keys(loaded.connections).join(", ") || "none"})`)
  const spec = connection.models[id]
  if (!spec && !connection.discover)
    throw new ModelError(`Connection "${connectionName}" has no model "${id}" (have: ${Object.keys(connection.models).join(", ") || "none"}). Add it, or set discover: true.`)
  return { ref, connectionName, connection, id, spec: spec ?? {} }
}

export function clientFor(m: ResolvedModel): Client {
  switch (m.connection.dialect) {
    case "openai-chat":
      return new OpenAIChatClient(m)
    case "anthropic":
      return new AnthropicClient(m)
    case "responses":
      return new ResponsesClient(m)
    case "gemini":
      return new GeminiClient(m)
    case "ollama":
      return new OllamaClient(m)
  }
}

/** Which prompt family a model gets when the config does not say: anthropic, gpt, gemini, or
 *  local — every open-weight or unknown model, which gets Hermes' act-don't-describe guidance. */
export function familyOf(m: ResolvedModel): string {
  if (m.spec.family) return m.spec.family
  const id = m.id.toLowerCase()
  if (id.includes("claude")) return "anthropic"
  if (id.includes("gemini")) return "gemini"
  if (/\bgpt|^o[134]\b|^o[134]-|codex/.test(id)) return "gpt"
  return "local"
}
