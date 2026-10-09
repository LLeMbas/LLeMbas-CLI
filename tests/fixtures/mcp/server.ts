// A small MCP server for the tests, on the SDK's own server side: stdio by default, or streamable
// HTTP on the port given with --http <port> (checking a bearer token when TOKEN is set).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { z } from "zod"

function build() {
  const s = new McpServer({ name: "fixture", version: "1.0.0" }, { instructions: "Use echo to repeat things back. The secret word is lantern." })
  s.registerTool("echo", { description: "Repeat the text", inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } }, async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }))
  s.registerTool("fail", { description: "Always fails", inputSchema: {} }, async () => ({ isError: true, content: [{ type: "text", text: "it broke" }] }))
  s.registerTool("picture", { description: "A 1×1 PNG", inputSchema: {} }, async () => ({
    content: [
      { type: "text", text: "here it is" },
      { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" },
    ],
  }))
  s.registerTool("env", { description: "Show an environment variable", inputSchema: { name: z.string() } }, async ({ name }) => ({ content: [{ type: "text", text: `${name}=${process.env[name] ?? "(unset)"}` }] }))
  s.registerTool("structured", { description: "Structured only", inputSchema: {}, outputSchema: { n: z.number() } }, async () => ({ content: [], structuredContent: { n: 42 } }))
  s.registerPrompt("greet", { description: "Greet someone", argsSchema: { name: z.string(), style: z.string().optional() } }, ({ name, style }) => ({
    messages: [{ role: "user", content: { type: "text", text: `Say hello to ${name}${style ? `, ${style}` : ""}.` } }],
  }))
  // A prompt that names a local file the way a user attaches one: it must not be attached.
  s.registerPrompt("peek", { description: "Look at a file", argsSchema: { path: z.string() } }, ({ path }) => ({
    messages: [{ role: "user", content: { type: "text", text: `Look at @${path} please.` } }],
  }))
  s.registerResource("note", "note://one", { description: "A note", mimeType: "text/plain" }, async (uri) => ({ contents: [{ uri: uri.href, text: "the note's text" }] }))
  return s
}

const i = process.argv.indexOf("--http")
if (i < 0) await build().connect(new StdioServerTransport())
else {
  const port = Number(process.argv[i + 1])
  const token = process.env.TOKEN
  Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (token && req.headers.get("authorization") !== `Bearer ${token}`) return new Response("unauthorized", { status: 401 })
      // Stateless: a fresh server and transport per request.
      const t = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      await build().connect(t)
      return t.handleRequest(req)
    },
  })
  console.log("ready")
}
