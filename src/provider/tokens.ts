// Rough token estimate for endpoints that report no usage (LLeMbas services/tokens.py).
export const CHARS_PER_TOKEN = 4

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}
