// Reading an image from the clipboard through the terminal itself: kitty's clipboard protocol
// (OSC 5522). It is the one way a clipboard image crosses an SSH connection — the terminal on the
// person's own machine reads its clipboard and sends the bytes down the same connection the
// keystrokes use. OSC 52 carries text only.
//
//   → ESC ] 5522 ; type=read[:id=…:pw=…:name=…] ; base64("image/png image/jpeg") ST
//   ← ESC ] 5522 ; type=read:status=OK ST
//   ← ESC ] 5522 ; type=read:status=DATA:mime=base64(mime) ; base64(chunk) ST      (chunks ≤ 4096 bytes)
//   ← ESC ] 5522 ; type=read:status=DONE ST
//   ← ESC ] 5522 ; type=read:status=EPERM | ENOSYS | EBUSY ST                      (instead of OK)
//
// The request "." lists the kinds on the clipboard and needs no permission; the read itself the
// terminal asks the person about (once, when it remembers the password sent with it).
//
// What can go wrong on the way, and what is done about it. OpenTUI's input parser gives up on an
// escape sequence that stops arriving for about 20 ms and hands what it has on as typed keys. A
// reply that stalls inside a packet — an SSH connection does that — therefore loses that packet,
// and its base64 would be typed into the prompt box. So while a read is under way the box's input
// is held (`holdInput`): nothing of a reply reaches it, and any input that turned up during the
// read means a packet was lost — the read fails, said in a line, and nothing is saved. What
// arrives is also checked as an image by its own structure (the caller's `whole`). A read can
// therefore fail on a slow connection, but never saves a broken image or types into the box;
// because it can fail, the whole path is off unless `kitty_clipboard: true` is set.
const OSC = "\x1b]5522;"
const ST = "\x1b\\"

export interface OscTerminal {
  /** Write to the terminal. */
  write(data: string): void
  /** Every OSC sequence the terminal sends, whole. Returns what unsubscribes. */
  subscribeOsc(handler: (sequence: string) => void): () => void
  /** Hold the prompt box's input until the function returned is called; that call says how many
   *  inputs (keys, pastes) arrived meanwhile and were dropped. */
  holdInput?(): () => number
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64")

/** One OSC 5522 sequence as its metadata and payload; undefined for any other sequence. */
export function parse5522(sequence: string): { meta: Record<string, string>; payload: string } | undefined {
  if (!sequence.startsWith(OSC)) return undefined
  const body = sequence.slice(OSC.length).replace(/(?:\x1b\\|\x07)$/, "")
  const cut = body.indexOf(";")
  const head = cut === -1 ? body : body.slice(0, cut)
  const meta: Record<string, string> = {}
  for (const pair of head.split(":")) {
    const eq = pair.indexOf("=")
    if (eq > 0) meta[pair.slice(0, eq)] = pair.slice(eq + 1)
  }
  return { meta, payload: cut === -1 ? "" : body.slice(cut + 1) }
}

/** Whether the terminal is one that speaks the protocol: kitty (also through `ssh`, which carries
 *  TERM), and not inside a multiplexer that would swallow the replies. */
export function kittyClipboardLikely(env: Record<string, string | undefined> = process.env): boolean {
  if (env.TMUX || env.STY || env.ZELLIJ) return false
  return !!env.KITTY_WINDOW_ID || /kitty/i.test(env.TERM ?? "")
}

/** `garbled`: part of the reply was lost on the way, or what arrived is not a whole image. */
export type KittyRead = { status: "read"; mime: string; bytes: Uint8Array } | { status: "unsupported" | "empty" | "denied" | "busy" | "too-large" | "timed-out" | "garbled" }

interface ReadOptions {
  types: readonly string[]
  /** How long the terminal has to answer the listing: one that does not know the protocol says nothing. */
  listTimeoutMs?: number
  /** How long the read may take — the person may be looking at the terminal's permission question. */
  readTimeoutMs?: number
  maxBytes?: number
  /** Sent with the read so the terminal can remember the person's answer for this program. */
  password?: string
  name?: string
  /** The kind of image these bytes are when they are a whole one (project/image.ts `sniffImage`
   *  and `imageWhole`); undefined when they are not. What is read is believed only by this. */
  whole?: (bytes: Uint8Array) => string | undefined
}

/** One request and its replies: resolves with the data packets by kind, or how it failed. */
function request(term: OscTerminal, meta: string, payload: string, id: string, timeoutMs: number, maxBytes: number): Promise<{ status: "done"; data: Map<string, Uint8Array[]> } | { status: Exclude<KittyRead["status"], "read" | "empty"> }> {
  return new Promise((resolve) => {
    const data = new Map<string, Uint8Array[]>()
    let total = 0
    const finish = (r: Parameters<typeof resolve>[0]) => {
      clearTimeout(timer)
      off()
      resolve(r)
    }
    const timer = setTimeout(() => finish({ status: "timed-out" }), timeoutMs)
    const off = term.subscribeOsc((sequence) => {
      const p = parse5522(sequence)
      // Another request's reply (a different id) is not ours; a terminal that sends no id back is believed.
      if (!p || p.meta.type !== "read" || (p.meta.id !== undefined && p.meta.id !== id)) return
      switch (p.meta.status) {
        case "OK":
          return
        case "DATA": {
          const mime = Buffer.from(p.meta.mime ?? "", "base64").toString("utf8")
          const chunk = new Uint8Array(Buffer.from(p.payload, "base64"))
          total += chunk.length
          if (total > maxBytes) return finish({ status: "too-large" })
          const list = data.get(mime) ?? []
          list.push(chunk)
          data.set(mime, list)
          return
        }
        case "DONE":
          return finish({ status: "done", data })
        case "EPERM":
          return finish({ status: "denied" })
        case "EBUSY":
          return finish({ status: "busy" })
        default:
          return finish({ status: "unsupported" })
      }
    })
    try {
      term.write(`${OSC}type=read:id=${id}${meta};${b64(payload)}${ST}`)
    } catch {
      finish({ status: "unsupported" })
    }
  })
}

const join = (chunks: Uint8Array[]) => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

let serial = 0

/** An image from the clipboard of the terminal's own machine: the kinds are listed first (no
 *  permission needed, and a terminal that does not answer does not speak the protocol), then the
 *  first of `types` that is there is read. */
export async function kittyReadImage(term: OscTerminal, o: ReadOptions): Promise<KittyRead> {
  const release = term.holdInput?.()
  let r: KittyRead
  try {
    r = await read(term, o)
  } finally {
    // Input during the read is a reply that came apart: whatever was put together is not trusted.
    if ((release?.() ?? 0) > 0) return { status: "garbled" }
  }
  return r
}

async function read(term: OscTerminal, o: ReadOptions): Promise<KittyRead> {
  const maxBytes = o.maxBytes ?? 20_000_000
  const id = `lembas${process.pid}.${++serial}`
  const listed = await request(term, "", ".", id, o.listTimeoutMs ?? 1500, 65_536)
  // Silence within the listing's time is a terminal that does not know OSC 5522.
  if (listed.status === "timed-out") return { status: "unsupported" }
  if (listed.status !== "done") return { status: listed.status }
  const kinds = new Set(
    [...listed.data.values()]
      .flatMap((chunks) => Buffer.from(join(chunks)).toString("utf8").split(/\s+/))
      .filter(Boolean),
  )
  const type = o.types.find((t) => kinds.has(t))
  if (!type) return { status: "empty" }
  const auth = o.password && o.name ? `:pw=${b64(o.password)}:name=${b64(o.name)}` : ""
  const got = await request(term, auth, type, `${id}r`, o.readTimeoutMs ?? 30_000, maxBytes)
  if (got.status !== "done") return { status: got.status }
  const chunks = got.data.get(type) ?? [...got.data.values()][0]
  if (!chunks?.length) return { status: "empty" }
  const bytes = join(chunks)
  if (!o.whole) return { status: "read", mime: type, bytes }
  // By its bytes, not by what it was asked for or called.
  const mime = o.whole(bytes)
  return mime ? { status: "read", mime, bytes } : { status: "garbled" }
}
