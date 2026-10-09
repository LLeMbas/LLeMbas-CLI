// A stand-in microphone: raw 16 kHz mono s16le on stdout — `tone` seconds of a loud 440 Hz tone,
// then silence until killed (or for `silence` seconds). Paced at 10× real time.
const [tone = "1", silence = "-1"] = process.argv.slice(2)
const RATE = 16000
const chunk = (loud: boolean, n: number, t0: number) => {
  const b = new Uint8Array(n * 2)
  const d = new DataView(b.buffer)
  for (let i = 0; i < n; i++) d.setInt16(i * 2, loud ? Math.round(8000 * Math.sin((2 * Math.PI * 440 * (t0 + i)) / RATE)) : 0, true)
  return b
}
process.on("SIGINT", () => process.exit(0))
const step = RATE / 10 // 0.1 s
let t = 0
while (true) {
  const loud = t < Number(tone) * RATE
  if (!loud && Number(silence) >= 0 && t >= (Number(tone) + Number(silence)) * RATE) break
  process.stdout.write(chunk(loud, step, t))
  t += step
  await Bun.sleep(10)
}

export {}
