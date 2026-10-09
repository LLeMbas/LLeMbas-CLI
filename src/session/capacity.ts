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
    const where = main.spec.group !== undefined ? `${main.ref}'s server (group ${main.spec.group})` : main.connectionName
    return `${where} holds one model at a time (${main.spec.group !== undefined ? "group" : "one_model_at_a_time"}), so a subagent on ${helper.ref} would unload ${main.ref}, and this session's cached prompt with it, while its turn waits.`
  }
  return ""
}

/** Which one-model-at-a-time server a model is on: its own `group`, else its connection when the
 *  connection sets one_model_at_a_time, else none. The spec's capacity.group. */
function groupOf(m: ResolvedModel): string | undefined {
  if (m.spec.group !== undefined) return `group:${m.spec.group}`
  return m.connection.one_model_at_a_time ? `connection:${m.connectionName}` : undefined
}
