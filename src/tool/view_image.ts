import { z } from "zod"
import { loadImage } from "../project/image.ts"
import { absPath, defineTool, showPath, ToolError } from "./tool.ts"
import { described } from "../harness.ts"

export const viewImageTool = defineTool({
  ...described("view_image"),
  access: "read",
  requires: "vision",
  schema: z.object({ path: z.string() }),
  permission: (a, ctx) => {
    const abs = absPath(a.path, ctx)
    return { permission: "read", class: "read", patterns: [showPath(abs, ctx)], paths: [abs] }
  },
  async run(a, ctx) {
    const abs = absPath(a.path, ctx)
    const img = loadImage(abs)
    if (typeof img === "string") throw new ToolError(img)
    const kb = Math.round((img.data.length * 3) / 4 / 1024)
    return { output: `Showing ${showPath(abs, ctx)} (${img.mime}, ${kb} KB) in the next message.`, title: `${showPath(abs, ctx)} · ${kb} KB`, images: [img] }
  },
})
