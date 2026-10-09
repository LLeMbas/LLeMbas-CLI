// Regenerate schema/*.json from src/config/schema.ts: bun run schema. A test fails while they differ.
import { join } from "node:path"
import { jsonSchemas, SCHEMA_FILES, schemaText } from "../src/config/jsonschema.ts"

const s = jsonSchemas()
for (const [name, file] of Object.entries(SCHEMA_FILES) as [keyof typeof SCHEMA_FILES, string][]) {
  await Bun.write(join(import.meta.dir, "..", "schema", file), schemaText(s[name]))
  console.log(`schema/${file}`)
}
