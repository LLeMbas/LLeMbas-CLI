// What is said aloud, and what is believed of what was heard. After Hermes Agent
// (tools/tts_text_normalize.py, tools/voice_mode_transcript.py; MIT, © Nous Research).

/** A reply as it should sound: no code, no markdown, no URLs, symbols as words. */
export function spokenText(md: string): string {
  let t = md
    .replace(/<think>[\s\S]*?(<\/think>|$)/gi, " ")
    // code is not read out: a fenced block becomes a pause
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<?https?:\/\/[^\s>)]+>?/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, "$1$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*([-*+]|\d+[.)])\s+/gm, "")
    .replace(/^\s*([-*_]\s*){3,}$/gm, " ")
    // a heading runs into its first line: "Weather. It will be sunny."
    .replace(/^#{1,6}\s+(.+)$/gm, "$1.")
    // tables: cells become a list
    .replace(/^\s*\|?\s*:?-{3,}.*$/gm, "")
    .replace(/[ \t]*\|[ \t]*/g, "; ")
  t = t
    .replace(/(\d+)\s*[-–]\s*(\d+)\s*°C/g, "$1 to $2 degrees Celsius")
    .replace(/(\d+)\s*°C/g, "$1 degrees Celsius")
    .replace(/(\d+)\s*°F/g, "$1 degrees Fahrenheit")
    .replace(/(\d)\s*%/g, "$1 percent")
    .replace(/(\d)\s*\/\s*(month|year|day|hour|week)\b/g, "$1 per $2")
    .replace(/€\s*(\d[\d.,]*)|(\d[\d.,]*)\s*€/g, (_m, a: string, b: string) => `${a ?? b} euros`)
    .replace(/\$\s*(\d[\d.,]*)/g, "$1 dollars")
    .replace(/£\s*(\d[\d.,]*)/g, "$1 pounds")
    .replace(/\s&\s/g, " and ")
    .replace(/\s*(→|⇒|->)\s*/g, " to ")
    .replace(/(≈|~)\s*(?=\d)/g, "about ")
    .replace(/\p{Extended_Pictographic}️?/gu, "")
  // every line ends as a sentence, then the lines run together
  const lines = t
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l && !/^[;.,\s]+$/.test(l))
    .map((l) => l.replace(/^;\s*|;\s*$/g, "").replace(/[:;]$/, ".").replace(/([^.!?])$/, "$1."))
  return lines.join(" ").replace(/\s+([.,;!?])/g, "$1").replace(/\.{2,}/g, ".").trim()
}

/** Speakable pieces: whole sentences, each under `max` characters, small ones merged. */
export function sentences(text: string, max = 400, min = 20): string[] {
  // Too long even between commas: cut at spaces, never drop the rest.
  const byWords = (s: string): string[] => {
    const out: string[] = []
    let cur = ""
    for (const w of s.split(/\s+/)) {
      if (cur && cur.length + w.length + 1 > max) (out.push(cur), (cur = ""))
      cur = cur ? `${cur} ${w}` : w
    }
    if (cur) out.push(cur)
    return out.flatMap((x) => (x.length <= max ? [x] : x.match(new RegExp(`.{1,${max}}`, "g")) ?? []))
  }
  const parts = text
    .split(/(?<=[.!?])\s+/)
    .flatMap((s) => (s.length <= max ? [s] : s.split(/(?<=[,;:])\s+/)))
    .flatMap((s) => (s.length <= max ? [s] : byWords(s)))
  const out: string[] = []
  for (const p of parts) {
    const last = out[out.length - 1]
    if (last !== undefined && (last.length < min || last.length + p.length + 1 <= Math.min(max, 160))) out[out.length - 1] = `${last} ${p}`
    else out.push(p)
  }
  return out.filter((s) => s.trim())
}

// What Whisper "hears" in silence: training-set subtitles.
const PHANTOMS = new Set([
  "thank you",
  "thanks for watching",
  "subscribe to my channel",
  "like and subscribe",
  "please subscribe",
  "thank you for watching",
  "bye",
  "you",
  "the end",
  "sous-titres réalisés par la communauté d'amara.org",
  "amara.org",
  "ご視聴ありがとうございました",
  "untertitel der amara.org-community",
])
const ONLY_FILLER = /^(?:thank you|thanks|bye|you|ok|okay|the end|\.|\s|,|!)+$/i

/** The transcript, or "" when it is one of the phrases Whisper makes up from silence. */
export function believable(transcript: string): string {
  const t = transcript.replace(/\[(BLANK_AUDIO|MUSIC|NOISE|SILENCE)\]|\((silence|music|noise)\)/gi, " ").replace(/\s+/g, " ").trim()
  const key = t.toLowerCase().replace(/[.!]/g, "").trim()
  if (!key || PHANTOMS.has(key) || ONLY_FILLER.test(t)) return ""
  return t
}
