// Images that reach the prompt box other than as a file: the clipboard (OpenTUI's host clipboard,
// wl-paste / xclip behind it), text that is an image (a data URL, base64), and the terminal's own
// clipboard through kitty's OSC 5522.
import { expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cleanPastedImages, clipboardCommands, clipboardImage, imageFromText, MAX_PASTE_BYTES, savePastedImage, sniffImage } from "../src/project/image.ts"
import { kittyClipboardLikely, kittyReadImage, parse5522, type OscTerminal } from "../src/tui/kitty-clipboard.ts"

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64")
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), Buffer.from("JFIF\0"), Buffer.alloc(16)])
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(16)])
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([4, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(8)])

test("an image is known by its bytes", () => {
  expect(sniffImage(PNG)).toBe("image/png")
  expect(sniffImage(JPEG)).toBe("image/jpeg")
  expect(sniffImage(GIF)).toBe("image/gif")
  expect(sniffImage(WEBP)).toBe("image/webp")
  expect(sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeUndefined()
  expect(sniffImage(Buffer.from("RIFF....WAVEfmt "))).toBeUndefined()
  expect(sniffImage(new Uint8Array(3))).toBeUndefined()
})

test("pasted text that is an image: a data URL, base64 with line breaks, bare base64", () => {
  const b64 = PNG.toString("base64")
  expect(imageFromText(`data:image/png;base64,${b64}`)).toEqual({ mime: "image/png", bytes: new Uint8Array(PNG) })
  // What it is called does not decide what it is.
  expect(imageFromText(`  data:image/jpeg;base64,${b64}\n`)).toMatchObject({ mime: "image/png" })
  expect(imageFromText(`data:image/jpeg;base64,${JPEG.toString("base64")}`)).toMatchObject({ mime: "image/jpeg" })
  // Wrapped at 76 columns, as base64(1) and mail programs write it.
  const wrapped = b64.replace(/(.{20})/g, "$1\n")
  expect(imageFromText(wrapped)).toMatchObject({ mime: "image/png" })
  expect(imageFromText(`data:image/gif;base64,${GIF.toString("base64")}`)).toMatchObject({ mime: "image/gif" })
  expect(imageFromText(WEBP.toString("base64"))).toMatchObject({ mime: "image/webp" })
})

test("pasted text that is not an image stays text; a data URL that is not one is refused in words", () => {
  expect(imageFromText("hello there, this is a perfectly ordinary sentence")).toBeUndefined()
  // Starts as a PNG would, but is prose.
  expect(imageFromText("iVBORw0KGgo is how a PNG starts in base64, did you know?")).toBeUndefined()
  // Base64 of something else.
  expect(imageFromText(Buffer.from("just some bytes, nothing more than that").toString("base64"))).toBeUndefined()
  expect(imageFromText("data:text/plain;base64,aGVsbG8gd29ybGQsIGhlbGxvIHdvcmxk")).toBeUndefined()
  expect(imageFromText(`data:image/svg+xml;base64,${Buffer.from("<svg/>".repeat(8)).toString("base64")}`)).toBeUndefined()
  expect(imageFromText(`data:image/png;base64,${Buffer.from("not an image at all, only text").toString("base64")}`)).toEqual({ error: "the pasted data URL is not a PNG, JPEG, WebP or GIF image" })
  const huge = `data:image/png;base64,${"A".repeat(Math.ceil((MAX_PASTE_BYTES * 4) / 3) + 8)}`
  expect(imageFromText(huge)).toMatchObject({ error: expect.stringContaining("over 20 MB") })
})

test("the clipboard: the host clipboard's image, believed by its bytes — JPEG too", async () => {
  let disposed = 0
  const host = (status: string, bytes?: Uint8Array, mimeType = "image/png") => () => ({
    read: async (o: { preferredTypes: readonly string[] }) => {
      expect(o.preferredTypes).toEqual(["image/png", "image/jpeg", "image/webp", "image/gif"])
      return { status, ...(bytes ? { representation: { mimeType, bytes } } : {}) }
    },
    dispose: async () => void disposed++,
  })
  const none = { env: {}, which: () => null }
  expect(await clipboardImage({ ...none, host: host("read", JPEG, "image/png") })).toEqual({ status: "read", mime: "image/jpeg", bytes: JPEG })
  expect(await clipboardImage({ ...none, host: host("empty") })).toEqual({ status: "empty" })
  expect(await clipboardImage({ ...none, host: host("unsupported") })).toEqual({ status: "unsupported" })
  expect(await clipboardImage({ ...none, host: host("limit-exceeded") })).toEqual({ status: "too-large" })
  // Text on the clipboard handed over as an "image" is not one.
  expect(await clipboardImage({ ...none, host: host("read", Buffer.from("plain text, not a picture")) })).toEqual({ status: "empty" })
  // A host clipboard that cannot even be made (no native library): the programs, here none.
  expect(
    await clipboardImage({
      ...none,
      host: () => {
        throw new Error("no native clipboard")
      },
    }),
  ).toEqual({ status: "unsupported" })
  expect(disposed).toBe(5)
})

test("the clipboard: where the host clipboard has nothing, xclip on the display there is (ssh -X)", async () => {
  expect(clipboardCommands({}, () => "/usr/bin/x").length).toBe(0)
  expect(clipboardCommands({ DISPLAY: "localhost:10.0" }, () => "/usr/bin/x").map((c) => c("image/png")[0])).toEqual(["xclip"])
  expect(clipboardCommands({ WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" }, () => "/usr/bin/x").map((c) => c("image/png")[0])).toEqual(["wl-paste", "xclip"])
  expect(clipboardCommands({ DISPLAY: ":0" }, () => null)).toEqual([])
  // A stand-in xclip that has a JPEG and no PNG.
  const bin = mkdtempSync(join(tmpdir(), "lembas-clip-"))
  writeFileSync(join(bin, "pic.jpg"), JPEG)
  writeFileSync(join(bin, "xclip"), `#!/bin/sh\ncase "$*" in *image/jpeg*) cat "${bin}/pic.jpg";; *) exit 1;; esac\n`)
  chmodSync(join(bin, "xclip"), 0o755)
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path}`
  try {
    const empty = () => ({ read: async () => ({ status: "empty" }), dispose: async () => {} })
    const r = await clipboardImage({ env: { DISPLAY: "localhost:10.0" }, which: (c) => (c === "xclip" ? join(bin, "xclip") : null), host: empty })
    expect(r).toEqual({ status: "read", mime: "image/jpeg", bytes: new Uint8Array(JPEG) })
  } finally {
    process.env.PATH = path
  }
})

test("pasted images are saved by kind, and old ones are cleaned up — nothing else in the folder", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "lembas-clip-")), "clipboard")
  const a = savePastedImage(dir, PNG, "image/png")
  const b = savePastedImage(dir, JPEG, "image/jpeg")
  expect(a).toMatch(/paste-\d+-\d+\.png$/)
  expect(b).toMatch(/paste-\d+-\d+\.jpg$/)
  expect(a).not.toBe(b)
  expect(readFileSync(b).equals(JPEG)).toBe(true)
  writeFileSync(join(dir, "notes.txt"), "mine")
  const old = new Date(Date.now() - 9 * 86_400_000)
  utimesSync(a, old, old)
  utimesSync(join(dir, "notes.txt"), old, old)
  expect(cleanPastedImages(dir)).toBe(1)
  expect(readdirSync(dir).sort()).toEqual([b.split("/").pop()!, "notes.txt"].sort())
  expect(existsSync(a)).toBe(false)
  expect(cleanPastedImages(join(dir, "missing"))).toBe(0)
})

// A terminal that speaks kitty's clipboard protocol, as its specification describes it.
function kitty(clipboard: Record<string, Uint8Array>, o: { deny?: boolean; silent?: boolean; echoId?: boolean; bel?: boolean; busy?: boolean } = {}) {
  const handlers = new Set<(s: string) => void>()
  const wrote: string[] = []
  const end = o.bel ? "\x07" : "\x1b\\"
  const send = (meta: string, payload = "") => queueMicrotask(() => handlers.forEach((h) => h(`\x1b]5522;${meta}${payload ? `;${payload}` : ""}${end}`)))
  const b64 = (s: string | Uint8Array) => Buffer.from(s as never).toString("base64")
  const term: OscTerminal = {
    subscribeOsc: (h) => (handlers.add(h), () => void handlers.delete(h)),
    write(data) {
      wrote.push(data)
      if (o.silent) return
      const p = parse5522(data)!
      const id = o.echoId === false ? "" : `:id=${p.meta.id}`
      const want = Buffer.from(p.payload, "base64").toString("utf8")
      if (o.busy) return send(`type=read:status=EBUSY${id}`)
      if (want === ".") {
        send(`type=read:status=OK${id}`)
        send(`type=read:status=DATA:mime=${b64(".")}${id}`, b64(Object.keys(clipboard).join(" ")))
        return send(`type=read:status=DONE${id}`)
      }
      if (o.deny) return send(`type=read:status=EPERM${id}`)
      send(`type=read:status=OK${id}`)
      for (const mime of want.split(" ")) {
        const bytes = clipboard[mime]
        if (!bytes) continue
        // Chunks of at most 4096 bytes, each padded on its own.
        for (let at = 0; at < bytes.length; at += 4096) send(`type=read:status=DATA:mime=${b64(mime)}${id}`, b64(bytes.subarray(at, at + 4096)))
      }
      send(`type=read:status=DONE${id}`)
    },
  }
  return { term, wrote, listeners: () => handlers.size }
}

const TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"]

test("kitty's clipboard protocol: the kinds are listed, the first image kind is read in chunks and put together", async () => {
  // Larger than two chunks, and not a multiple of three: every chunk's padding matters.
  const big = Buffer.concat([JPEG, Buffer.from(Array.from({ length: 10_001 }, (_, i) => i % 251))])
  const k = kitty({ "text/plain": Buffer.from("words"), "image/jpeg": big })
  const r = await kittyReadImage(k.term, { types: TYPES, password: "secret", name: "LLeMbas CLI" })
  expect(r.status).toBe("read")
  expect(r).toMatchObject({ mime: "image/jpeg" })
  expect(Buffer.from((r as { bytes: Uint8Array }).bytes).equals(big)).toBe(true)
  // The listing asks for "." and carries no password; the read names the kind and who asks.
  expect(parse5522(k.wrote[0]!)).toMatchObject({ meta: { type: "read" }, payload: Buffer.from(".").toString("base64") })
  expect(k.wrote[0]).not.toContain("pw=")
  const read = parse5522(k.wrote[1]!)!
  expect(Buffer.from(read.payload, "base64").toString()).toBe("image/jpeg")
  expect(Buffer.from(read.meta.pw!, "base64").toString()).toBe("secret")
  expect(Buffer.from(read.meta.name!, "base64").toString()).toBe("LLeMbas CLI")
  expect(read.meta.id).toMatch(/^[a-zA-Z0-9\-_+.]+$/)
  expect(k.wrote.every((w) => w.startsWith("\x1b]5522;") && w.endsWith("\x1b\\"))).toBe(true)
  expect(k.listeners()).toBe(0) // nothing left listening
})

test("kitty's clipboard protocol: no image, a refusal, a busy multiplexer, BEL terminators, no id echoed", async () => {
  expect(await kittyReadImage(kitty({ "text/plain": Buffer.from("words") }).term, { types: TYPES })).toEqual({ status: "empty" })
  expect(await kittyReadImage(kitty({ "image/png": PNG }, { deny: true }).term, { types: TYPES })).toEqual({ status: "denied" })
  expect(await kittyReadImage(kitty({ "image/png": PNG }, { busy: true }).term, { types: TYPES })).toEqual({ status: "busy" })
  const r = await kittyReadImage(kitty({ "image/png": PNG }, { bel: true, echoId: false }).term, { types: TYPES })
  expect(r).toMatchObject({ status: "read", mime: "image/png" })
  expect(Buffer.from((r as { bytes: Uint8Array }).bytes).equals(PNG)).toBe(true)
  expect(await kittyReadImage(kitty({ "image/png": Buffer.alloc(9000) }).term, { types: TYPES, maxBytes: 8000 })).toEqual({ status: "too-large" })
})

test("kitty's clipboard protocol: a terminal that says nothing does not speak it, and nobody waits long", async () => {
  const k = kitty({}, { silent: true })
  const t0 = performance.now()
  expect(await kittyReadImage(k.term, { types: TYPES, listTimeoutMs: 80 })).toEqual({ status: "unsupported" })
  expect(performance.now() - t0).toBeLessThan(1000)
  expect(k.wrote.length).toBe(1) // the read was never asked
  expect(k.listeners()).toBe(0)
  // Another program's reply (a different id) is not taken for ours.
  const handlers = new Set<(s: string) => void>()
  const other: OscTerminal = { subscribeOsc: (h) => (handlers.add(h), () => void handlers.delete(h)), write: () => queueMicrotask(() => handlers.forEach((h) => h("\x1b]5522;type=read:status=DONE:id=someone-else\x1b\\"))) }
  expect(await kittyReadImage(other, { types: TYPES, listTimeoutMs: 80 })).toEqual({ status: "unsupported" })
})

test("which terminals are asked: kitty, also through ssh; never inside a multiplexer", () => {
  expect(kittyClipboardLikely({ TERM: "xterm-kitty" })).toBe(true)
  expect(kittyClipboardLikely({ TERM: "xterm-256color", KITTY_WINDOW_ID: "3" })).toBe(true)
  expect(kittyClipboardLikely({ TERM: "xterm-256color" })).toBe(false)
  expect(kittyClipboardLikely({ TERM: "xterm-kitty", TMUX: "/tmp/tmux-1000/default,1,0" })).toBe(false)
  expect(kittyClipboardLikely({})).toBe(false)
  expect(parse5522("\x1b]52;c;aGk=\x07")).toBeUndefined()
  expect(parse5522("\x1b]5522;type=read:status=DATA:mime=aW1hZ2UvcG5n;QUJD\x07")).toEqual({ meta: { type: "read", status: "DATA", mime: "aW1hZ2UvcG5n" }, payload: "QUJD" })
})
