// Session titles. A session is named from its first prompt the moment it is sent, so a session
// that dies mid-reply still has a name; once the first reply is in, the model may write a better
// one (OpenCode and Hermes both do — a prompt's first line is often "ok so" or a pasted error).
import type { Client, Message } from "../provider/types.ts"

const MAX = 80

/** The first line of a prompt worth reading, cut at a word to at most 80 characters. */
export function promptTitle(text: string): string {
  const line =
    text
      .split("\n")
      .map((l) => l.replace(/^[\s#>*\-`]+/, "").replace(/\s+/g, " ").trim())
      .find((l) => l.length > 0) ?? ""
  return clip(line)
}

function clip(s: string): string {
  if (s.length <= MAX) return s
  const cut = s.slice(0, MAX - 1)
  const space = cut.lastIndexOf(" ")
  return `${space > MAX / 2 ? cut.slice(0, space) : cut}…`
}

const PROMPT = `Write a title for the conversation below: 3 to 7 words that say what it is about, in the language the user wrote in.
Reply with the title only — no quotes, no full stop at the end, no preamble.

The user's first message:
{{prompt}}

The first reply:
{{reply}}`

/** A title from the model, or undefined when it gave nothing usable. */
export async function modelTitle(client: Client, prompt: string, reply: string, signal?: AbortSignal): Promise<string | undefined> {
  const text = PROMPT.replace("{{prompt}}", () => prompt.slice(0, 2000)).replace("{{reply}}", () => reply.slice(0, 2000) || "(none yet)")
  let out = ""
  for await (const ev of client.stream({ system: "", messages: [{ role: "user", parts: [{ type: "text", text }] }], tools: [], effort: null, signal }))
    if (ev.type === "finish") out = ev.message.parts.map((p) => (p.type === "text" ? p.text : "")).join("")
  return cleanTitle(out)
}

export function cleanTitle(raw: string): string | undefined {
  const line = raw
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean)
  if (!line) return undefined
  const t = line
    .replace(/^(\*\*)?title(\*\*)?\s*:\s*/i, "")
    .replace(/^#+\s*/, "")
    .replace(/^["'“„*`]+|["'”*`]+$/g, "")
    .replace(/[.。]$/, "")
    .trim()
  return t ? clip(t) : undefined
}

/** The text of the first assistant reply in a conversation. */
export function firstReply(messages: Message[]): string {
  for (const m of messages) if (m.role === "assistant") {
    const t = m.parts.map((p) => (p.type === "text" ? p.text : "")).join("").trim()
    if (t) return t
  }
  return ""
}
