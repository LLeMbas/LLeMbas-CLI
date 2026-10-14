import { createCliRenderer } from "@opentui/core"
import { render, useRenderer } from "@opentui/solid"
import { createEffect, createSignal, Match, Show, Switch } from "solid-js"
import { createApp, type AppOptions, type App } from "../app.ts"
import { ConfigError, loadConfig } from "../config/load.ts"
import { ModelError } from "../provider/index.ts"
import { autoUpdate } from "../update/index.ts"
import { isLocal } from "../config/paths.ts"
import { Setup } from "./components/setup.tsx"
import { Bus } from "../bus/index.ts"
import { findProject, trustOf } from "../project/root.ts"
import { Root } from "./app.tsx"
import { discardOnExit, releaseForResume } from "../acp/share.ts"
import { FirstRun } from "./components/firstrun.tsx"
import { TuiContext } from "./context.ts"
import { createView } from "./state.ts"
import { DEFAULT_THEME, loadTheme, markdownStyle, paintBackground, reasoningStyle } from "./theme.ts"

export interface TuiOptions extends Omit<AppOptions, "asker"> {
  /** Resume this session id, or "last" for the newest in this project. */
  resume?: string
}

/** Everything that exists before the session: the first-run questions, then the app. */
export function Boot(p: { options: TuiOptions; onQuit: () => void; onReload?: (args: string[]) => void; firstRun?: boolean; onApp?: (a: App) => void }) {
  const bus = p.options.bus ?? new Bus()
  const view = createView(bus)
  const [app, setApp] = createSignal<App>()
  const [theme, setTheme] = createSignal(DEFAULT_THEME)
  // The setup and first-run screens are painted too; once the app is up, Root takes over.
  const renderer = useRenderer()
  let background: "theme" | "terminal" | undefined
  try {
    background = loadConfig().config.theme_background
  } catch {}
  createEffect(() => !app() && paintBackground(renderer, theme(), background))
  // No model yet, or a config file that cannot be read: a screen that says so, not an exception.
  const [setup, setSetup] = createSignal<Error>()
  let firstNotes: string[] = []

  const start = (notes: string[]) => {
    firstNotes = notes
    let a: App
    // `-s <id>`: the app opens for that session and makes none first — the one it made was
    // left behind, empty, every time. `-c` cannot know its session before the app has a store, so
    // it makes one, and the resume discards it (app.ts, discardEmpty).
    const explicit = p.options.resume && p.options.resume !== "last" ? p.options.resume : undefined
    try {
      a = createApp({ ...p.options, asker: view.asker, bus, ...(explicit ? { resuming: explicit } : {}) })
    } catch (e) {
      if (e instanceof ModelError || e instanceof ConfigError) return void setSetup(e)
      throw e
    }
    setSetup(undefined)
    const { theme: s, warning } = loadTheme(a.loaded.config.theme, a.loaded.config.icons)
    setTheme(s)
    if (warning) view.info(warning, "warn")
    for (const w of a.loaded.warnings) view.info(w, "warn")
    for (const n of notes) view.info(n)
    const resume = p.options.resume
    if (resume) {
      // The last one somebody said something in: not the empty one an earlier start left.
      const id = resume === "last" ? a.store?.sessions(2, a.project.root, true).find((s) => s.id !== a.engine.sessionId)?.id : resume
      // Opened for a session that cannot be had after all: a new one, as any start has.
      const fresh = (why: string) => {
        view.info(why, "warn")
        if (!a.engine.sessionId) a.newSession()
      }
      if (explicit && a.store && !a.store.session(explicit)) fresh(`no session ${explicit} — a new one instead`)
      // A session the web UI runs here (the service) is let go of first, so it is carried on
      // rather than forked.
      else if (id)
        void releaseForResume(id).then((why) => {
          if (why) fresh(`not resumed: ${why}`)
          else view.load(a.resume(id))
        })
      else fresh("no earlier session in this project to continue")
    }
    setApp(a)
    p.onApp?.(a)
    // An update, looked for once the session is up, and only said when there is something to say.
    // Not in local mode: an update writes outside the project.
    const update = a.loaded.config.update
    if (!isLocal()) void autoUpdate({ config: update }).then((r) => {
      if (r.kind === "installed") {
        view.info(`Updated to ${r.version} — /reload to restart in the latest ${update?.channel ?? "stable"}`)
        bus.emit({ type: "flash", text: `updated to ${r.version} · /reload` })
      } else if (r.kind === "available") view.info(`LLeMbas CLI ${r.version} is out — \`lembas update\` installs it`)
      else if (r.kind === "failed" && r.security) view.info(`update refused: ${r.reason}`, "warn")
      else if (r.kind === "failed" && r.repeated) view.info(`${r.reason} — lembas update says more`, "warn")
    })
  }

  const project = findProject(p.options.cwd)
  const needsFirstRun = p.firstRun ?? trustOf(project.root) === undefined
  if (!needsFirstRun) start([])

  return (
    <Show
      when={app()}
      fallback={
        <TuiContext.Provider value={{ theme, md: () => markdownStyle(theme()), thought: () => reasoningStyle(theme()), dims: () => ({ width: process.stdout.columns ?? 80, height: process.stdout.rows ?? 24 }) } as never}>
          <Switch>
            <Match when={setup()}>
              <Setup error={setup()!} onRetry={() => start(firstNotes)} onQuit={p.onQuit} />
            </Match>
            <Match when={true}>
              <FirstRun project={project} onDone={(r) => (r.quit ? p.onQuit() : start(r.notes))} />
            </Match>
          </Switch>
        </TuiContext.Provider>
      }
    >
      <Root app={app()!} view={view} theme={theme()} onQuit={p.onQuit} onReload={p.onReload} />
    </Show>
  )
}

/** 12 frames a second where the terminal has no synchronized output, else OpenTUI's 30 (at most 60). */
export function frameRateFor(r: { targetFps: number; maxFps: number }, caps: { sync?: boolean }) {
  r.targetFps = caps.sync === false ? 12 : 30
  r.maxFps = caps.sync === false ? 12 : 60
}

/** Returns when the TUI is closed; `reload`: the arguments to start again with (/reload). */
export async function runTui(o: TuiOptions): Promise<{ reload?: string[] }> {
  // Key-release events (kitty protocol) only for hold-to-talk: they change how every key arrives.
  let hold = false
  let mouse = true
  try {
    const { config } = loadConfig()
    hold = config.voice?.record_mode === "hold"
    mouse = config.mouse !== false
  } catch {}
  const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30, useKittyKeyboard: hold ? { events: true } : {}, autoFocus: false, useMouse: mouse })
  // A terminal without synchronized output (VTE: GNOME Terminal, LXTerminal, Tilix) paints each
  // frame as it arrives, so a streaming reply that scrolls the screen tears and seems to jump.
  // Fewer frames tear less. The answers arrive one by one and `sync` is false until the terminal's
  // answer about it comes in, so the rate follows every update rather than the first.
  renderer.on("capabilities", (caps: { sync?: boolean }) => frameRateFor(renderer, caps))
  let done: () => void
  const finished = new Promise<void>((r) => (done = r))
  const quit = () => {
    if (!renderer.isDestroyed) renderer.destroy()
    done()
  }
  renderer.once("destroy", () => done())
  let reload: string[] | undefined
  let app: App | undefined
  const onReload = (args: string[]) => {
    reload = args
    quit()
  }
  process.once("SIGHUP", quit)
  process.once("SIGTERM", quit)
  // Whatever goes wrong while the TUI holds the terminal, the terminal is given back first —
  // mouse reporting off, the normal screen, the cursor — and only then is the error printed.
  // Left on, every move of the mouse types escape codes into the shell afterwards.
  const fatal = (e: unknown) => {
    if (!renderer.isDestroyed) renderer.destroy()
    process.stderr.write(`lembas: ${e instanceof ModelError || e instanceof ConfigError ? e.message : e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`)
    process.exit(1)
  }
  process.on("uncaughtException", fatal)
  process.on("unhandledRejection", fatal)
  try {
    await render(() => <Boot options={o} onQuit={quit} onReload={onReload} onApp={(a) => (app = a)} />, renderer)
  } catch (e) {
    fatal(e)
  }
  await finished
  // Every way out — /quit, ctrl+c twice, ctrl+d, SIGTERM, SIGHUP — ends here, after the renderer
  // and with it the Share are gone: a session nobody said anything in goes with the
  // terminal. Not on /reload, which starts again on this very session. Bounded: leaving must not
  // hang on a hub that does not answer.
  if (!reload && app?.store) await Promise.race([discardOnExit(app.store, app.engine.sessionId).catch(() => false), Bun.sleep(8000)])
  return { reload }
}
