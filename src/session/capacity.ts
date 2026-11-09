// Whether a subagent may run on a model beside the session's own, judged by what its server can do
// at once — the harness spec's capacity rule, after LLeMbas services/helpers.py (© Jaroslav Beneš,
// MIT). Both flags name the restrictive state and default off, so a configuration that
// never sets them works exactly as before. From spec 3.2.0 a model says how many requests it serves
// at once (`parallel`; single_session is 1).
//
// - A connection that holds one model at a time (llama-swap in front of one GPU): a subagent on
//   another of its models unloads the session's model, and the session's cached prompt with it,
//   while its turn waits. The session's own model may still be its own subagent there.
// - A model that serves one request at a time: a subagent on it takes the server's only slot, so
//   the session's cached prompt is pushed out and its next step re-reads the whole conversation —
//   minutes, on a long session with a small GPU.
import type { ResolvedModel } from "../provider/types.ts"

/** How many requests a model's server serves at once (models/schema.json capacity, spec 3.2.0):
 *  `parallel` when given, else 1 for single_session, else no limit (a hosted API). */
export function parallelOf(m: Pick<ResolvedModel, "spec">): number {
  const p = m.spec.parallel
  if (Number.isInteger(p) && p! >= 1) return p!
  return m.spec.single_session ? 1 : Infinity
}

/** `busy`: this session's requests the sub's model already serves besides the main prompt's
 *  (subagents running on it). */
export function capacityRefusal(main: ResolvedModel, sub: ResolvedModel, busy = 0): string {
  if (sub.ref === main.ref) {
    const n = parallelOf(sub)
    if (n === 1)
      return `${sub.ref} serves one request at a time, so it cannot be its own subagent: the subagent would take the server's only slot and push this session's cached prompt out of it.`
    if (1 + busy >= n)
      return `${sub.ref} serves ${n} requests at once, and this session already has ${n} on it; another subagent would wait, or push this session's cached prompt out.`
    return ""
  }
  const shared = groupOf(main)
  if (shared !== undefined && shared === groupOf(sub)) {
    const where = `${main.ref}'s server (group ${main.spec.group})`
    return `${where} holds one model at a time, so a subagent on ${sub.ref} would unload ${main.ref}, and this session's cached prompt with it, while its turn waits.`
  }
  return ""
}

/** The same rule between two subagents: a new one is not started where its model would unload, or
 *  take the only slot of, a subagent already running (the spec's "beside the model of a subagent
 *  already running"). */
export function capacityBeside(running: ResolvedModel, sub: ResolvedModel, busy = 1): string {
  if (sub.ref === running.ref) {
    const n = parallelOf(sub)
    if (n === 1) return `${sub.ref} serves one request at a time, and a subagent is already running on it; a second would wait for the first, or push it out.`
    if (busy >= n) return `${sub.ref} serves ${n} requests at once, and as many subagents already run on it; another would wait, or push one out.`
    return ""
  }
  const shared = groupOf(running)
  if (shared !== undefined && shared === groupOf(sub)) {
    const where = `${running.ref}'s server (group ${running.spec.group})`
    return `${where} holds one model at a time, and a subagent is already running on ${running.ref} there; one on ${sub.ref} would unload it.`
  }
  return ""
}

/** Which one-model-at-a-time server a model is on, as the LLeMbas server says (`capacity.group`,
 *  the spec's), or none. */
function groupOf(m: ResolvedModel): string | undefined {
  return m.spec.group !== undefined ? `group:${m.spec.group}` : undefined
}
