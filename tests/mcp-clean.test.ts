// What an MCP server says is somebody else's text: control characters never reach a terminal,
// what the config resolved to (credentials in an address, a local server's arguments) never
// leaves in `/mcp`'s text, and a description cannot put markup into a reply.
import { expect, test } from "bun:test"
import { clean, errorLine, mdEscape, redactSecrets, redactUrl, redactUrls } from "../src/mcp/clean.ts"
import { McpManager, promptCommand, type ServerState } from "../src/mcp/index.ts"
import { mcpText, whereOf } from "../src/mcp/text.ts"
import { noteNeedsAttention } from "../src/session/engine.ts"

const ESC = "\x1b"

test("control characters are taken out: escape sequences whole, the rest one by one", () => {
  expect(clean(`red ${ESC}[31mtext${ESC}[0m`)).toBe("red text")
  expect(clean(`title ${ESC}]0;owned${"\x07"} here`)).toBe("title  here")
  expect(clean(`clip ${ESC}]52;c;aGk=${ESC}\\ x`)).toBe("clip  x")
  expect(clean(`a\rb\x00c\x08d\x7fe\u009b31mf`)).toBe("a bcdef")
  expect(clean("two\nlines\tand a tab")).toBe("two lines and a tab")
  expect(clean("two\nlines", true)).toBe("two\nlines")
  expect(clean(`cursor ${ESC}[2J${ESC}[H home`, true)).toBe("cursor  home")
  // Text direction overrides and the like are invisible ways to say something else.
  expect(clean("safe‮gnp.exe")).toBe("safegnp.exe")
  expect(clean(undefined)).toBe("")
  expect(clean(42)).toBe("42")
})

test("addresses and errors without what may be secret in them", () => {
  expect(redactUrl("https://user:hunter2@example.org:8443/mcp?token=abc123&x=1#frag")).toBe("https://example.org:8443/mcp?…")
  expect(redactUrl("https://example.org/mcp")).toBe("https://example.org/mcp")
  expect(redactUrls("fetch https://bob:pw@example.org/a?key=zzz failed")).toBe("fetch https://example.org/a?… failed")
  expect(redactSecrets("401 for Authorization: Bearer abcdef0123456789xyz")).not.toContain("abcdef0123456789xyz")
  expect(redactSecrets("api_key=sk-test-1234567890 was refused")).toBe("api_key=[redacted] was refused")
  expect(redactSecrets('token: "t0psecretvalue"')).not.toContain("t0psecretvalue")
  expect(redactSecrets("id 0123456789abcdef0123456789abcdef0123 not found")).toBe("id [redacted] not found")
  expect(redactSecrets("connect ECONNREFUSED 127.0.0.1:9")).toBe("connect ECONNREFUSED 127.0.0.1:9")
  expect(errorLine(`first ${ESC}[31mline\nsecond line with password=hunter2`)).toBe("first line")
  expect(errorLine("x".repeat(400)).length).toBeLessThanOrEqual(200)
  expect(mdEscape("see [here](https://example.org) ![x](y) <b> `c` *e*")).toBe("see \\[here\\]\\(https://example.org\\) \\!\\[x\\]\\(y\\) \\<b\\> \\`c\\` \\*e\\*")
})

function server(name: string, o: Partial<ServerState> = {}): ServerState {
  return { name, cfg: { url: `https://example.org/${name}`, source: "global" } as never, status: "connected", tools: [], prompts: [], resources: false, stderr: [], gen: 0, ...o }
}
function manager(...servers: ServerState[]): McpManager {
  const m = new McpManager({}, { root: "/tmp", version: "0" } as never)
  for (const s of servers) m.servers.set(s.name, s)
  m.tools()
  return m
}

test("/mcp's text does not leak what the config resolved to, nor a server's stderr, nor more than one line of an error", () => {
  const m = manager(
    server("remote", { cfg: { url: "https://alice:s3cret@example.org/mcp?api_key=abcdef", source: "global" } as never, status: "failed", error: `could not reach https://alice:s3cret@example.org/mcp?api_key=abcdef\nstack line two\nBearer zzzzzzzzzzzzzzzz`, stderr: ["TOKEN=verysecretvalue loaded"] }),
    server("local", { cfg: { command: ["/opt/tools/bin/files-server", "--token", "tok_live_123456", "/home/someone/private"], source: "project" } as never }),
  )
  const list = mcpText(m)
  const remote = mcpText(m, "remote")
  const local = mcpText(m, "local")
  for (const text of [list, remote, local]) {
    for (const secret of ["s3cret", "alice", "abcdef", "tok_live_123456", "/home/someone/private", "--token", "verysecretvalue", "stack line two", "zzzzzzzzzzzzzzzz"]) expect(text).not.toContain(secret)
  }
  expect(remote).toContain("https://example.org/mcp?…")
  expect(remote).toContain("failed: could not reach https://example.org/mcp?…")
  expect(local).toContain("local: files-server")
  expect(whereOf(m.servers.get("local")!)).toBe("local: files-server")
})

test("a server's own strings are cleaned before they are printed, and escaped where the text is markdown", () => {
  const hostile = server("evil", {
    tools: [{ name: `wipe${ESC}[2J`, description: `Helpful ${ESC}]0;pwned${"\x07"}tool. [click](https://example.org/x) ![img](https://example.org/p.png)\nsecond line`, inputSchema: {} }],
    prompts: [{ name: "do it", description: `run ${ESC}[31mnow <script>` }],
  })
  const m = manager(hostile)
  const plain = mcpText(m, "evil")
  const md = mcpText(m, "evil", () => undefined, { markdown: true })
  for (const text of [plain, md]) {
    expect(text).not.toContain(ESC)
    expect(text).not.toContain("\x07")
    expect(text).not.toContain("pwned")
    expect(text).not.toContain("second line")
  }
  // Markdown: a name is code, a description has no live markup.
  expect(md).toContain("- `mcp__evil__wipe__2J` — asks — Helpful tool. \\[click\\]\\(https://example.org/x\\) \\!\\[img\\]\\(https://example.org/p.png\\)")
  expect(md).not.toMatch(/(^|[^\\])\[click\]\(/)
  expect(md).toContain("\\<script\\>")
  // Plain: as it reads.
  expect(plain).toContain("- mcp__evil__wipe__2J — asks — Helpful tool. [click](https://example.org/x)")
  // A prompt is listed by the name the command is registered under.
  expect(promptCommand("evil", "do it")).toBe("evil:do_it")
  expect(plain).toContain("- /evil:do_it — run now <script>")
  expect(m.prompts().map((p) => p.name)).toEqual(["evil:do_it"])
})

test("tools whose names come out the same both get a hash, whatever order the server lists them in; a library server's other tools are not bare", () => {
  const a = { name: "get.user", description: "one", inputSchema: {} }
  const b = { name: "get_user", description: "two", inputSchema: {} }
  const one = manager(server("s", { tools: [a, b] }))
  const two = manager(server("s", { tools: [b, a] }))
  const names = (m: McpManager) => [m.nameOf("s", "get.user"), m.nameOf("s", "get_user")]
  expect(names(one)).toEqual(names(two))
  expect(names(one)[0]).not.toBe(names(one)[1])
  // Neither keeps the plain name the other could later inherit.
  expect(names(one)).not.toContain("mcp__s__get_user")
  expect(names(one).every((n) => /^mcp__s__get_user_[0-9a-f]{8}$/.test(n))).toBe(true)
  // A tool with nobody to collide with keeps its plain name.
  expect(manager(server("s", { tools: [a] })).nameOf("s", "get.user")).toBe("mcp__s__get_user")
  // The LLeMbas server's library: the tool it is there for goes by the bare name; anything else
  // it offered is an MCP tool with a name of its own — never a built-in tool's.
  const lib = manager(server("lembas-library", { cfg: { url: "https://example.org/mcp", source: "global", tools: { include: ["memory"] } } as never, tools: [{ name: "memory", inputSchema: {} }, { name: "bash", inputSchema: {} }] }))
  expect(lib.nameOf("lembas-library", "memory")).toBe("memory")
  expect(lib.nameOf("lembas-library", "bash")).toBe("mcp__lembas-library__bash")
  expect(lib.tools().map((t) => t.name).sort()).toEqual(["mcp__lembas-library__bash", "memory"])
})

test("a finished job's line keeps the warning sign only when it did not end well", () => {
  expect(noteNeedsAttention("job1 (make test) exited with 0 after 12s.")).toBe(false)
  expect(noteNeedsAttention("job1 (make test) exited with 2 after 12s.")).toBe(true)
  expect(noteNeedsAttention("job2 (sleep 90) stopped (SIGTERM) after 3s.")).toBe(true)
  expect(noteNeedsAttention("job3 (explore: find the callers) finished after 40s.")).toBe(false)
  expect(noteNeedsAttention("job4 (explore) failed: the model did not answer")).toBe(true)
  expect(noteNeedsAttention("job5 was lost when the program restarted")).toBe(true)
})
