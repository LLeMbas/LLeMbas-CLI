// A diff's long lines stay inside their background. Left to fill its box, OpenTUI's diff wrapped
// at a width measured before the transcript's scrollbar took its column, so once the transcript
// outgrew the screen a long line ran one column past its colour.
import { afterEach, expect, test } from "bun:test"
import { delta, toolCall } from "../fake-provider.ts"
import { tui } from "./harness.tsx"

let t: Awaited<ReturnType<typeof tui>> | undefined
afterEach(() => t?.stop())

const LONG = "const created=await new Promise((res,rej)=>{const r=http.request({host:'127.0.0.1',port:PORT,path:'/json/new',method:'PUT',headers:{'Content-Type':'application/json'}},e=>{let b='';e.on('data',d=>b+=d);e.on('end',()=>res(JSON.parse(b)))},rej);r.end('{}');});"
const FILE = Array.from({ length: 27 }, (_, i) => (i % 6 === 3 ? `${LONG} // ${i}` : `const v${i}=${i};`)).join("\n") + "\n"

/** Rows where text reaches past the diff's green, the last column (the scrollbar) aside. */
function overruns(): string[] {
  const f = t!.setup.captureSpans()
  const bad: string[] = []
  f.lines.forEach((l, y) => {
    let x = 0
    let green = -1
    let text = -1
    for (const s of l.spans) {
      const chars = [...s.text]
      for (let i = 0; i < s.width; i++) {
        if (s.bg.a > 0 && s.bg.g > s.bg.r + 0.03) green = x + i
        if ((chars[i] ?? " ").trim() && x + i < f.cols - 1) text = x + i
      }
      x += s.width
    }
    if (green >= 0 && text > green) bad.push(`row ${y}: text to ${text}, green to ${green}`)
  })
  return bad
}
const greenRows = () => t!.setup.captureSpans().lines.filter((l) => l.spans.some((s) => s.bg.a > 0 && s.bg.g > s.bg.r + 0.03)).length

test("a written file's long lines wrap inside their background — before and after the scrollbar shows up", async () => {
  t = await tui(
    [
      { chunks: [toolCall(0, "w1", "write", JSON.stringify({ path: "diag.js", content: FILE }))] },
      { gapMs: 150, chunks: [delta({ content: "start\n\n" }), delta({ content: Array.from({ length: 40 }, (_, i) => `para ${i}`).join("\n\n") + "\n\nok" }, "stop")] },
    ],
    { width: 150, height: 60 },
  )
  t.app.engine.mode = "edit"
  await t.input.typeText("go")
  t.input.pressEnter()
  expect(await t.until("start")).toBe(true)
  await t.settle()
  expect(greenRows()).toBeGreaterThan(20)
  expect(overruns()).toEqual([])
  // The transcript outgrows the screen: the scrollbar takes a column. Back up to the diff.
  expect(await t.until("ok")).toBe(true)
  await t.settle()
  let seen = 0
  for (let i = 0; i < 4; i++) {
    t.input.pressKey("\u001b[5~")
    await t.settle()
    await Bun.sleep(30)
    await t.settle()
    seen += greenRows()
    expect(overruns()).toEqual([])
  }
  expect(seen).toBeGreaterThan(0)
})
