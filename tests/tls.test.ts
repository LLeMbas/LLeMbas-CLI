import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OpenAIChatClient } from "../src/provider/openai-chat.ts"
import type { ResolvedModel } from "../src/provider/types.ts"

// A private CA and a leaf for 127.0.0.1, made with openssl — the shape of a LAN endpoint behind a private CA.
const dir = mkdtempSync(join(tmpdir(), "lembas-tls-"))
const sh = (cmd: string) => {
  const r = Bun.spawnSync(["sh", "-c", cmd], { cwd: dir, stderr: "pipe" })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
}
let server: ReturnType<typeof Bun.serve>

beforeAll(() => {
  sh("openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout ca.key -out ca.crt -days 1 -subj '/CN=Test CA' 2>/dev/null")
  writeFileSync(join(dir, "ext"), "subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\n")
  sh("openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout leaf.key -out leaf.csr -subj '/CN=127.0.0.1' 2>/dev/null")
  sh("openssl x509 -req -in leaf.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out leaf.crt -days 1 -extfile ext 2>/dev/null")
  server = Bun.serve({
    port: 0,
    tls: { cert: readFileSync(join(dir, "leaf.crt"), "utf8"), key: readFileSync(join(dir, "leaf.key"), "utf8") },
    fetch: () => Response.json({ data: [{ id: "m" }] }),
  })
})
afterAll(() => server?.stop(true))

const model = (tls?: { ca?: string; insecure?: boolean }): ResolvedModel => ({
  ref: "t/m",
  connectionName: "t",
  id: "m",
  spec: {},
  connection: { base_url: `https://127.0.0.1:${server.port}/v1`, tls, models: {} },
})

test("a private CA is refused by default, with advice", async () => {
  await expect(new OpenAIChatClient(model()).listModels()).rejects.toThrow("tls.ca")
})
test("tls.ca trusts it", async () => {
  expect(await new OpenAIChatClient(model({ ca: join(dir, "ca.crt") })).listModels()).toEqual([{ id: "m", context: undefined }])
})
test("tls.insecure skips verification", async () => {
  expect(await new OpenAIChatClient(model({ insecure: true })).listModels()).toHaveLength(1)
})
