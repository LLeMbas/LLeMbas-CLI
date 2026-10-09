import { applyPatchTool } from "./apply_patch.ts"
import { bashKillTool, bashListTool, bashOutputTool, bashTool } from "./bash.ts"
import { editTool } from "./edit.ts"
import { multieditTool } from "./multiedit.ts"
import { askUserTool } from "./question.ts"
import { readTool } from "./read.ts"
import { globTool, grepTool, listTool } from "./search.ts"
import { todoTool } from "./todo.ts"
import { viewImageTool } from "./view_image.ts"
import { planSubmitTool } from "./plan_exit.ts"
import { taskTool } from "./task.ts"
import { decisionsTool, tasksTool } from "./project_tools.ts"
import { webFetchTool, webSearchTool } from "./web.ts"
import { memoryTool } from "./memory.ts"
import { sessionSearchTool } from "./session_search.ts"
import { skillManageTool, skillsListTool, skillViewTool } from "./skills.ts"
import { settingsTool } from "./settings.ts"
import { knowledgeGetTool, knowledgeSearchTool, noteManageTool, notesSearchTool, noteViewTool } from "./library.ts"
import type { Tool } from "./tool.ts"
import { writeTool } from "./write.ts"

export const BUILTIN_TOOLS: Tool[] = [
  readTool,
  writeTool,
  editTool,
  multieditTool,
  applyPatchTool,
  globTool,
  grepTool,
  listTool,
  bashTool,
  bashOutputTool,
  bashListTool,
  bashKillTool,
  webSearchTool,
  webFetchTool,
  taskTool,
  todoTool,
  tasksTool,
  decisionsTool,
  askUserTool,
  planSubmitTool,
  memoryTool,
  sessionSearchTool,
  notesSearchTool,
  noteViewTool,
  noteManageTool,
  knowledgeSearchTool,
  knowledgeGetTool,
  skillsListTool,
  skillViewTool,
  skillManageTool,
  settingsTool,
  viewImageTool,
] as Tool[]

export function toolMap(tools: Tool[] = BUILTIN_TOOLS): Map<string, Tool> {
  return new Map(tools.map((t) => [t.name, t]))
}


export { canonicalToolNames, resolveCall } from "./names.ts"
