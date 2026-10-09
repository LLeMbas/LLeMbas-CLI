import { describe, expect, test } from "bun:test"
import { copiedMessage, copyText, hostCopier, type ClipboardRenderer } from "../src/tui/clipboard.ts"

const renderer = (osc: "supported" | "unsupported" | "unknown", remote = false) => {
  const sent: string[] = []
  const r: ClipboardRenderer = { capabilities: { remote, osc52_support: osc }, copyToClipboardOSC52: (t) => (sent.push(t), true) }
  return { r, sent }
}

describe("copying", () => {
  test("over SSH: OSC 52 only — the local clipboard is the wrong machine's", () => {
    const { r, sent } = renderer("unknown")
    const c = copyText(r, "hello", { SSH_CONNECTION: "1.2.3.4 5 6.7.8.9 22" }, ["wl-copy"], () => {
      throw new Error("must not run over SSH")
    })
    expect(sent).toEqual(["hello"])
    expect(c).toEqual({ via: ["terminal?"], remote: true })
  })

  test("a terminal known not to take OSC 52 is not sent it", () => {
    const { r, sent } = renderer("unsupported", true)
    expect(copyText(r, "x", {}, undefined).via).toEqual([])
    expect(sent).toEqual([])
  })

  test("on this machine the system clipboard is used as well", () => {
    const { r } = renderer("supported")
    const ran: string[][] = []
    expect(copyText(r, "x", {}, ["wl-copy"], (cmd, text) => void ran.push([...cmd, text])).via).toEqual(["terminal", "system"])
    expect(ran).toEqual([["wl-copy", "x"]])
  })

  test("the clipboard program follows the display", () => {
    const has = (...cmds: string[]) => (c: string) => (cmds.includes(c) ? `/usr/bin/${c}` : null)
    expect(hostCopier({ WAYLAND_DISPLAY: "wayland-0" }, has("wl-copy", "xclip"), "linux")).toEqual(["wl-copy"])
    expect(hostCopier({ DISPLAY: ":0" }, has("xsel"), "linux")).toEqual(["xsel", "--clipboard", "--input"])
    expect(hostCopier({}, has("wl-copy", "xclip"), "linux")).toBeUndefined()
  })

  test("a copy that went out says so plainly — no warning on an unknown terminal; only one that went nowhere says what to do", () => {
    expect(copiedMessage(12, { via: ["terminal"], remote: true })).toEqual({ text: "copied 12 characters", warn: false })
    // LXTerminal over SSH: the probe said "unknown", the copy arrived, and no warning is due.
    expect(copiedMessage(1200, { via: ["terminal?"], remote: true })).toEqual({ text: "copied 1,200 characters", warn: false })
    expect(copiedMessage(5, { via: ["system"], remote: false })).toEqual({ text: "copied 5 characters", warn: false })
    const none = copiedMessage(3, { via: [], remote: true })
    expect(none.warn).toBe(true)
    expect(none.text).toContain("hold Shift while you drag")
  })
})
