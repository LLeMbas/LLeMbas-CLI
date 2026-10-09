import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { join } from "node:path"
import { createSignal, Show } from "solid-js"
import { paths } from "../../config/paths.ts"
import { ModelError } from "../../provider/index.ts"
import { useTui } from "../context.ts"

const EXAMPLE = `connections:
  local:                          # any name; llama.cpp, LM Studio, vLLM, Ollama's /v1…
    dialect: openai-chat
    base_url: http://127.0.0.1:8080/v1
    models:
      qwen3: { context: 131072 }`

/** Before there is a session: no model to talk to (a fresh install), or a config file that cannot
 *  be read. Says what to do and where; r tries again once the files are fixed, q or ctrl+c leaves.
 *  Not an exception: thrown with the terminal still the TUI's, mouse reporting would stay on, and
 *  every move of the mouse would type escape codes into the shell afterwards. */
export function Setup(p: { error: Error; onRetry: () => void; onQuit: () => void }) {
  const { theme } = useTui()
  const c = () => theme().colors
  const noModel = () => p.error instanceof ModelError
  // `l`: sign in to a LLeMbas instance, which writes the connection and the model this screen is
  // asking for — so a fresh install needs no file edited at all. A line typed here, then the code
  // to approve on the instance; on success the session starts as if `r` had been pressed.
  // A fresh install opens on the sign-in, its address field focused: for most people the
  // instance is where the models are, and the file below is the other way.
  const [typing, setTyping] = createSignal(noModel())
  const [address, setAddress] = createSignal("")
  const [status, setStatus] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const signIn = async () => {
    const target = address().trim()
    if (!target) return
    setBusy(true)
    setStatus(`Looking for LLeMbas at ${target}…`)
    try {
      const { codeInstructions, login } = await import("../../lembas/login.ts")
      const r = await login(target, { onCode: (start, d) => setStatus(codeInstructions(start, d)) })
      setStatus(`Signed in: ${r.models.length} model${r.models.length === 1 ? "" : "s"} as ${r.connection}/…${r.instanceDefault ? `, starting on ${r.connection}/${r.instanceDefault}` : ""}.`)
      p.onRetry()
    } catch (e) {
      setStatus((e as Error).message)
      setBusy(false)
    }
  }
  useKeyboard((key) => {
    key.preventDefault()
    if (key.ctrl && key.name === "c") return p.onQuit()
    // Ctrl+R tries again from anywhere — typing an address included, where r is a letter.
    if (key.ctrl && key.name === "r") return p.onRetry()
    if (typing()) {
      if (busy()) return
      if (key.name === "escape") return void (setTyping(false), setStatus(""))
      if (key.name === "return" || key.name === "enter") return void signIn()
      if (key.name === "backspace") return void setAddress((a) => a.slice(0, -1))
      if (key.sequence && key.sequence.length === 1 && key.sequence >= " " && !key.ctrl && !key.meta) setAddress((a) => a + key.sequence)
      return
    }
    if (key.name === "l" && noModel()) return void setTyping(true)
    if (key.name === "r") p.onRetry()
    else if (key.name === "q" || key.name === "escape") p.onQuit()
  })
  return (
    <box flexDirection="column" width="100%" height="100%" paddingLeft={2} paddingTop={1} paddingRight={2} gap={1}>
      <text fg={c().title} attributes={TextAttributes.BOLD}>
        ☤ {theme().branding.agentName} — {noModel() ? "no model to talk to yet" : "the configuration has a mistake"}
      </text>
      {/* "No model configured" is what the rest of the screen explains; anything else (a model
          that does not exist, a file that does not parse) is shown as it is. */}
      <Show when={!p.error.message.startsWith("No model configured")}>
        <text fg={noModel() ? c().text : c().error} wrapMode="word">
          {p.error.message}
        </text>
      </Show>
      {/* The sign-in first: the screen opens on it, the address field focused. */}
      <Show when={noModel()}>
        <Show
          when={typing()}
          fallback={
            <text fg={c().muted} wrapMode="word">
              {"Sign in to a LLeMbas instance and use its models: press l (or, from a shell, lembas login <address>)."}
            </text>
          }
        >
          <box flexDirection="column">
            <text fg={c().title} attributes={TextAttributes.BOLD}>
              Log in to a LLeMbas instance
            </text>
            <text fg={c().text}>Address: {address()}▏</text>
          </box>
        </Show>
        <Show when={status()}>
          <text fg={c().text} wrapMode="word">
            {status()}
          </text>
        </Show>
        <text fg={c().muted} wrapMode="word">
          {`Or, without an instance — nothing is predefined: add the server you use to ${join(paths.config, "connections.yaml")}, for example`}
        </text>
        <box paddingLeft={2}>
          <text fg={c().text}>{EXAMPLE}</text>
        </box>
        <text fg={c().muted} wrapMode="word">
          {`and pick the model in ${join(paths.config, "config.yaml")}:`}
        </text>
        <box paddingLeft={2}>
          <text fg={c().text}>model: local/qwen3</text>
        </box>
        <text fg={c().muted} wrapMode="word">
          A key is never pasted in: api_key: "{"{env:NAME}"}" or "{"{file:~/path}"}". https://llembas.eu/docs/ has the other dialects (Anthropic, OpenAI, Gemini, Ollama).
        </text>
      </Show>
      <text fg={c().muted} wrapMode="word">
        From a shell, lembas config check reads the files and says what is wrong, and lembas models lists the models it found.
      </text>
      <text fg={c().label}>{typing() ? "enter sign in · esc back · ctrl+r try again · ctrl+c quit" : `${noModel() ? "l log in · " : ""}r try again · q quit`}</text>
    </box>
  )
}
