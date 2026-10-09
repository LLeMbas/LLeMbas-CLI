// A stand-in piper: -m model -f out.wav, the text on stdin; writes a WAV whose data is the text.
const a = process.argv.slice(2)
const out = a[a.indexOf("-f") + 1]!
const model = a[a.indexOf("-m") + 1]!
if (!model.endsWith(".onnx")) {
  console.error("no such model")
  process.exit(2)
}
const text = new TextEncoder().encode(await new Response(Bun.stdin.stream()).text())
await Bun.write(out, new Uint8Array([...new TextEncoder().encode("RIFF"), ...text]))

export {}
