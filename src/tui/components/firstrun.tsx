import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createSignal, Match, Switch } from "solid-js"
import { gitInit } from "../../git/repo.ts"
import { ignoreLocal, initProjectDir, neverGitInit, setNeverGitInit } from "../../project/init.ts"
import { setTrust, type Project } from "../../project/root.ts"
import { useTui } from "../context.ts"
import { Dialog } from "./dialog.tsx"

export interface FirstRunResult {
  quit: boolean
  /** What happened, said once the session opens. */
  notes: string[]
}

/** The first time in a directory: trust it? create a git repository? then the .agent skeleton. */
export function FirstRun(p: { project: Project; onDone: (r: FirstRunResult) => void }) {
  const { theme } = useTui()
  const c = () => theme().colors
  const notes: string[] = []
  const [step, setStep] = createSignal<"trust" | "git">("trust")
  let trusted = false

  const finish = () => {
    if (trusted) {
      const made = initProjectDir(p.project)
      const name = p.project.dir.slice(p.project.root.length + 1)
      if (made.length) notes.push(`created ${name}/ (config.yaml, plans/, commands/, skills/, agents/)`)
      if (ignoreLocal(p.project)) notes.push(`added the per-user ${name}/local/ to .gitignore`)
    }
    p.onDone({ quit: false, notes })
  }
  // Ctrl+C leaves from here too, as it does everywhere else: nothing has been written yet.
  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      key.preventDefault()
      p.onDone({ quit: true, notes })
    }
  })
  const afterTrust = () => {
    if (!p.project.gitRoot && !neverGitInit(p.project.root)) setStep("git")
    else finish()
  }

  return (
    <box flexDirection="column" width="100%" height="100%" paddingLeft={2} paddingTop={1}>
      <text fg={c().title} attributes={TextAttributes.BOLD}>
        {theme().branding.agentName} — first time here
      </text>
      <text fg={c().text} wrapMode="word">
        {p.project.root}
      </text>
      <text fg={c().muted} wrapMode="word">
        LLeMbas CLI reads the files here and runs the commands you approve. Trusting the directory also lets its .agent/ apply: its permission rules (they can allow commands without asking, though never past your own global rules or the hardline), a stricter mode, its MCP servers — local ones are programs that start at once — and its commands, agents and skills. Trust only a repository you would run the code of.
      </text>
      <Switch>
        <Match when={step() === "trust"}>
          <Dialog
            spec={{
              title: "Trust this directory?",
              options: [
                { label: "Trust it", value: "trusted", description: "its .agent/: rules, MCP servers, commands, agents, skills" },
                { label: "Read-only", value: "readonly", description: "plan mode; its own config is ignored" },
                { label: "Quit", value: "quit" },
              ],
              onSelect: (v) => {
                if (v === "quit") return p.onDone({ quit: true, notes })
                setTrust(p.project.root, v as "trusted" | "readonly")
                trusted = v === "trusted"
                notes.push(v === "trusted" ? "trusted this directory" : "opened read-only: plan mode, project config ignored")
                afterTrust()
              },
            }}
            close={() => {}}
          />
        </Match>
        <Match when={step() === "git"}>
          <Dialog
            spec={{
              title: "No git repository here. Create one?",
              options: [
                { label: "Create it", value: "init", description: "git init -b main — local only, no remote" },
                { label: "Not now", value: "later", description: "ask again next time" },
                { label: "Never for this directory", value: "never" },
              ],
              onSelect: (v) => {
                if (v === "init") {
                  const r = gitInit(p.project.root)
                  notes.push(r.message)
                  if (r.ok) p.project.gitRoot = p.project.root
                } else if (v === "never") setNeverGitInit(p.project.root)
                finish()
              },
            }}
            close={() => {}}
          />
        </Match>
      </Switch>
    </box>
  )
}
