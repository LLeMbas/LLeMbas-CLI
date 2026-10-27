// How a model is named: by the id the LLeMbas server serves it under — `deepseek/deepseek-flash`,
// `llama/bonsai` — which is its ref here too. LLeMbas CLI 2.0 talks to one server, the one it is
// logged in to, so there is nothing to tell apart: no connection prefix, no second login.
//
// The older forms still resolve, and a config.yaml that names one is rewritten to the id (load.ts):
// `<login>/<id>` (`example/deepseek/deepseek-flash`) and, from before providers, `<login>/<model>`
// for the one served `<provider>/<model>` of that name (`example/deepseek-flash`).
import type { Connection } from "../config/schema.ts"

export interface ModelRef {
  /** What the person sees and writes: the served id. */
  ref: string
  /** The login it is spoken to through, and the id sent there. */
  connection: string
  id: string
}

type Conns = Record<string, Connection>

/** Every model the server serves, in its order, with its ref. */
export function modelRefs(connections: Conns): ModelRef[] {
  return Object.entries(connections).flatMap(([name, c]) => Object.keys(c.models).map((id) => ({ ref: id, connection: name, id })))
}

/** A ref as written — the id, or an older form — as the model it names, or undefined. `old`: it
 *  was an older form, which config.yaml is rewritten from. */
export function findRef(connections: Conns, refs: ModelRef[], ref: string): (ModelRef & { old?: boolean }) | undefined {
  const exact = refs.find((r) => r.ref === ref)
  if (exact) return exact
  const slash = ref.indexOf("/")
  if (slash <= 0) return undefined
  const conn = ref.slice(0, slash)
  const id = ref.slice(slash + 1)
  if (!connections[conn]) return undefined
  const direct = refs.find((r) => r.connection === conn && r.id === id)
  if (direct) return { ...direct, old: true }
  // `<login>/<model>` from before providers: the one served model of that name, whatever its provider.
  if (!id.includes("/")) {
    const by = refs.filter((r) => r.connection === conn && r.id.endsWith(`/${id}`) && r.id.indexOf("/") === r.id.length - id.length - 1)
    if (by.length === 1) return { ...by[0]!, old: true }
  }
  return undefined
}
