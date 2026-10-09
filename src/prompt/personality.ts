// How the agent talks, and how the person wants to be helped: the two things a person says about
// themselves, appended last to the system prompt — the same keys, presets, headings and order as
// the LLeMbas web UI, so one account reads the same in either place.
//
// Not Hermes Agent's system of named personalities (pirate, noir, kawaii…) and a SOUL.md that
// replaces the identity line: a preset is a short instruction about manner, not a character to
// play, and the six below are
// harness texts (harness/prompts/personality/), shared with the web UI word for word.
import type { Config } from "../config/schema.ts"
import { PERSONALITIES, PERSONALITY_PRESETS } from "../config/schema.ts"
import { promptText } from "./assemble.ts"

export { PERSONALITIES, PERSONALITY_PRESETS }

/** A preset's text; custom is the person's own (personality_custom); none or unknown: undefined. */
export function personalityText(name: string | undefined, custom?: string): string | undefined {
  if (!name) return undefined
  if (name === "custom") return custom?.trim() || undefined
  return (PERSONALITY_PRESETS as readonly string[]).includes(name) ? promptText(`personality/${name}.md`) : undefined
}

/** What the system prompt carries for these settings: the custom instructions, the personality. */
export function personalityOf(config: Pick<Config, "personality" | "personality_custom" | "instructions">): { personality?: string; userInstructions?: string } {
  return { personality: personalityText(config.personality, config.personality_custom), userInstructions: config.instructions?.trim() || undefined }
}
