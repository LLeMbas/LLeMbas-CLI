// The settings tool: the user can tell the agent "think harder", "switch to the big model", "plan
// first" — and it changes the setting, with the user's approval (settings_tool: ask, the default).
// Only what config/settings.ts marks for the agent; never permission rules, the hardline, MCP,
// connections, updates, or this tool's own gate. A less strict mode is asked about every time.
import { z } from "zod"
import { describe, findSetting, parseValue, show, type Entry } from "../config/settings.ts"
import type { Mode } from "../config/schema.ts"
import { defineTool, ToolError, type ToolContext } from "./tool.ts"
import { described } from "../harness.ts"

const MODE_RANK: Record<Mode, number> = { auto: 0, edit: 1, manual: 2, plan: 3 }

const line = (e: Entry) =>
  `${e.def.key} = ${show(e.value) || "(unset)"} [${e.source}]${e.def.values ? ` — ${e.def.values.join(" | ")}` : ""}${e.def.agent ? "" : " — user only"}${e.def.reload ? " — after a restart" : ""}`

function api(ctx: ToolContext) {
  if (!ctx.settings) throw new ToolError("Settings cannot be changed here.")
  return ctx.settings
}

export const settingsTool = defineTool({
  ...described("settings"),
  access: "settings",
  schema: z.object({
    action: z.enum(["list", "get", "set"]),
    key: z.string().optional(),
    value: z.string().optional(),
    scope: z.enum(["session", "global", "project"]).optional(),
  }),
  permission(a, ctx) {
    if (a.action === "list") return { permission: "settings", class: "interact", patterns: ["list"] }
    if (a.action === "get") return { permission: "settings", class: "interact", patterns: [`get ${a.key ?? ""}`] }
    const scope = a.scope ?? "session"
    const value = a.value ?? ""
    let alwaysAsk: string | undefined
    // Loosening the mode is the one change no rule or mode may wave through. Judged on the value as
    // it will be applied (trimmed, checked); anything that does not read as a mode is asked too.
    if (a.key?.trim() === "mode") {
      let next: Mode | undefined
      try {
        next = parseValue(findSetting("mode")!, value) as Mode
      } catch {}
      const now = ctx.settings?.get("mode").value as Mode | undefined
      if (!next || !now || MODE_RANK[next] < MODE_RANK[now]) alwaysAsk = `a less strict permission mode (${now ?? "?"} → ${next ?? value}) is always asked`
    }
    return { permission: "settings", class: "interact", patterns: [`${scope} ${a.key}=${value}`], always: [`${scope} ${a.key}=*`], alwaysAsk }
  },
  async run(a, ctx) {
    const s = api(ctx)
    if (a.action === "list") {
      const entries = s.list()
      return {
        output: `${entries.map(line).join("\n")}\n\nConfigured models: ${s.models().join(", ") || "(none)"}`,
        title: `${entries.length} settings`,
      }
    }
    if (!a.key) throw new ToolError(`${a.action} needs a key.`)
    const def = findSetting(a.key)
    if (!def) throw new ToolError(`"${a.key}" is not a setting. List them with action "list".`)
    if (a.action === "get") {
      const e = s.get(a.key)
      return { output: `${line(e)}\n${describe(def)}`, title: `${a.key} = ${show(e.value)}` }
    }
    if (!def.agent) throw new ToolError(`${a.key} is the user's to change, not yours: tell them to use /settings or edit config.yaml.`)
    if (a.value === undefined) throw new ToolError("set needs a value.")
    try {
      const r = s.set(a.key, a.value, a.scope ?? "session")
      const when = a.key === "model" || a.key === "effort" ? " It applies from your next step." : ""
      return { output: `Done: ${r.message}.${when}`, title: `${a.key} = ${show(r.value)} (${r.scope})` }
    } catch (e) {
      throw new ToolError((e as Error).message)
    }
  },
})
