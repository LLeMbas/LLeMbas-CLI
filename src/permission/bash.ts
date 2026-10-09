// A deliberately small shell reader: enough to split a command line into the simple commands
// it runs and to know when it cannot be sure. It never needs to be a full parser, because every
// case it does not understand falls back to asking.

export interface Split {
  /** Each simple command, trimmed, in order. */
  commands: string[]
  /** Why an `allow` rule may not be trusted for this line (command substitution, eval, redirection
   *  to a file…). Empty when the split is clean. */
  unsafe: string[]
}

const SAFE_REDIRECT = /^(\d?>&\d|\d?>\s*\/dev\/null|&>\s*\/dev\/null)$/

export function splitCommand(line: string): Split {
  const commands: string[] = []
  const unsafe = new Set<string>()
  let cur = ""
  let quote: "'" | '"' | null = null
  const flush = () => {
    const c = cur.trim()
    if (c) commands.push(c)
    cur = ""
  }

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    const next = line[i + 1]
    if (quote === "'") {
      cur += ch
      if (ch === "'") quote = null
      // A quoted string over several lines is harmless to bash, but it is how a line's real shape
      // gets hidden from a reader like this one: not trusted.
      else if (ch === "\n") unsafe.add("a quoted string across lines")
      continue
    }
    if (ch === "\\" && next !== undefined) {
      cur += ch + next
      i++
      continue
    }
    if (quote === '"') {
      cur += ch
      if (ch === '"') quote = null
      else if (ch === "`" || (ch === "$" && next === "(")) unsafe.add("command substitution")
      else if (ch === "\n") unsafe.add("a quoted string across lines")
      continue
    }
    // A comment runs to the end of the line, and bash reads nothing in it — a quote in a comment
    // must not open a quote here (it would hide the next line's command inside one).
    if (ch === "#" && (cur === "" || /\s$/.test(cur))) {
      while (i + 1 < line.length && line[i + 1] !== "\n") i++
      continue
    }
    // Quoting and expansion this reader does not follow: ANSI-C $'…' (backslash escapes a quote
    // there), ${…}, and here-documents (their lines are data, not commands).
    if (ch === "$" && next === "'") unsafe.add("$'…' quoting")
    if (ch === "$" && next === "{") unsafe.add("parameter expansion")
    if (ch === "<" && next === "<" && line[i + 2] !== "<" && line[i - 1] !== "<") unsafe.add("here-document")
    if (ch === "'" || ch === '"') {
      quote = ch
      cur += ch
      continue
    }
    if (ch === "`" || (ch === "$" && next === "(")) unsafe.add("command substitution")
    if ((ch === "<" || ch === ">") && next === "(") unsafe.add("process substitution")
    if (ch === "\n" || ch === ";") {
      flush()
      continue
    }
    if (ch === "&" && next === "&") {
      flush()
      i++
      continue
    }
    if (ch === "|") {
      flush()
      if (next === "|") i++
      continue
    }
    if (ch === "&" && next !== ">" && line[i - 1] !== ">") {
      flush() // background
      continue
    }
    if (ch === ">") {
      // Capture the whole redirection to judge it: `2>&1` and `>/dev/null` are harmless.
      let j = i + 1
      if (line[j] === ">") j++
      if (line[j] === "&") j++
      while (line[j] === " ") j++
      while (j < line.length && !/[\s;&|]/.test(line[j]!)) j++
      const start = /\d|&/.test(line[i - 1] ?? "") ? i - 1 : i
      const redir = line.slice(start, j).replace(/\s+/g, "")
      if (!SAFE_REDIRECT.test(redir.replace(">>", ">"))) unsafe.add("redirection to a file")
      cur += line.slice(i, j)
      i = j - 1
      continue
    }
    cur += ch
  }
  if (quote) unsafe.add("unclosed quote")
  flush()
  for (const c of commands) {
    const head = words(c)[0] ?? ""
    if (["eval", "source", "."].includes(head)) unsafe.add(`\`${head}\``)
    if (["sh", "bash", "zsh", "dash", "ksh"].includes(head) && /\s-\w*c\b/.test(c)) unsafe.add("nested shell")
  }
  return { commands, unsafe: [...unsafe] }
}

/** Shell words with quotes removed. Leading VAR=value assignments are skipped. */
export function words(command: string): string[] {
  const out: string[] = []
  let cur = ""
  let quote: string | null = null
  let started = false
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      started = true
      continue
    }
    if (ch === "\\" && i + 1 < command.length) {
      cur += command[++i]
      started = true
      continue
    }
    if (/\s/.test(ch)) {
      if (started) out.push(cur)
      cur = ""
      started = false
      continue
    }
    cur += ch
    started = true
  }
  if (started) out.push(cur)
  while (out.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(out[0]!)) out.shift()
  return out
}
