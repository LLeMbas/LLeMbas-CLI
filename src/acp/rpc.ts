// JSON-RPC 2.0 over lines: the framing ACP uses on stdio, and what the LLeMbas link carries one
// message per WebSocket frame. Both ends may call and both may be called; a request waits for the
// answer with the same id. Written here rather than taken from the ACP SDK so the same few rules
// are what LLeMbas implements in Python, and nothing about them is hidden in a dependency.

export interface Transport {
  send(text: string): void
  onMessage(fn: (text: string) => void): void
  onClose(fn: () => void): void
  close(): void
}

export class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(message)
  }
}

export const PARSE_ERROR = -32700
export const METHOD_NOT_FOUND = -32601
export const INVALID_PARAMS = -32602
export const INTERNAL_ERROR = -32603

type Handler = (params: any) => unknown | Promise<unknown>

export class Peer {
  private handlers = new Map<string, Handler>()
  private notices = new Map<string, Handler>()
  private waiting = new Map<number | string, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private seq = 0
  private closed = false
  private closers: (() => void)[] = []

  constructor(private t: Transport) {
    t.onMessage((text) => void this.receive(text))
    t.onClose(() => {
      this.closed = true
      for (const w of this.waiting.values()) w.reject(new RpcError(INTERNAL_ERROR, "the connection closed"))
      this.waiting.clear()
      for (const fn of this.closers) fn()
    })
  }

  /** Answer `method` requests. */
  handle(method: string, fn: Handler) {
    this.handlers.set(method, fn)
  }

  /** React to `method` notifications. */
  on(method: string, fn: Handler) {
    this.notices.set(method, fn)
  }

  onClose(fn: () => void) {
    this.closers.push(fn)
  }

  get isClosed() {
    return this.closed
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.closed) return Promise.reject(new RpcError(INTERNAL_ERROR, "the connection is closed"))
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      if (timeoutMs)
        timer = setTimeout(() => {
          this.waiting.delete(id)
          reject(new RpcError(INTERNAL_ERROR, `${method}: no answer in ${Math.round(timeoutMs / 1000)}s`))
        }, timeoutMs)
      this.waiting.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      })
      this.write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })
    })
  }

  notify(method: string, params?: unknown) {
    if (this.closed) return
    this.write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) })
  }

  close() {
    this.t.close()
  }

  private write(message: unknown) {
    try {
      this.t.send(JSON.stringify(message))
    } catch {}
  }

  private async receive(text: string) {
    let msg: any
    try {
      msg = JSON.parse(text)
    } catch {
      return this.write({ jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "Parse error" } })
    }
    if (!msg || msg.jsonrpc !== "2.0") return
    // An answer to one of ours.
    if (msg.method === undefined && msg.id !== undefined) {
      const w = this.waiting.get(msg.id)
      if (!w) return
      this.waiting.delete(msg.id)
      if (msg.error) w.reject(new RpcError(msg.error.code ?? INTERNAL_ERROR, msg.error.message ?? "error", msg.error.data))
      else w.resolve(msg.result)
      return
    }
    const method = String(msg.method ?? "")
    // A notification: nothing is answered, even an unknown one.
    if (msg.id === undefined || msg.id === null) {
      const fn = this.notices.get(method)
      if (fn) {
        try {
          await fn(msg.params)
        } catch {}
      }
      return
    }
    const fn = this.handlers.get(method)
    if (!fn) return this.write({ jsonrpc: "2.0", id: msg.id, error: { code: METHOD_NOT_FOUND, message: `Method not found: ${method}` } })
    try {
      const result = await fn(msg.params ?? {})
      this.write({ jsonrpc: "2.0", id: msg.id, result: result ?? null })
    } catch (e) {
      const err = e instanceof RpcError ? e : new RpcError(INTERNAL_ERROR, (e as Error).message)
      this.write({ jsonrpc: "2.0", id: msg.id, error: { code: err.code, message: err.message, ...(err.data === undefined ? {} : { data: err.data }) } })
    }
  }
}

/** Newline-delimited JSON on a pair of streams: ACP over stdio. */
export function stdioTransport(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Transport {
  let onMsg: (t: string) => void = () => {}
  let onEnd: () => void = () => {}
  let buf = ""
  input.setEncoding?.("utf8")
  input.on("data", (chunk: string | Buffer) => {
    buf += chunk.toString()
    let nl: number
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line) onMsg(line)
    }
  })
  input.on("end", () => onEnd())
  return {
    send: (text) => void output.write(text + "\n"),
    onMessage: (fn) => (onMsg = fn),
    onClose: (fn) => (onEnd = fn),
    close: () => onEnd(),
  }
}
