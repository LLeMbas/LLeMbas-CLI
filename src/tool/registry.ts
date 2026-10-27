import { applyPatchTool } from "./apply_patch.ts"
import { bashTool } from "./bash.ts"
import { jobListTool, jobOutputTool, jobSendTool, jobStopTool, reportTool } from "./job_tools.ts"
import { editTool } from "./edit.ts"
import { multieditTool } from "./multiedit.ts"
import { askUserTool } from "./ask_user.ts"
import { readTool } from "./read.ts"
import { globTool, grepTool, listTool } from "./search.ts"
import { viewImageTool } from "./view_image.ts"
import { planSubmitTool } from "./plan_submit.ts"
import { planUpdateTool } from "./plan_update.ts"
import { planWriteTool } from "./plan_write.ts"
import { taskTool } from "./task.ts"
import { decisionsTool, tasksTool } from "./project_tools.ts"
import { webFetchTool, webSearchTool } from "./web.ts"
import { memoryTool } from "./memory.ts"
import { sessionSearchTool } from "./session_search.ts"
import { skillManageTool, skillsListTool, skillViewTool } from "./skills.ts"
import { settingsTool } from "./settings.ts"
import { showTool } from "./show.ts"
import { recallTool } from "./recall.ts"
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
  jobOutputTool,
  jobListTool,
  jobStopTool,
  jobSendTool,
  webSearchTool,
  webFetchTool,
  taskTool,
  planWriteTool,
  planUpdateTool,
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
  showTool,
  recallTool,
  // Offered to subagents only (the spec's `offered: subagent`; app.ts SUBAGENT_ONLY).
  reportTool,
] as Tool[]

export function toolMap(tools: Tool[] = BUILTIN_TOOLS): Map<string, Tool> {
  return new Map(tools.map((t) => [t.name, t]))
}


export { canonicalToolNames, resolveCall } from "./names.ts"
