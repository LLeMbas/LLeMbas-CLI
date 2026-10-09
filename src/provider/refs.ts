// How a model is named: by its provider, not by the login it came through. A LLeMbas
// instance that speaks protocol 2 serves every model as `<provider>/<model>` — `deepseek/deepseek-flash`,
// `llama/bonsai` — and that id is the model's ref here too: each provider is a connection of its
// own as far as the person can see, backed by the instance (requests still go to its /v1, with the
// served id). The older form of the ref was `<login connection>/<id>` (`example/deepseek-flash`).
//
//   - An instance that does not speak protocol 2 serves bare ids: those stay `<login>/<id>`.
//   - A connection of the user's own with the provider's name (`deepseek:` in connections.yaml)
//     keeps `deepseek/x`; the instance's is then `<login>/deepseek/x`.
//   - Two instances serving the same provider: the one logged in to first keeps the short form, the
//     other's are `<login>/<provider>/<model>`.
//   - The old forms still resolve — `example/deepseek-flash` and `example/deepseek/deepseek-flash`
//     are `deepseek/deepseek-flash` — and a config.yaml that names one is rewritten to the new form.
import type { Connection } from "../config/schema.ts"

export interface ModelRef {
  /** What the person sees and writes. */
  ref: string
  /** The connection it is spoken to through, and the id sent there. */
  connection: string
  id: string
  /** An instance's model: its provider, when known — what the old `<login>/<model>` is matched by. */
  provider?: string
}

type Conns = Record<string, Connection & { webui?: { providers?: Record<string, string>; v2?: boolean } }>

/** The provider of a served id: as the instance said it (`provider`), else — from an
 *  instance that speaks protocol 2, whose ids are always `<provider>/<model>` — the part before the
 *  first `/`. An id with a `/` from an older instance is just an id. */
export function providerOf(c: Conns[string], id: string): string | undefined {
  if (!c.webui) return undefined
  const said = c.webui.providers?.[id]
  if (said) return said
  return c.webui.v2 && id.indexOf("/") > 0 ? id.slice(0, id.indexOf("/")) : undefined
}

/** Every model, in config order, with its ref. `logins`: the webui connections in the order they
 *  were logged in to (first keeps a shared provider's short form). */
export function modelRefs(connections: Conns, logins: string[] = []): ModelRef[] {
  const names = new Set(Object.keys(connections))
  const webui = Object.keys(connections).filter((n) => connections[n]!.webui)
  const order = [...logins.filter((n) => webui.includes(n)), ...webui.filter((n) => !logins.includes(n))]
  // Which webui connection a provider's short form belongs to.
  const owner = new Map<string, string>()
  for (const w of order)
    for (const id of Object.keys(connections[w]!.models)) {
      const provider = providerOf(connections[w]!, id)
      if (!provider) continue
      // A connection of that name wins it — unless it is this login itself (`llama/bonsai` on a
      // login named llama is the same string either way).
      if ((names.has(provider) && provider !== w) || owner.has(provider)) continue
      owner.set(provider, w)
    }
  const out: ModelRef[] = []
  for (const [name, c] of Object.entries(connections))
    for (const id of Object.keys(c.models)) {
      const provider = providerOf(c, id)
      const short = provider && owner.get(provider) === name
      out.push({ ref: short ? id : `${name}/${id}`, connection: name, id, ...(provider ? { provider } : {}) })
    }
  return out
}

/** A ref as written — any of the forms above — as the model it names, or undefined. `old`: it was
 *  the form from before providers (`<login>/<model>` for a served `<provider>/<model>`). */
export function findRef(connections: Conns, refs: ModelRef[], ref: string): (ModelRef & { old?: boolean }) | undefined {
  const exact = refs.find((r) => r.ref === ref)
  if (exact) return exact
  const slash = ref.indexOf("/")
  if (slash <= 0) return undefined
  const conn = ref.slice(0, slash)
  const id = ref.slice(slash + 1)
  const c = connections[conn]
  if (!c) return undefined
  const direct = refs.find((r) => r.connection === conn && r.id === id)
  if (direct) return direct
  // `<login>/<model>` from before providers: the one served model of that name, whatever its provider.
  if (c.webui && !id.includes("/")) {
    const by = refs.filter((r) => r.connection === conn && r.provider && r.id === `${r.provider}/${id}`)
    if (by.length === 1) return { ...by[0]!, old: true }
  }
  return undefined
}
