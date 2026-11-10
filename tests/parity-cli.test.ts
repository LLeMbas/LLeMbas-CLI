// The CLI's gaps from the feature-parity audit: the finished-reply notice, /search over its own
// sessions, /rename, and the server's memory in /memory.
import { expect, test } from "bun:test"
import { Store } from "../src/session/store.ts"
import { searchSessions } from "../src/tool/session_search.ts"
import { serverEntries } from "../src/tui/commands.ts"
import { FocusWatch, noticeSequence, noticeText } from "../src/tui/notify.ts"

test("the notice names the session and what happened, never the reply, without control bytes", () => {
  expect(noticeText("Fix the router", "finished")).toBe("Fix the router: finished")
  expect(noticeText(undefined, "waiting")).toBe("LLeMbas: waits for you")
  expect(noticeText("a\u001b]0;evil\u0007b", "failed")).toBe("a ]0;evil b: stopped with an error")
  expect(noticeSequence("x; y")).toBe("\x1b]9;x  y\x07\x07")
})

test("FocusWatch: focused until the terminal says it lost focus", () => {
  const handlers: Record<string, () => void> = {}
  const w = new FocusWatch((ev, fn) => (handlers[ev] = fn))
  expect(w.focused).toBe(true)
  handlers.blur!()
  expect(w.focused).toBe(false)
  handlers.focus!()
  expect(w.focused).toBe(true)
})

test("searchSessions: the best hit per session, this project's or every one, the current left out", () => {
  const store = new Store(":memory:")
  const a = store.createSession("/p", "m")
  const b = store.createSession("/p", "m")
  const c = store.createSession("/q", "m")
  store.append(a.id, { role: "user", parts: [{ type: "text", text: "the waybread recipe needs honey" }] })
  store.append(b.id, { role: "user", parts: [{ type: "text", text: "fix the router" }] })
  store.append(b.id, { role: "assistant", parts: [{ type: "text", text: "the router now handles waybread routes" }] })
  store.append(c.id, { role: "user", parts: [{ type: "text", text: "waybread in another project" }] })
  const here = searchSessions(store, "waybread", { root: "/p" })
  expect(here.map((h) => h.id).sort()).toEqual([a.id, b.id].sort())
  expect(here.find((h) => h.id === b.id)!.snippet).toContain("waybread")
  expect(searchSessions(store, "waybread").length).toBe(3)
  expect(searchSessions(store, "waybread", { root: "/p", exclude: [a.id] }).map((h) => h.id)).toEqual([b.id])
  // All the words first; any of them when that finds nothing.
  expect(searchSessions(store, "honey nothingelse", { root: "/p" }).map((h) => h.id)).toEqual([a.id])
  expect(searchSessions(store, "  ")).toEqual([])
})

test("serverEntries: the memory block's `- ` lines, continuation lines kept, the 'more' line not an entry", () => {
  expect(serverEntries("- likes tea\n- works on\n  two lines\n- (…3 more, see your settings)")).toEqual(["likes tea", "works on\n  two lines"])
  expect(serverEntries("")).toEqual([])
})
