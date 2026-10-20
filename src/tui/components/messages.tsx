import { TextAttributes } from "@opentui/core"
import { createEffect, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import { duration } from "../../duration.ts"
import { estimateTokens } from "../../provider/tokens.ts"
import { useTui } from "../context.ts"
import type { Item } from "../state.ts"
import { clipDiff } from "../diffclip.ts"
import { TOOL_SPECS } from "../../harness.ts"
import { resolveCall } from "../../tool/names.ts"
import { splitPrototypes } from "../../prototype/fence.ts"

/** A call the transcript does not draw: a plan change (the panel above the prompt follows it) or a
 *  tool the spec marks hidden — under its former name too (a stored session's `todo`). */
const undrawn = (name: string) => {
  const block = TOOL_SPECS[resolveCall(name, {}).name]?.block
  return block === "plan" || block === "hidden"
}

const FILETYPES: Record<string, string> = { ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", md: "markdown", zig: "zig" }
export const filetypeOf = (diff: string) => FILETYPES[/^\+\+\+ \S*\.(\w+)/m.exec(diff)?.[1] ?? ""]

/** The one-line summary of a call before its result says more, e.g. the command or the path. */
function argSummary(args: unknown): string {
  if (!args || typeof args !== "object") return ""
  const a = args as Record<string, unknown>
  if (Array.isArray(a.questions)) return (a.questions as { header?: string }[]).map((q) => q.header).filter(Boolean).join(" · ") || "asking"
  if (Array.isArray(a.phases)) return String(a.title ?? "").slice(0, 120)
  if (typeof a.patch === "string") return [...a.patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1]).join(", ")
  const v = a.description ?? a.command ?? a.path ?? a.pattern ?? a.id ?? ""
  return String(v).split("\n")[0]!.slice(0, 120)
}

function UserMessage(p: { item: Extract<Item, { kind: "user" }> }) {
  const { theme } = useTui()
  return (
    <box border={["left"]} borderColor={theme().colors.userBar} customBorderChars={{ vertical: "┃", topLeft: "", topRight: "", bottomLeft: "", bottomRight: "", horizontal: "", topT: "", bottomT: "", leftT: "", rightT: "", cross: "" } as never} paddingLeft={1} marginTop={1}>
      <box flexDirection="column">
        <Show when={p.item.mid}>
          <text fg={theme().colors.dim} wrapMode="none" truncate>
            ↳ sent while it worked
          </text>
        </Show>
        <text fg={theme().colors.text} wrapMode="word">
          {p.item.text}
        </text>
      </box>
    </box>
  )
}

/** A reply as markdown — except a completed prototype fence, which is saved as a file
 *  (state.ts) and drawn as one line saying so in its place; while it still streams it is the
 *  code block it is so far. */
function AssistantMessage(p: { item: Extract<Item, { kind: "assistant" }> }) {
  const { theme, md } = useTui()
  const segments = () => (p.item.text.includes("```") || p.item.text.includes("~~~") ? splitPrototypes(p.item.text) : [])
  const whole = () => !segments().some((s) => s.kind === "prototype")
  return (
    <box paddingLeft={2} marginTop={1} flexDirection="column">
      <Show when={!whole()} fallback={<markdown content={p.item.text.trim()} syntaxStyle={md()} streaming={p.item.streaming} fg={theme().colors.text} conceal />}>
        <For each={segments()}>
          {(seg, i) => {
            const saved = () => (seg.kind === "prototype" && seg.closed ? p.item.prototypes?.[seg.start] : undefined)
            const last = () => i() === segments().length - 1
            return (
              <Show
                when={saved()}
                fallback={<markdown content={(seg.kind === "text" ? seg.text : seg.raw).trim()} syntaxStyle={md()} streaming={p.item.streaming && last()} fg={theme().colors.text} conceal />}
              >
                <text fg={theme().colors.muted} wrapMode="none" truncate>
                  {`prototype · ${saved()!.title || saved()!.kind} · saved to ${saved()!.path}`}
                </text>
              </Show>
            )
          }}
        </For>
      </Show>
    </box>
  )
}

/** Thinking is one line, never the text as it streams (a growing block jumped about as it
 *  re-laid itself out; what matters is the tools and the answer): "Thinking." "Thinking.."
 *  "Thinking..." while it thinks, then "Thought for 12.3s · 1,234 tokens" — this thought's time
 *  and tokens, nothing else (the task's are on the line at the bottom). The tokens are the
 *  provider's count when the step had this one thought, else an estimate (~). Ctrl+R opens a
 *  finished thought. */
function Reasoning(p: { item: Extract<Item, { kind: "reasoning" }> }) {
  const { theme, thought, view } = useTui()
  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    if (!p.item.streaming) return
    const t = setInterval(() => setNow(Date.now()), 200)
    onCleanup(() => clearInterval(t))
  })
  const tokens = () => {
    const n = p.item.tokens ?? estimateTokens(p.item.text)
    return `${p.item.tokens === undefined ? "~" : ""}${n.toLocaleString("en")} token${n === 1 ? "" : "s"}`
  }
  const dots = () => ".".repeat(1 + (Math.floor((now() - p.item.started) / 400) % 3))
  const line = () => (p.item.streaming ? `Thinking${dots()}` : p.item.ms !== undefined ? `Thought for ${duration(p.item.ms)} · ${tokens()}` : `Thought · ${tokens()}`)
  return (
    <box paddingLeft={2} marginTop={1} flexDirection="column">
      <text fg={theme().colors.reasoning} attributes={TextAttributes.ITALIC} wrapMode="none" truncate>
        {line()}
      </text>
      <Show when={view.state.showReasoning && !p.item.streaming}>
        <box paddingLeft={2}>
          <code filetype="markdown" content={p.item.text.trim()} syntaxStyle={thought()} drawUnstyledText conceal />
        </box>
      </Show>
    </box>
  )
}

/** How a job is doing, in a word or two: `running…`, `done · 1m 12s`, `stopped · 4s`. */
export function jobWords(j: { state: string; started: number; ended?: number; exit?: number | null }): string {
  if (j.state === "running") return "running…"
  const took = duration((j.ended ?? Date.now()) - j.started, true)
  return `${j.state}${j.state !== "lost" && j.exit !== undefined && j.exit !== null && j.exit !== 0 ? ` (exit ${j.exit})` : ""} · ${took}`
}

function ToolLine(p: { item: Extract<Item, { kind: "tool" }> }) {
  const { theme, view } = useTui()
  const c = () => theme().colors
  const emoji = () => (p.item.status === "denied" ? theme().icons.denied : (theme().toolEmoji[p.item.name] ?? (p.item.name.startsWith("mcp__") ? theme().icons.mcp : theme().icons.other)))
  const title = () => p.item.title ?? argSummary(p.item.args)
  const time = () => (p.item.status === "running" ? "…" : p.item.ms !== undefined ? duration(p.item.ms) : "")
  const tail = () => (p.item.output ?? "").trimEnd().split("\n").slice(-12).join("\n")
  // Short in the transcript, whole with ctrl+o; always a diff the renderer can parse.
  const shown = () => (view.state.expandTools ? { diff: p.item.diff ?? "", hidden: 0 } : clipDiff(p.item.diff ?? "", 24))
  return (
    <box flexDirection="column" paddingLeft={1}>
      <text wrapMode="none" truncate>
        <span style={{ fg: c().dim }}>{theme().branding.toolPrefix} </span>
        {emoji()}{" "}
        <span style={{ fg: p.item.status === "denied" ? c().warn : c().label, attributes: p.item.status === "denied" ? TextAttributes.STRIKETHROUGH : 0 }}>{p.item.name.padEnd(6)}</span>{" "}
        <span style={{ fg: p.item.status === "error" ? c().error : p.item.status === "denied" ? c().warn : c().text }}>{title()}</span>{" "}
        <span style={{ fg: c().dim }}>{time()}</span>
        <Show when={p.item.status === "error"}>
          <span style={{ fg: c().error }}> ✗</span>
        </Show>
      </text>
      <Show when={p.item.job}>
        <text wrapMode="none" truncate>
          <span style={{ fg: c().dim }}>{"    → "}</span>
          <span style={{ fg: c().label }}>{p.item.job!.id}</span>
          <span style={{ fg: c().muted }}>{` (${p.item.job!.agent ? `${p.item.job!.agent}: ` : ""}${p.item.job!.description})`}</span>
          <span style={{ fg: p.item.job!.state === "running" ? c().accent : p.item.job!.state === "error" || p.item.job!.state === "lost" ? c().error : c().dim }}>{` ${jobWords(p.item.job!)}`}</span>
        </text>
      </Show>
      <For each={p.item.children ?? []}>
        {(ch) => (
          <text wrapMode="none" truncate>
            <span style={{ fg: c().dim }}>{"    "}{theme().branding.toolPrefix} </span>
            {theme().toolEmoji[ch.name] ?? (ch.name.startsWith("mcp__") ? theme().icons.mcp : theme().icons.other)}{" "}
            <span style={{ fg: c().label }}>{ch.name.padEnd(6)}</span>{" "}
            <span style={{ fg: ch.isError ? c().error : c().muted }}>{ch.title}</span>
          </text>
        )}
      </For>
      <Show when={p.item.diff}>
        <box paddingLeft={4} paddingRight={1} flexDirection="column">
          <WrappedDiff patch={shown().diff} filetype={filetypeOf(p.item.diff!)} />
          <Show when={shown().hidden > 0}>
            <text fg={c().muted}>{`… ${shown().hidden} more line${shown().hidden === 1 ? "" : "s"} (ctrl+o)`}</text>
          </Show>
        </box>
      </Show>
      <Show when={view.state.expandTools && !p.item.diff && tail()}>
        <box paddingLeft={4}>
          <text fg={c().muted} wrapMode="char">
            {tail()}
          </text>
        </box>
      </Show>
    </box>
  )
}

/** A unified diff in the transcript, given its width outright. Left to fill its box, OpenTUI's
 *  diff wrapped long lines at a width measured before the transcript's scrollbar took its column:
 *  with the scrollbar showing, a long line ran one column past its own background. The box's laid-out width is right, so the diff gets that number. */
function WrappedDiff(p: { patch: string; filetype?: string }) {
  const { theme } = useTui()
  const c = () => theme().colors
  const [width, setWidth] = createSignal<number>()
  return (
    <box
      flexDirection="column"
      onSizeChange={function (this: { width: number }) {
        const w = this.width
        // After this layout pass, not inside it.
        if (w > 0 && w !== width()) setTimeout(() => setWidth(w), 0)
      }}
    >
      <diff
        width={width()}
        diff={p.patch}
        view="unified"
        filetype={p.filetype}
        showLineNumbers
        wrapMode="char"
        fg={c().text}
        addedBg={c().diffAddedBg}
        removedBg={c().diffRemovedBg}
        contextBg={c().diffContextBg}
        addedSignColor={c().diffAddedSign}
        removedSignColor={c().diffRemovedSign}
        lineNumberFg={c().lineNumber}
        lineNumberBg={c().diffContextBg}
      />
    </box>
  )
}

/** A multi-file diff (/diff), one block per file. */
function DiffBlock(p: { item: Extract<Item, { kind: "diff" }> }) {
  const { theme } = useTui()
  const c = () => theme().colors
  const files = () =>
    p.item.patch
      .split(/^(?=diff --git )/m)
      .filter((f) => f.startsWith("diff --git"))
      .map((f) => ({ name: /^diff --git a\/(.+?) b\//.exec(f)?.[1] ?? "?", patch: f }))
  return (
    <box flexDirection="column" paddingLeft={1} marginTop={1}>
      <text fg={c().title}>{p.item.title}</text>
      <For each={files()}>
        {(f) => (
          <box flexDirection="column" paddingLeft={2}>
            <text fg={c().label}>{f.name}</text>
            <WrappedDiff patch={f.patch} filetype={filetypeOf(f.patch)} />
          </box>
        )}
      </For>
    </box>
  )
}

function Notice(p: { item: Extract<Item, { kind: "notice" }> }) {
  const { theme } = useTui()
  return (
    <box paddingLeft={1}>
      <text fg={p.item.level === "warn" ? theme().colors.warn : theme().colors.muted} wrapMode="word">
        {p.item.level === "warn" ? "⚠ " : "· "}
        {p.item.text}
      </text>
    </box>
  )
}

function ErrorLine(p: { item: Extract<Item, { kind: "error" }> }) {
  const { theme } = useTui()
  return (
    <box paddingLeft={1} marginTop={1}>
      <text fg={theme().colors.error} wrapMode="word">
        ✗ {p.item.text}
      </text>
    </box>
  )
}

export function Messages() {
  const { view } = useTui()
  return (
    <For each={view.state.items}>
      {(item) => (
        <Switch>
          <Match when={item.kind === "user"}>
            <UserMessage item={item as Extract<Item, { kind: "user" }>} />
          </Match>
          <Match when={item.kind === "assistant"}>
            <AssistantMessage item={item as Extract<Item, { kind: "assistant" }>} />
          </Match>
          <Match when={item.kind === "reasoning"}>
            <Reasoning item={item as Extract<Item, { kind: "reasoning" }>} />
          </Match>
          <Match when={item.kind === "tool" && !undrawn((item as Extract<Item, { kind: "tool" }>).name)}>
            <ToolLine item={item as Extract<Item, { kind: "tool" }>} />
          </Match>
          <Match when={item.kind === "notice"}>
            <Notice item={item as Extract<Item, { kind: "notice" }>} />
          </Match>
          <Match when={item.kind === "diff"}>
            <DiffBlock item={item as Extract<Item, { kind: "diff" }>} />
          </Match>
          <Match when={item.kind === "error"}>
            <ErrorLine item={item as Extract<Item, { kind: "error" }>} />
          </Match>
        </Switch>
      )}
    </For>
  )
}
