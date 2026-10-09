// A scripted OpenAI-compatible server. Each request takes the next scripted response.
export type Scripted =
  | { status: number; body: string }
  | { chunks: unknown[]; done?: boolean; raw?: string; gapMs?: number }

export interface Fake {
  url: string
  requests: any[]
  /** Path (with query) and headers of each request, in order. */
  calls: { path: string; headers: Record<string, string> }[]
  stop(): void
}

/** `show`: what Ollama's /api/show answers (404 when not given); it takes no scripted response. */
export function fakeProvider(script: Scripted[], opts: { show?: unknown } = {}): Fake {
  const requests: any[] = []
  const calls: { path: string; headers: Record<string, string> }[] = []
  let i = 0
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method !== "POST" || url.pathname.endsWith("/unload")) calls.push({ path: url.pathname + url.search, headers: Object.fromEntries(req.headers.entries()) })
      if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "m1", meta: { n_ctx: 32768 } }, { id: "m2", max_model_len: 8192 }] })
      if (url.pathname.endsWith("/props")) return url.pathname.includes("/upstream/swapped/") ? Response.json({ default_generation_settings: { n_ctx: 16384 } }) : new Response("no", { status: 404 })
      if (url.pathname.endsWith("/unload")) return new Response("ok")
      if (url.pathname.endsWith("/api/show")) return opts.show ? Response.json(opts.show) : new Response("not found", { status: 404 })
      const body = await req.json()
      requests.push(body)
      calls.push({ path: url.pathname + url.search, headers: Object.fromEntries(req.headers.entries()) })
      const r = script[i++]
      if (!r) return new Response("script exhausted", { status: 500 })
      if ("status" in r) return new Response(r.body, { status: r.status })
      // gapMs: a pause between chunks, to look at the screen mid-stream.
      if (r.gapMs && !r.raw) {
        const gap = r.gapMs
        const parts = [...r.chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), ...(r.done === false ? [] : ["data: [DONE]\n\n"])]
        const stream = new ReadableStream({
          async start(ctl) {
            for (const [n, part] of parts.entries()) {
              if (n) await Bun.sleep(gap)
              ctl.enqueue(new TextEncoder().encode(part))
            }
            ctl.close()
          },
        })
        return new Response(stream, { headers: { "content-type": "text/event-stream" } })
      }
      const text = r.raw ?? r.chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + (r.done === false ? "" : "data: [DONE]\n\n")
      return new Response(text, { headers: { "content-type": "text/event-stream" } })
    },
  })
  return { url: `http://127.0.0.1:${server.port}/v1`, requests, calls, stop: () => server.stop(true) }
}

/** Chunk helpers in the OpenAI shape. */
export const delta = (d: Record<string, unknown>, finish: string | null = null) => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] })
export const usage = (p: number, c: number) => ({ choices: [], usage: { prompt_tokens: p, completion_tokens: c } })
export const toolCall = (index: number | undefined, id: string | undefined, name: string | undefined, args: unknown) =>
  delta({ tool_calls: [{ ...(index === undefined ? {} : { index }), ...(id ? { id } : {}), function: { ...(name ? { name } : {}), arguments: args } }] })
