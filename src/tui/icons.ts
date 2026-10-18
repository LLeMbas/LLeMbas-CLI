// Icon sets, kept free of OpenTUI so the headless output can use them too.
export type IconSet = "emoji" | "plain"

/** For a terminal font without emoji (it draws a box with the code inside, e.g. 01F3A4 for 🎤):
 *  one-column symbols from Latin-1, arrows and geometric shapes, which monospace fonts carry. */
export const PLAIN: { toolEmoji: Record<string, string>; icons: { mcp: string; other: string; denied: string; mic: string; speaker: string; locked: string } } = {
  toolEmoji: {
    read: "»",
    write: "+",
    edit: "±",
    multiedit: "±",
    apply_patch: "±",
    glob: "*",
    grep: "/",
    list: "▤",
    bash: "$",
    bash_output: "›",
    bash_list: "›",
    bash_kill: "×",
    plan_write: "▣",
    plan_update: "▣",
    ask_user: "?",
    view_image: "▨",
    plan_submit: "▸",
    task: "◆",
    tasks: "≡",
    decisions: "•",
    web_search: "◎",
    web_fetch: "↓",
    memory: "◈",
    session_search: "↺",
    skills_list: "§",
    skill_view: "§",
    skill_manage: "§",
    notes_search: "¶",
    note_view: "¶",
    note_manage: "¶",
    knowledge_search: "¶",
    knowledge_get: "¶",
  },
  icons: { mcp: "◇", other: "•", denied: "×", mic: "mic", speaker: "♪", locked: "[locked]" },
}
