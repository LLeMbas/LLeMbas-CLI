// The CLI's values for the harness spec's `{{variables}}` in the library's tool descriptions
// (harness/tools/<name>.json `variables`): the facts of this machine's library — files, projects,
// supporting files, sessions — where LLeMbas fills in its own. Filled where each tool is defined
// (described); the per-session ones (task, bash) are filled in src/app.ts.
export const CLI_VARS: Record<string, Record<string, string>> = {
  memory: {
    project_home: " Anything about this project belongs in its AGENTS.md or the project's decision log, not here.",
    targets: "'user' — who the user is: name, role, preferences, how they like to work. 'memory' — your own notes: environment, conventions, tool quirks, lessons.",
    past_work: " (session_search finds past work)",
    when_seen: "What you save now is in the files at once but appears in your system prompt only from the next session.",
    target_values: "'memory' for your notes, 'user' for the user profile, 'project' for facts about this project only (kept in its .agent/local, never committed).",
  },
  notes_search: { kept: ", global or this project's; both are searched" },
  note_manage: {
    create_scope: ", scope",
    scope: 'scope: "project" (default, when there is a project) or "global".',
    records: ", or the project's own records (tasks, decisions)",
  },
  skills_list: { category: ", category" },
  skill_view: { files: ", and the list of its supporting files (references, templates, scripts, assets). To read one of those, call again with file_path." },
  skill_manage: {
    create_where: " Global unless where: project.",
    files: "write_file / remove_file: supporting files under references/, templates/, scripts/ or assets/.",
    revert_deleted: " (a deleted one too)",
    index_cut: " — only that much shows in the skills list",
  },
}
