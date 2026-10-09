// An MCP server that is awkward on purpose, on the SDK's low-level side: tool names that collide
// once made safe (get.user, get_user) and one named like a generated tool (read_resource), a
// resource, a tools list whose cursor never ends when started with --loop, and its pid appended
// to the file named by PIDS (to count how many were started).
import { appendFileSync } from "node:fs"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js"

if (process.env.PIDS) appendFileSync(process.env.PIDS, `${process.pid}\n`)
const loop = process.argv.includes("--loop")
const s = new Server({ name: "tricky", version: "1.0.0" }, { capabilities: { tools: {}, resources: {} } })
const tool = (name: string) => ({ name, description: name, inputSchema: { type: "object" as const, properties: {} } })
s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [tool("get.user"), tool("get_user"), tool("read_resource")], ...(loop ? { nextCursor: "same" } : {}) }))
s.setRequestHandler(CallToolRequestSchema, async (r) => ({ content: [{ type: "text", text: `called ${r.params.name}` }] }))
s.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri: "note://x", name: "x" }] }))
s.setRequestHandler(ReadResourceRequestSchema, async (r) => ({ contents: [{ uri: r.params.uri, text: "the resource" }] }))
await s.connect(new StdioServerTransport())
