// What a server says is somebody else's text. Before any of it is drawn on a terminal or printed —
// a tool's or a prompt's name and description, an error, what a local server wrote to stderr —
// it goes through here: control characters out (an escape sequence in a description must not
// move the cursor, set the title or the clipboard), and, where it leaves this machine or is
// printed into a reply, what looks like a secret out too.

/** Text with every control character gone: escape sequences (CSI, OSC, the rest), the other C0
 *  and C1 characters, DEL. `lines`: newlines are kept (a description, an error in full); else the
 *  text becomes one line. A tab is a space. */
export function clean(text: unknown, lines = false): string {
  const s = typeof text === "string" ? text : text === undefined || text === null ? "" : String(text)
  const out = s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "") // OSC … BEL | ST
    .replace(/\x1b[P^_X][^\x1b]*(?:\x1b\\)?/g, "") // DCS, PM, APC, SOS … ST
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "") // CSI
    .replace(/\x1b[\s\S]?/g, "") // any other escape
    .replace(/\u009b[0-?]*[ -/]*[@-~]/g, "") // 8-bit CSI
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, "")
  return lines ? out : out.replace(/\s*\n\s*/g, " ").trim()
}

/** An address without what may be secret in it: no user or password, no query, no fragment. Not
 *  an address: the text, cleaned. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}${u.pathname}${u.search ? "?…" : ""}`
  } catch {
    return clean(url)
  }
}

/** Text with what looks like a secret taken out: credentials and queries in addresses, a value
 *  after `token`, `key`, `secret`, `password`, `authorization` or `bearer`, and long runs of
 *  letters and digits that have both (keys, hashes). */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1")
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#"')]+)\?[^\s"')]*/gi, "$1?…")
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]")
    .replace(/\b((?:api[_-]?)?(?:token|key|secret|password|passwd|authorization|auth|cookie)\b["']?\s*[=:]\s*["']?)[^\s"',;&]+/gi, "$1[redacted]")
    .replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g, "[redacted]")
}

/** Text with the credentials and queries of the addresses in it taken out — what is shown of an
 *  error on this machine, where the rest of it is the person's own to read. */
export function redactUrls(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1").replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#"')]+)\?[^\s"')]*/gi, "$1?…")
}

/** An error as it may leave this machine or be printed into a reply: its first line, cleaned,
 *  secrets out, not longer than a line should be. */
export function errorLine(error: string | undefined, max = 200): string {
  const line = redactSecrets(clean((error ?? "").split("\n")[0]))
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** Text for a markdown reply, so that nothing in it is markup: a server's description cannot put
 *  a link or an image into the chat. */
export function mdEscape(text: string): string {
  return text.replace(/[\\`*_{}[\]()<>#+!|~]/g, "\\$&").replace(/^(\s*)([-+]|\d+[.)])(\s)/gm, "$1\\$2$3")
}
