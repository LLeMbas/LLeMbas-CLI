// Whether a subagent may run on a model beside the session's own, judged by what its server can do
// at once — the harness spec's capacity rule, after LLeMbas services/helpers.py (© Jaroslav Beneš,
// MIT). Both flags name the restrictive state and default off, so a configuration that
// never sets them works exactly as before.
//
// - A connection that holds one model at a time (llama-swap in front of one GPU): a subagent on
//   another of its models unloads the session's model, and the session's cached prompt with it,
//   while its turn waits. The session's own model may still be its own subagent there.
// - A model that serves one request at a time: a subagent on it takes the server's only slot, so
//   the session's cached prompt is pushed out and its next step re-reads the whole conversation —
//   minutes, on a long session with a small GPU.
import type { ResolvedModel } from "../provider/types.ts"

export function capacityRefusal(main: ResolvedModel, helper: ResolvedModel): string {
  if (helper.ref === main.ref) {
    if (helper.spec.single_session)
      return `${helper.ref} serves one request at a time (single_session), so it cannot be its own subagent: the subagent would take the server's only slot and push this session's cached prompt out of it.`
    return ""
  }
  const shared = groupOf(main)
  if (shared !== undefined && shared === groupOf(helper)) {
    const where = `${main.ref}'s server (group ${main.spec.group})`
    return `${where} holds one model at a time, so a subagent on ${helper.ref} would unload ${main.ref}, and this session's cached prompt with it, while its turn waits.`
  }
  return ""
}

/** The same rule between two subagents: a new one is not started where its model would unload, or
 *  take the only slot of, a subagent already running (the spec's "beside the model of a subagent
 *  already running"). */
export function capacityBeside(running: ResolvedModel, helper: ResolvedModel): string {
  if (helper.ref === running.ref) {
    if (helper.spec.single_session) return `${helper.ref} serves one request at a time (single_session), and a subagent is already running on it; a second would wait for the first, or push it out.`
    return ""
  }
  const shared = groupOf(running)
  if (shared !== undefined && shared === groupOf(helper)) {
    const where = `${running.ref}'s server (group ${running.spec.group})`
    return `${where} holds one model at a time, and a subagent is already running on ${running.ref} there; one on ${helper.ref} would unload it.`
  }
  return ""
}

/** Which one-model-at-a-time server a model is on, as the LLeMbas server says (`capacity.group`,
 *  the spec's), or none. */
function groupOf(m: ResolvedModel): string | undefined {
  return m.spec.group !== undefined ? `group:${m.spec.group}` : undefined
}
