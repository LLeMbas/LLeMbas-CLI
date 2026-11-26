import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import { useTui } from "../context.ts"
import {
  buildLiveSnapshot,
  DISPLAY_TABS,
  effectiveTab,
  extractBash,
  extractChanges,
  extractFiles,
  resolveIndex,
  type DisplayNavState,
  type DisplayTab,
} from "../displays.ts"
import { filetypeOf } from "./messages.tsx"

const TAB_LABEL: Record<DisplayTab, string> = {
  live: "Live",
  files: "Files",
  changes: "Changes",
  bash: "Bash",
}

const PLAN_MARK: Record<string, string> = { todo: "☐", doing: "▸", done: "☑", dropped: "✗" }

function toolStatusGlyph(status: string): string {
  if (status === "running") return "◐"
  if (status === "error") return "✗"
  if (status === "denied") return "⊘"
  return "✓"
}

export function DisplayPane(p: {
  width: number
  nav: () => DisplayNavState
  onSelectTab: (tab: DisplayTab) => void
  scrollRef?: (r: ScrollBoxRenderable) => void
}) {
  const { theme, view, app } = useTui()
  const c = () => theme().colors

  // Tick once per second while busy so elapsed times and live progress stay fresh.
  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    if (view.state.phase === "idle" && !view.state.jobs.some((j) => j.state === "running")) return
    const t = setInterval(() => setNow(Date.now()), 500)
    onCleanup(() => clearInterval(t))
  })

  const files = createMemo(() => extractFiles(view.state.items))
  const changes = createMemo(() => extractChanges(view.state.items, view.state.pending))
  const bash = createMemo(() => extractBash(view.state.items))
  const hasProposed = createMemo(() => Boolean(view.state.pending?.preview?.diff))
  const activeTab = createMemo(() => effectiveTab(p.nav(), hasProposed()))
  const live = createMemo(() => buildLiveSnapshot(view.state, now()))

  const teamMembers = createMemo(() => {
    now()
    const tree = app.team.team.tree()
    return tree.filter((m) => m.manager !== null)
  })

  const counts = () => ({
    files: files().length,
    changes: changes().length,
    bash: bash().length,
  })

  const fileIdx = () => resolveIndex(p.nav(), "files", files().length)
  const changeIdx = () => resolveIndex(p.nav(), "changes", changes().length)
  const bashIdx = () => resolveIndex(p.nav(), "bash", bash().length)

  const currentFile = () => (fileIdx() >= 0 ? files()[fileIdx()] : undefined)
  const currentChange = () => (changeIdx() >= 0 ? changes()[changeIdx()] : undefined)
  const currentBash = () => (bashIdx() >= 0 ? bash()[bashIdx()] : undefined)

  const subHeader = () => {
    const tab = activeTab()
    if (tab === "live") {
      return {
        left: live().statusLine,
        right: p.nav().pinned ? "pinned" : "auto-follow",
        warn: Boolean(live().waiting),
      }
    }
    if (tab === "files") {
      const f = currentFile()
      if (!f) return { left: "No files read yet", right: "0/0", warn: false }
      return {
        left: `${f.title}${f.subtitle ? ` · ${f.subtitle}` : ""}`,
        right: `${fileIdx() + 1}/${files().length}`,
        warn: f.status === "error" || f.status === "denied",
      }
    }
    if (tab === "changes") {
      const ch = currentChange()
      if (!ch) return { left: "No file changes yet", right: "0/0", warn: false }
      return {
        left: `${ch.title}${ch.subtitle ? ` · ${ch.subtitle}` : ""}`,
        right: `${changeIdx() + 1}/${changes().length}`,
        warn: ch.status === "proposed" || ch.status === "error" || ch.status === "denied",
      }
    }
    const b = currentBash()
    if (!b) return { left: "No bash commands yet", right: "0/0", warn: false }
    return {
      left: `$ ${b.title}${b.subtitle ? ` · ${b.subtitle}` : ""}`,
      right: `${bashIdx() + 1}/${bash().length}`,
      warn: b.status === "error" || b.status === "denied",
    }
  }

  // Diff width inside the pane (minus left border, padding and scrollbar).
  const diffWidth = () => Math.max(20, p.width - 5)

  return (
    <box
      width={p.width}
      flexShrink={0}
      flexDirection="column"
      border={["left"]}
      borderColor={hasProposed() ? c().warn : c().border}
      backgroundColor={c().panel}
    >
      {/* Tab bar */}
      <box
        height={1}
        flexShrink={0}
        flexDirection="row"
        justifyContent="space-between"
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={c().menu}
      >
        <text wrapMode="none" truncate>
          <For each={DISPLAY_TABS}>
            {(tab, i) => {
              const isActive = () => activeTab() === tab
              const count = () => (tab === "live" ? 0 : counts()[tab])
              const dot = () => (tab === "changes" && hasProposed() ? " ●" : tab === "live" && view.state.phase !== "idle" ? " ◉" : "")
              const label = () => `${TAB_LABEL[tab]}${tab !== "live" && count() > 0 ? ` (${count()})` : ""}${dot()}`
              return (
                <>
                  <Show when={i() > 0}>
                    <span style={{ fg: c().dim }}>{"  "}</span>
                  </Show>
                  <span
                    style={{
                      fg: isActive() ? c().panel : tab === "changes" && hasProposed() ? c().warn : c().muted,
                      bg: isActive() ? (tab === "changes" && hasProposed() ? c().warn : c().accent) : undefined,
                      attributes: isActive() ? TextAttributes.BOLD : 0,
                    }}
                  >
                    {` ${label()} `}
                  </span>
                </>
              )
            }}
          </For>
        </text>
      </box>

      {/* Sub-header */}
      <box
        height={1}
        flexShrink={0}
        flexDirection="row"
        justifyContent="space-between"
        paddingLeft={1}
        paddingRight={1}
        border={["bottom"]}
        borderColor={c().border}
      >
        <text wrapMode="none" truncate fg={subHeader().warn ? c().warn : c().title}>
          {subHeader().left}
        </text>
        <text wrapMode="none" fg={c().dim}>
          {" "}{subHeader().right}
        </text>
      </box>

      {/* Body */}
      <scrollbox
        ref={(r: ScrollBoxRenderable) => p.scrollRef?.(r)}
        flexGrow={1}
        scrollX={false}
        stickyScroll={activeTab() === "bash"}
        stickyStart={activeTab() === "bash" ? "bottom" : "top"}
        viewportOptions={{ paddingLeft: 1, paddingRight: 1 }}
        verticalScrollbarOptions={{ trackOptions: { backgroundColor: c().panel, foregroundColor: c().dim } }}
      >
        <Switch>
          <Match when={activeTab() === "live"}>
            <box flexDirection="column" gap={1} paddingTop={1}>
              {/* Waiting banner */}
              <Show when={live().waiting}>
                <box border borderStyle="rounded" borderColor={c().warn} paddingLeft={1} paddingRight={1} flexDirection="column">
                  <text fg={c().warn} attributes={TextAttributes.BOLD} wrapMode="word">
                    {`Waiting: ${live().waiting!.title}`}
                  </text>
                  <text fg={c().text} wrapMode="word">
                    {live().waiting!.detail}
                  </text>
                </box>
              </Show>

              {/* Currently running tools */}
              <Show when={live().activeTools.length > 0}>
                <box flexDirection="column">
                  <text fg={c().accent} attributes={TextAttributes.BOLD}>
                    Running now
                  </text>
                  <For each={live().activeTools}>
                    {(t) => (
                      <box flexDirection="column" paddingLeft={1}>
                        <text wrapMode="word">
                          <span style={{ fg: c().accent }}>◐ </span>
                          <span style={{ fg: c().label }}>{t.name}</span>
                          <span style={{ fg: c().text }}>{t.title ? ` ${t.title}` : ""}</span>
                        </text>
                        <For each={t.children ?? []}>
                          {(ch) => (
                            <text wrapMode="none" truncate>
                              <span style={{ fg: c().dim }}>{"  ↳ "}</span>
                              <span style={{ fg: c().label }}>{ch.name}</span>
                              <span style={{ fg: ch.isError ? c().error : c().muted }}>{ch.title ? ` ${ch.title}` : ""}</span>
                            </text>
                          )}
                        </For>
                      </box>
                    )}
                  </For>
                </box>
              </Show>

              {/* Live thinking preview */}
              <Show when={live().thinkingTail}>
                <box flexDirection="column">
                  <text fg={c().reasoning} attributes={TextAttributes.BOLD}>
                    {live().thinkingStreaming ? "Thinking live" : "Last thought"}
                  </text>
                  <box paddingLeft={1}>
                    <text fg={c().reasoning} attributes={TextAttributes.ITALIC} wrapMode="word">
                      {live().thinkingTail}
                    </text>
                  </box>
                </box>
              </Show>

              {/* Active plan */}
              <Show when={live().plan}>
                <box flexDirection="column">
                  <text fg={c().label} attributes={TextAttributes.BOLD} wrapMode="none" truncate>
                    {live().plan!.head}
                  </text>
                  <For each={live().plan!.lines}>
                    {(line) => (
                      <text
                        wrapMode="word"
                        fg={line.status === "doing" ? c().accent : line.status === "done" ? c().dim : c().text}
                      >
                        {`  ${PLAN_MARK[line.status] ?? "•"} ${line.text}`}
                      </text>
                    )}
                  </For>
                </box>
              </Show>

              {/* Subagents & background jobs */}
              <Show when={live().jobs.length > 0 || teamMembers().length > 0}>
                <box flexDirection="column">
                  <text fg={c().info} attributes={TextAttributes.BOLD}>
                    Agents & jobs
                  </text>
                  <For each={teamMembers()}>
                    {(m) => (
                      <text wrapMode="none" truncate>
                        <span style={{ fg: m.state === "working" ? c().accent : c().dim }}>{"  ● "}</span>
                        <span style={{ fg: c().label }}>{m.name}</span>
                        <span style={{ fg: c().muted }}>{` (${m.role}) · ${m.state}`}</span>
                      </text>
                    )}
                  </For>
                  <For each={live().jobs}>
                    {(j) => (
                      <text wrapMode="none" truncate>
                        <span style={{ fg: j.state === "running" ? c().accent : j.state === "error" ? c().error : c().dim }}>
                          {"  "}
                          {j.state === "running" ? "◐" : j.state === "error" ? "✗" : "✓"}{" "}
                        </span>
                        <span style={{ fg: c().label }}>{j.id}</span>
                        <span style={{ fg: c().text }}>{` ${j.label}`}</span>
                        <span style={{ fg: c().dim }}>{` · ${j.detail}`}</span>
                      </text>
                    )}
                  </For>
                </box>
              </Show>

              {/* Recent tool activity */}
              <Show when={live().recentTools.length > 0}>
                <box flexDirection="column">
                  <text fg={c().title} attributes={TextAttributes.BOLD}>
                    Recent activity
                  </text>
                  <For each={live().recentTools}>
                    {(t) => (
                      <text wrapMode="none" truncate>
                        <span style={{ fg: t.status === "error" ? c().error : t.status === "denied" ? c().warn : c().statusGood }}>
                          {`  ${toolStatusGlyph(t.status)} `}
                        </span>
                        <span style={{ fg: c().label }}>{t.name}</span>
                        <span style={{ fg: c().text }}>{t.title ? ` ${t.title}` : ""}</span>
                        <span style={{ fg: c().dim }}>{t.detail ? ` · ${t.detail}` : ""}</span>
                      </text>
                    )}
                  </For>
                </box>
              </Show>

              {/* Latest preview */}
              <Show when={live().latestPreview && live().activeTools.length === 0}>
                <box flexDirection="column">
                  <text fg={c().muted} attributes={TextAttributes.BOLD} wrapMode="none" truncate>
                    {`Latest ${live().latestPreview!.kind}: ${live().latestPreview!.title}`}
                  </text>
                  <box paddingLeft={1}>
                    <text fg={c().muted} wrapMode="char">
                      {live().latestPreview!.body}
                    </text>
                  </box>
                </box>
              </Show>

              <Show
                when={
                  !live().waiting &&
                  live().activeTools.length === 0 &&
                  !live().thinkingTail &&
                  !live().plan &&
                  live().jobs.length === 0 &&
                  live().recentTools.length === 0
                }
              >
                <text fg={c().muted} wrapMode="word">
                  Live agent activity, thinking, files read, diffs, and bash output will appear here as the agent works.
                </text>
              </Show>
            </box>
          </Match>

          <Match when={activeTab() === "files"}>
            <Show
              when={currentFile()}
              fallback={
                <box paddingTop={1}>
                  <text fg={c().muted}>No files read in this session yet.</text>
                </box>
              }
            >
              <box flexDirection="column" paddingTop={1}>
                <text fg={c().text} wrapMode="char">
                  {currentFile()!.body}
                </text>
              </box>
            </Show>
          </Match>

          <Match when={activeTab() === "changes"}>
            <Show
              when={currentChange()}
              fallback={
                <box paddingTop={1}>
                  <text fg={c().muted}>No file changes in this session yet.</text>
                </box>
              }
            >
              <box flexDirection="column" paddingTop={1}>
                <Show when={currentChange()!.status === "proposed"}>
                  <text fg={c().warn} attributes={TextAttributes.BOLD}>
                    Proposed change — waiting for your answer
                  </text>
                </Show>
                <Show
                  when={currentChange()!.diff.includes("@@") || currentChange()!.diff.includes("--- ")}
                  fallback={
                    <text fg={c().text} wrapMode="char">
                      {currentChange()!.diff}
                    </text>
                  }
                >
                  <diff
                    width={diffWidth()}
                    diff={currentChange()!.diff}
                    view="unified"
                    filetype={filetypeOf(currentChange()!.diff)}
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
                </Show>
              </box>
            </Show>
          </Match>

          <Match when={activeTab() === "bash"}>
            <Show
              when={currentBash()}
              fallback={
                <box paddingTop={1}>
                  <text fg={c().muted}>No bash commands run in this session yet.</text>
                </box>
              }
            >
              <box flexDirection="column" paddingTop={1} gap={1}>
                <text fg={c().accent} wrapMode="char">
                  {`$ ${currentBash()!.command}`}
                </text>
                <text fg={currentBash()!.status === "error" ? c().error : c().text} wrapMode="char">
                  {currentBash()!.output}
                </text>
              </box>
            </Show>
          </Match>
        </Switch>
      </scrollbox>

      {/* Footer key hints */}
      <box height={1} flexShrink={0} paddingLeft={1} paddingRight={1} backgroundColor={c().menu}>
        <text fg={c().dim} wrapMode="none" truncate>
          Alt+↑↓ tabs · Alt+←→ entry · Alt+PgUp/Dn scroll · Alt+D hide
        </text>
      </box>
    </box>
  )
}
