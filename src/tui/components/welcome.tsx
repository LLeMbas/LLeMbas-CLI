import { TextAttributes } from "@opentui/core"
import { Show } from "solid-js"
import { VERSION } from "../../version.ts"
import { useTui } from "../context.ts"

export function Welcome() {
  const { theme, app } = useTui()
  const c = () => theme().colors
  return (
    <box border borderStyle="rounded" borderColor={c().border} flexDirection="column" paddingLeft={1} paddingRight={1} marginTop={1} flexShrink={0}>
      <text fg={c().title} attributes={TextAttributes.BOLD}>
        ☤ {theme().branding.agentName} <span style={{ fg: c().dim, attributes: 0 }}>{VERSION}</span>
      </text>
      <text fg={c().text} wrapMode="none" truncate>
        <span style={{ fg: c().label }}>model </span>
        {app.engine.model.ref}
      </text>
      <text fg={c().text} wrapMode="none" truncate>
        <span style={{ fg: c().label }}>project </span>
        {app.project.root}
        <span style={{ fg: c().dim }}>{app.project.gitRoot ? " (git)" : " (no git)"}</span>
      </text>
      <Show when={!app.trusted}>
        <text fg={c().warn} wrapMode="word">
          This project is not trusted: its .agent config, commands and servers are ignored. /trust to change that.
        </text>
      </Show>
      <text fg={c().dim} wrapMode="word">
        enter send · shift+enter newline · shift+tab mode · /help
      </text>
    </box>
  )
}
