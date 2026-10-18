// Server-sent events → parsed JSON objects. Keep-alive comments and non-data lines are skipped;
// a malformed frame is skipped rather than killing the reply (LLeMbas generation.py, the same rule).
// Errors are surfaced in every shape seen in the wild — see the comments in `line()`.
export async function* sseJson(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event?: string; data: unknown }> {
  const decoder = new TextDecoder()
  let buf = ""
  let event: string | undefined
  let data: string[] = []
  const out: { event?: string; data: unknown }[] = []

  const dispatch = () => {
    if (data.length === 0) return
    const raw = data.join("\n")
    data = []
    const ev = event
    event = undefined
    if (raw === "[DONE]") return
    try {
      out.push({ event: ev, data: JSON.parse(raw) as unknown })
    } catch {
      // unparseable frame: skip
    }
  }

  const line = (l: string) => {
    if (l.endsWith("\r")) l = l.slice(0, -1)
    if (l === "") return dispatch()
    if (l.startsWith(":")) return
    // llama.cpp (seen behind llama-swap) writes a mid-stream failure as a bare JSON line with no
    // field name: `{"error":{"code":500,"message":"…"}}` — and as the stream's LAST line, with no
    // newline after it. By the SSE rules it is a field called `{"error"` and would be ignored,
    // silently ending the reply.
    if (l.startsWith("{")) {
      try {
        const bare = JSON.parse(l) as unknown
        if (bare && typeof bare === "object" && "error" in bare) {
          dispatch()
          out.push({ event: "error", data: bare })
          return
        }
      } catch {}
    }
    const colon = l.indexOf(":")
    const field = colon === -1 ? l : l.slice(0, colon)
    let value = colon === -1 ? "" : l.slice(colon + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    if (field === "data") {
      // Some servers omit the blank line between events; a complete JSON frame on its own
      // `data:` line is dispatched before the next one starts.
      if (data.length > 0 && isJson(data.join("\n"))) dispatch()
      data.push(value)
    } else if (field === "event") event = value
    else if (field === "error") {
      // Some servers name the field `error:`. Same treatment as the bare JSON line.
      let parsed: unknown = value
      try {
        parsed = JSON.parse(value)
      } catch {}
      dispatch()
      out.push({ event: "error", data: parsed && typeof parsed === "object" && "error" in parsed ? parsed : { error: parsed } })
    }
  }

  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true })
    let nl: number
    while ((nl = buf.indexOf("\n")) !== -1) {
      line(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
    }
    yield* out.splice(0)
  }
  buf += decoder.decode()
  // The last line may have no newline after it — and that is exactly where an error lands.
  if (buf) line(buf)
  dispatch()
  yield* out.splice(0)
}

function isJson(s: string): boolean {
  try {
    JSON.parse(s)
    return true
  } catch {
    return false
  }
}
