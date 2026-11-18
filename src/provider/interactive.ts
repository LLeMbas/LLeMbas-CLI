// Interactive-only models (harness interactive.md, spec 3.9.0): a model its provider allows for a
// person's own turns and nothing else. The server says which (`interactive_only` on a served
// model); it cannot tell what a request to its /v1 is for, so what is scheduled or background
// work is decided here. Three small rules (conformance/interactive.json).
import { LOOP } from "../harness.ts"
import { fillPrompt } from "../prompt/fill.ts"

export interface Listed {
  id: string
  interactive_only?: boolean
}

const only = (model: string, models: readonly Listed[]): boolean => models.find((m) => m.id === model)?.interactive_only === true

/** The same model on a connection that is not interactive-only: another served id with the same
 *  part after its first `/`, the first in the list's order. */
export function twin(model: string, models: readonly Listed[], fits: (id: string) => boolean = () => true): string | undefined {
  const cut = model.indexOf("/")
  if (cut < 0) return undefined
  const name = model.slice(cut + 1)
  return models.find((m) => m.id !== model && m.interactive_only !== true && m.id.indexOf("/") >= 0 && m.id.slice(m.id.indexOf("/") + 1) === name && fits(m.id))?.id
}

export type BackgroundCall = "title" | "compaction" | "auto_compaction"

/** Where a background call that would use `model` goes: the model itself when it is not
 *  interactive-only; else its twin; else the first default that is listed and is not; else
 *  nowhere — skipped (a title, automatic compaction) or refused in words (compaction asked for). */
export function background(o: { model: string; models: readonly Listed[]; defaults?: readonly (string | undefined)[]; call: BackgroundCall; unfit?: readonly string[] }): { model: string } | { skip: true } | { refused: string } {
  if (!only(o.model, o.models)) return { model: o.model }
  // A model that cannot take the call — a window below what must be sent, no tools for a
  // conversation that has tool calls — is passed over like one that is not there.
  const fits = (id: string) => !(o.unfit ?? []).includes(id)
  const other = twin(o.model, o.models, fits) ?? (o.defaults ?? []).find((d): d is string => Boolean(d) && o.models.some((m) => m.id === d) && !only(d!, o.models) && fits(d!))
  if (other) return { model: other }
  return LOOP.interactive.background[o.call] === "refuse" ? { refused: LOOP.interactive.texts.compact } : { skip: true }
}

/** Why scheduled work may not use `model` — the spec's sentence — or undefined when it may. */
export function scheduledRefusal(model: string, models: readonly Listed[], label = model): string | undefined {
  return only(model, models) ? fillPrompt(LOOP.interactive.texts.scheduled, { model: label }) : undefined
}

/** What `-32602` carries as `data.reason` for a scheduled request refused for it. */
export const INTERACTIVE_REASON = LOOP.interactive.reason

/** A one-shot run with nobody at it: none of its standard input, output and error is a terminal
 *  (a cron job, a pipeline). Somebody piping a prompt in at a terminal still has one. */
export function nobodyAtIt(streams: { stdin?: boolean; stdout?: boolean; stderr?: boolean }): boolean {
  return !streams.stdin && !streams.stdout && !streams.stderr
}

/** What `lembas run` adds to the refusal: the way forward. */
export const RUN_HINT = "Run it at a terminal (over SSH: ssh -t), or name a model that is not interactive-only with -m."
