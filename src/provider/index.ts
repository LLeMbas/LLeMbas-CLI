import { findRef, modelRefs } from "./refs.ts"
import type { Loaded } from "../config/load.ts"
import { OpenAIChatClient } from "./openai-chat.ts"
import type { Client, ResolvedModel } from "./types.ts"

export class ModelError extends Error {}

/** What a start without a login says: LLeMbas CLI 2.0 has no model of its own, only the server's. */
export const NOT_LOGGED_IN = "Not logged in to a LLeMbas server. LLeMbas CLI uses the models of the server it is logged in to: lembas login <address> (e.g. lembas login ai.example.org)."

/** A model of the server this machine is logged in to, by its served id (`deepseek/deepseek-flash`)
 *  or an older form of its name (refs.ts). Without a ref: config.yaml's `model`, else the server's
 *  default for the account, else its first. */
export function resolveModel(loaded: Loaded, ref: string | undefined): ResolvedModel {
  const refs = loaded.refs ?? modelRefs(loaded.connections)
  const [name, connection] = Object.entries(loaded.connections)[0] ?? []
  if (!name || !connection) {
    const why = Object.values(loaded.broken ?? {})[0]
    throw new ModelError(why ? `The LLeMbas login is unusable: ${why}` : NOT_LOGGED_IN)
  }
  if (loaded.broken?.[name]) throw new ModelError(`The LLeMbas login ${name} is unusable: ${loaded.broken[name]}`)
  if (!ref) ref = connection.webui?.default && connection.models[connection.webui.default] ? connection.webui.default : refs[0]?.ref
  if (!ref) throw new ModelError(`${name} serves no model to this account yet. lembas login ${connection.webui?.url ?? ""} again once it does.`.replace("  ", " "))
  const known = findRef(loaded.connections, refs, ref)
  if (known) return { ref: known.ref, connectionName: name, connection, id: known.id, spec: connection.models[known.id] ?? {} }
  // A model the server serves that its list did not have when it was read: the server decides
  // which models exist, so it is asked for rather than refused here. The login's own name in front
  // of it (an older form) is taken off.
  const id = ref.startsWith(`${name}/`) ? ref.slice(name.length + 1) : ref
  return { ref: id, connectionName: name, connection, id, spec: {} }
}

export function clientFor(m: ResolvedModel): Client {
  return new OpenAIChatClient(m)
}

/** Which prompt family a model gets when the server does not say: anthropic, gpt, gemini, or
 *  local — every open-weight or unknown model, which gets Hermes' act-don't-describe guidance. */
export function familyOf(m: ResolvedModel): string {
  if (m.spec.family) return m.spec.family
  const id = m.id.toLowerCase()
  if (id.includes("claude")) return "anthropic"
  if (id.includes("gemini")) return "gemini"
  if (/\bgpt|^o[134]\b|^o[134]-|codex/.test(id)) return "gpt"
  return "local"
}

/** The window to plan with, as the server gives it; undefined when it does not say (no percentage,
 *  no automatic compaction). */
export function contextWindow(m: ResolvedModel): number | undefined {
  return m.spec.context || undefined
}
