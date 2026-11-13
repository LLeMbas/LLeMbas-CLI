// A page is static (harness pages.md §6): HTML, CSS and inline SVG, nothing that runs and nothing
// that reaches anywhere. This says what in a page breaks that rule, by the spec's lists
// (loop.json pages.static) — the rule as the conformance cases pin it. A terminal shows no page,
// so nothing here is a sanitiser: a client that shows pages rebuilds the document with a real
// parser.
import { LOOP } from "../harness.ts"

const S = LOOP.pages.static
const ELEMENTS = new Set(S.elements.map((e) => e.toLowerCase()))
const ATTRIBUTES = new Set(S.attributes.map((a) => a.toLowerCase()))
const IMAGE = new RegExp(`^data:image/(?:${S.image_types.join("|")});base64,`, "i")

/** Whether an address is one of the two a page may hold: `#fragment`, or an inline picture. */
export const addressAllowed = (v: string) => /^#/.test(v.trim()) || IMAGE.test(v.trim())

/** What CSS would fetch: `@import`, and any url() that is not an allowed address. */
function cssFaults(css: string): string[] {
  const out: string[] = []
  if (/@import\b/i.test(css)) out.push("css:import")
  for (const m of css.matchAll(/url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi)) if (!addressAllowed(m[2]!)) out.push("css:url")
  return out
}

/** What makes a page not static, each thing once, in the order first met; none: it is static. */
export function staticFaults(html: string): string[] {
  const why: string[] = []
  const say = (w: string) => void (why.includes(w) || why.push(w))
  const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g
  let style = -1
  for (const m of html.matchAll(TAG)) {
    const name = m[2]!.toLowerCase()
    if (m[1]) {
      if (name === "style" && style >= 0) {
        for (const f of cssFaults(html.slice(style, m.index))) say(f)
        style = -1
      }
      continue
    }
    if (!ELEMENTS.has(name)) {
      say(`element:${name}`)
      continue
    }
    if (name === "style") style = m.index! + m[0].length
    for (const a of m[3]!.matchAll(/([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
      const attr = a[1]!.toLowerCase()
      const value = a[2] ?? a[3] ?? a[4] ?? ""
      if (!ATTRIBUTES.has(attr) && !S.attribute_prefixes.some((p) => attr.startsWith(p))) {
        say(`attribute:${attr}`)
        continue
      }
      if (S.address_attributes.includes(attr) && !addressAllowed(value)) say(`address:${attr}`)
      if (attr === "style") for (const f of cssFaults(value)) say(f)
    }
  }
  return why
}
