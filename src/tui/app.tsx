import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { jobNote, onJobExit } from "../tool/jobs.ts"
import { stricterMode, type App as Runtime } from "../app.ts"
import { isLocal } from "../config/paths.ts"
import type { Effort, Mode } from "../config/schema.ts"
import { COMMANDS, findCommand, type CommandCtx } from "./commands.ts"
import { Dialog, type DialogSpec } from "./components/dialog.tsx"
import { Messages } from "./components/messages.tsx"
import { PermissionPrompt } from "./components/permission.tsx"
import { copiedMessage, copyText } from "./clipboard.ts"
import { QuestionCard } from "./components/question.tsx"
import { PlanCard } from "./components/plancard.tsx"
import { PlanPanel } from "./components/plan.tsx"
import { Prompt, type PaletteEntry } from "./components/prompt.tsx"
import { FileIndex } from "../project/files.ts"
import { attachmentsFor } from "../project/attach.ts"
import { customCommands, expandCommand, type CustomCommand } from "../project/commands.ts"
import { skillMessage, slug } from "../skill/index.ts"
import { keyMatcher, VoiceController } from "../voice/index.ts"
import { hardlineCommand } from "../permission/hardline.ts"
import { CONTINUE_PROMPT } from "../session/engine.ts"
import { bashTool } from "../tool/bash.ts"
import { MODES } from "../config/schema.ts"
import { Queued, Spinner } from "./components/spinner.tsx"
import { StatusBar } from "./components/status.tsx"
import { currentBranch } from "../git/branch.ts"
import { Welcome } from "./components/welcome.tsx"
import { Share, type SharedPrompt } from "../acp/share.ts"
import { mentionInfo } from "../acp/prompt.ts"
import { TuiContext, type Ctx } from "./context.ts"
import type { View } from "./state.ts"
import { loadTheme, markdownStyle, paintBackground, reasoningStyle, themeNames, type IconSet, type Theme } from "./theme.ts"

const CYCLE: Mode[] = ["manual", "edit", "plan"]

export function Root(p: { app: Runtime; view: View; theme: Theme; onQuit: () => void; onReload?: (args: string[]) => void }) {
  const renderer = useRenderer()
  const { app, view } = p
  const [theme, setThemeSignal] = createSignal(p.theme)
  let icons: IconSet | undefined = app.loaded.config.icons
  const [background, setBackground] = createSignal(app.loaded.config.theme_background)
  createEffect(() => paintBackground(renderer, theme(), background()))
  const md = createMemo((prev?: ReturnType<typeof markdownStyle>) => {
    prev?.destroy()
    return markdownStyle(theme())
  })
  const thought = createMemo((prev?: ReturnType<typeof reasoningStyle>) => {
    prev?.destroy()
    return reasoningStyle(theme())
  })
  const [dialog, setDialog] = createSignal<DialogSpec>()
  // The engine is not reactive; this signal is bumped whenever its model/mode/effort change.
  const [rev, setRev] = createSignal(0)
  const refresh = () => setRev((n) => n + 1)
  const mode = () => (rev(), app.engine.mode)
  const model = () => (rev(), app.engine.model.ref)
  const effort = () => (rev(), app.engine.effort ?? "")
  const busy = () => view.state.phase !== "idle"
  const branch = () => (rev(), app.project.gitRoot ? currentBranch(app.project.gitRoot) : undefined)
  // A word in the status bar that goes by itself (a copy): it says something happened without
  // putting a line into the conversation.
  const [flashText, setFlashText] = createSignal<string>()
  let flashTimer: ReturnType<typeof setTimeout> | undefined
  const flash = (text: string, ms = 2500) => {
    setFlashText(text)
    clearTimeout(flashTimer)
    flashTimer = setTimeout(() => setFlashText(undefined), ms)
  }
  onCleanup(() => clearTimeout(flashTimer))
  // A mode changed inside a turn (a plan approved) must reach the status bar; so must a branch the
  // model switched with git.
  app.bus.on((e) => (e.type === "mode" || e.type === "done") && refresh())
  app.bus.on((e) => e.type === "flash" && flash(e.text, 6000))
  // A setting changed by the agent, /settings or a command: show it. Theme and icons are drawn here.
  app.bus.on((e) => {
    if (e.type !== "setting") return
    if (e.key === "theme") setThemeSignal(loadTheme(String(e.value), icons).theme)
    if (e.key === "theme_background") setBackground(e.value as "theme" | "terminal")
    if (e.key === "icons") {
      icons = e.value as IconSet
      setThemeSignal(loadTheme(theme().name, icons).theme)
    }
    refresh()
  })
  app.settings.checks.set("theme", (v) => {
    if (!themeNames().includes(String(v))) throw new Error(`no theme "${v}" — ${themeNames().join(", ")}`)
  })
  let scroll: ScrollBoxRenderable | undefined
  let input: TextareaRenderable | undefined
  let quitArmed = 0

  const dims = useTerminalDimensions()
  const ctx: Ctx = { app, view, theme, md, thought, dims }

  // Voice: the record key, what was heard, replies read aloud.
  const voiceCfg = app.loaded.config.voice
  const recordKey = keyMatcher(voiceCfg?.record_key)
  if (recordKey.warning) view.info(recordKey.warning, "warn")
  const [voiceRev, setVoiceRev] = createSignal(0)
  let meter: ReturnType<typeof setInterval> | undefined
  const voice = new VoiceController(voiceCfg, {
    changed: () => {
      setVoiceRev((n) => n + 1)
      // While recording, the meter and the clock move.
      if (voice.state === "recording" && !meter) meter = setInterval(() => setVoiceRev((n) => n + 1), 150)
      if (voice.state !== "recording" && meter) (clearInterval(meter), (meter = undefined))
    },
    heard: (text) => {
      // Sent as words, never as a command: a transcript that starts with "/" or "!" is still speech.
      if (voiceCfg?.submit === "send" && app.turns.steer(text)) return
      if (voiceCfg?.submit === "send" && !busy()) return void send(text)
      const now = input?.plainText ?? ""
      input?.setText(now.trim() ? `${now.replace(/\s+$/, "")} ${text}` : text)
      input?.gotoBufferEnd()
    },
    notice: (m, warn) => view.info(m, warn ? "warn" : undefined),
  })
  onCleanup(() => {
    if (meter) clearInterval(meter)
    void voice.close()
  })
  // A background job that ends wakes the session (after LLeMbas): mid-task the model is
  // told at its next step; idle, the note starts a turn of its own, as if the user had said it —
  // shown as what it is. What the note hands over counts as read, so bash_output does not repeat it.
  const stopJobs = onJobExit((job) => {
    const text = jobNote(job)
    job.read = job.output.length
    if (app.turns.current || busy()) app.engine.note(text)
    else void send(text, `⏎ ${job.id} finished${job.exit === null ? " (killed)" : ` (exit ${job.exit})`}`, "")
  })
  onCleanup(stopJobs)
  // A finished reply is read out when replies are spoken.
  app.bus.on((e) => {
    if (e.type !== "done" || e.reason !== "stop" || !voice.speakReplies) return
    const last = [...app.engine.messages].reverse().find((m) => m.role === "assistant")
    const text = last && last.role === "assistant" ? last.parts.map((x) => (x.type === "text" ? x.text : "")).join("") : ""
    if (text.trim()) void voice.speak(text)
  })
  const voiceStatus = () => {
    voiceRev()
    rev()
    if (voice.state === "recording") {
      const bars = " ▁▂▃▄▅▆▇"
      const s = Math.floor(voice.seconds)
      return `● REC ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} ${bars[Math.min(7, Math.floor((Math.min(voice.level, 8000) * 7) / 8000))]} ${recordKey.label} stops`
    }
    if (voice.state === "transcribing") return "◉ transcribing"
    if (voice.speaking) return `${theme().icons.speaker} speaking · esc stops`
    if (!voice.canListen && !voice.speakReplies) return ""
    return `${voice.canListen ? `${theme().icons.mic} ${recordKey.label}` : ""}${voice.speakReplies ? `${voice.canListen ? " · " : ""}${theme().icons.speaker} on` : ""}`
  }

  const cmd: CommandCtx = {
    ...ctx,
    voice,
    openDialog: (spec) => setDialog(spec),
    setMode(m: Mode) {
      app.settings.set("mode", m)
    },
    setEffort(e: Effort | null) {
      app.settings.set("effort", e ?? "off")
    },
    setTheme(name: string) {
      try {
        app.settings.set("theme", name, "global")
      } catch (e) {
        view.info((e as Error).message, "warn")
      }
    },
    setIcons(set: IconSet) {
      app.settings.set("icons", set, "global")
    },
    flash,
    refresh,
    quit: () => p.onQuit(),
    reload() {
      if (!p.onReload) return view.info("/reload is not available here", "warn")
      // Back on this session, with what it was using; everything else comes from the files again.
      const e = app.engine
      const args = [...(isLocal() ? ["-l"] : []), ...(e.sessionId ? ["-s", e.sessionId] : []), "-m", e.model.ref, "--mode", e.mode, "-e", e.effort ?? "off"]
      void app
        .close()
        .catch(() => {})
        .finally(() => {
          app.store?.db.close()
          p.onReload!(args)
        })
    },
    copy: (text: string) => copy(text),
    renderer,
    send: (text: string) => void send(text),
    share: undefined as Share | undefined,
    continueTask: () => continueTask(),
    sendAs: (prompt: string, shown: string, opts?: { model?: string; mode?: string }) => void sendAs(prompt, shown, opts),
    setInput(text: string) {
      input?.setText(text)
      input?.gotoBufferEnd()
    },
  }

  const files = new FileIndex(app.project.root)
  const custom = () => customCommands(app.trusted ? app.project.dir : undefined)
  // A skill is also a command, /<its name>, unless a built-in or custom command has the name
  // (then /skill <name> reaches it) — Hermes' rule.
  const skillCommands = () => {
    const taken = new Set(custom().map((c) => c.name))
    return app.skills().filter((s) => !findCommand(slug(s.name)) && !taken.has(slug(s.name)))
  }
  const palette = (): PaletteEntry[] => [
    ...COMMANDS.map((c) => ({ name: c.name, args: c.args, description: c.description, source: "builtin" as const })),
    ...custom().filter((c) => !findCommand(c.name)).map((c) => ({ name: c.name, description: c.description, source: c.source, args: c.body.includes("$") ? "[args]" : undefined })),
    ...skillCommands().map((s) => ({ name: slug(s.name), description: s.description.slice(0, 80), source: "skill" as const, args: "[instruction]" })),
    ...app.mcp.prompts().map((m) => ({ name: m.name, description: m.description.slice(0, 80), source: "mcp" as const, args: m.args.length ? m.args.map((a) => `<${a}>`).join(" ") : undefined })),
  ]

  /** Send a prompt: @references attached, snapshots around it. `shown` is what the transcript says.
   *  `attachFrom`: where @references are read from, when not all of `text` is the user's — an MCP
   *  server's prompt or a skill must not attach ~/.ssh/… by naming it. `given`: a prompt from the web
   *  UI, its attachments read already and its turn id its own. */
  const send = (text: string, shown = text, attachFrom = text, given?: Pick<SharedPrompt, "extra" | "attachments" | "turnId">): Promise<string> => {
    voice.stopSpeaking()
    const atts = given ? [] : attachmentsFor(attachFrom, app.engine.o.toolCtx, app.engine.model.spec.vision === true)
    for (const a of atts) files.used(a.path)
    view.user(shown)
    if (atts.length) view.info(`attached ${atts.map((a) => (a.image ? `${a.path} (image)` : a.text.includes("not attached") ? `${a.path} (not attached: ${/not attached: ([^)]*)/.exec(a.text)?.[1]})` : a.path)).join(", ")}`)
    if (given?.attachments.length) view.info(`attached ${given.attachments.map((a) => a.name).join(", ")}`)
    scroll?.scrollTo(scroll.scrollHeight)
    const extra = given ? given.extra : atts.flatMap((a) => (a.image ? [a.text, a.image] : [a.text]))
    // Chips for the web UI, when this session is shared: what went with the prompt.
    const attachments = given ? given.attachments : atts.map((a) => mentionInfo(a.path, app.engine.o.toolCtx.cwd))
    return app.turns
      .prompt(text, extra, shown, { ...(given ? { turnId: given.turnId } : {}), attachments })
      .then((reason) => {
        // What was sent during the task and never reached the model: stopped — back into the box,
        // to edit or send; otherwise (queue mode, or a turn that ended first) — sent now. After a
        // tick, so a command's own model and mode (sendAs) are put back first.
        // A job that ended as the task did: its own turn now.
        const notes = app.engine.takeNotes()
        // Stopped: they go with the next message instead of starting work nobody asked for now.
        if (notes.length && reason === "cancelled") app.engine.pendingContext.push(...notes)
        else if (notes.length) setTimeout(() => void send(notes.join("\n\n"), `⏎ ${notes.length} background job${notes.length === 1 ? "" : "s"} finished`, ""), 0)
        const left = app.turns.takeInbox()
        if (!left.length) return reason
        const joined = left.join("\n\n")
        if (reason === "cancelled") {
          const now = input?.plainText.trim() ?? ""
          input?.setText(now ? `${joined}\n\n${now}` : joined)
          input?.gotoBufferEnd()
          view.info("stopped — what you sent meanwhile is back in the box")
        } else setTimeout(() => void send(joined), 0)
        return reason
      })
      .catch((e) => (view.info((e as Error).message, "warn"), "error"))
  }

  // The web UI as a second keyboard on this session: shared through the service by itself,
  // or by name with /remote. What it sends runs here as if typed, and is shown as such.
  // The account's balance in the status bar, when it has a plan: read at the start and
  // after a reply, at most once a minute; an instance that cannot say leaves nothing there.
  const [credits, setCredits] = createSignal("")
  let creditsAt = 0
  const readCredits = (force = false) => {
    if (!force && Date.now() - creditsAt < 60_000) return
    creditsAt = Date.now()
    void import("../lembas/personal.ts").then((m) => m.accountUsage(5000).then((r) => setCredits(m.balanceLabel(r?.usage)))).catch(() => {})
  }
  readCredits(true)
  app.bus.on((e) => e.type === "task" && e.state === "end" && readCredits())
  cmd.setCredits = (text: string) => {
    creditsAt = Date.now()
    setCredits(text)
  }

  const share = new Share(app, {
    prompt: async (input, started) => {
      // Working already: it runs when this turn is done, as a message typed in queue mode
      // would. It used to be refused, and the web UI lost it to an error.
      while (busy() || app.turns.current) await Bun.sleep(150)
      started()
      view.info("↓ from the web UI")
      // Expanded already (a command, @files, uploads); a command's model and mode hold for
      // this prompt only, as when it is typed here.
      if (input.model || input.mode) return sendAs(input.prompt, input.shown, { model: input.model, mode: input.mode, given: input })
      return send(input.prompt, input.shown, "", input)
    },
    action: async (name) => {
      view.info(`↓ /${name} from the web UI`)
      if (name === "compact") {
        const summary = await app.engine.compact()
        view.clear()
        view.info(`compacted in the web UI — the model continues from this summary:\n\n${summary}`)
        return { summary }
      }
      if (name === "undo") {
        const r = app.turns.undo()
        if (r) view.load(app.engine.messages)
        view.info(r ? (r.files.length ? `undone — restored ${r.files.join(", ")}` : "undone — no files had changed") : "nothing to undo in this session")
        return { undone: r ?? null }
      }
      cmd.setMode("plan")
      return { mode: "plan" }
    },
    compact: async () => {
      view.info("compacting… (asked in the web UI)")
      const summary = await app.engine.compact()
      view.clear()
      view.info(`compacted in the web UI — the model continues from this summary:\n\n${summary}`)
      return summary
    },
    deleted: () => {
      app.newSession()
      view.clear()
      view.info("the web UI deleted that session — this is a new one", "warn")
    },
    notice: (text, level) => view.info(text, level),
    changed: () => refresh(),
    rewound: () => view.load(app.engine.messages),
  })
  cmd.share = share
  view.setCardHooks({
    ask: (req, local) => share.ask(req, local),
    question: (req, callId, local) => share.question(req, callId, local),
    plan: (req, callId, local) => share.plan(req, callId, local),
  })
  void share.start()
  onCleanup(() => share.close())

  const shell = (command: string): boolean | void => {
    if (busy()) return (view.info("still working — esc stops the current reply; !commands wait for it", "warn"), false)
    const hit = hardlineCommand(command, app.engine.o.perm.hardline)
    if (hit) return view.info(`not run — ${hit.description}`, "warn")
    // Not through the engine's events: this is the user's own command, not a model turn, and the
    // view must not go busy for it.
    const id = view.shellStart(command)
    const t0 = performance.now()
    bashTool
      .run({ command }, { ...app.engine.o.toolCtx, signal: new AbortController().signal })
      .then((r) => {
        view.shellEnd(id, r, performance.now() - t0)
        app.engine.pendingContext.push(`<shell command="${command.replaceAll('"', "'")}">\n${r.output}\n</shell>`)
        view.info("the output goes to the model with your next message (ctrl+o shows it here)")
      })
      .catch((e) => view.info(`! failed: ${(e as Error).message}`, "warn"))
  }

  /** false: refused — the text stays in the box. */
  const submit = (text: string): boolean | void => {
    const t = text.trim()
    if (t.startsWith("!") && t.length > 1) return shell(t.slice(1).trim())
    if (t.startsWith("/")) {
      const [name, ...rest] = t.slice(1).split(/\s+/)
      const arg = rest.join(" ")
      const c = findCommand(name ?? "")
      if (c) {
        // Not mid-task: what changes the session under it, and what sends a prompt of its own
        // (that would start a second turn on top of the running one).
        const midTask = ["new", "delete", "compact", "sessions", "model", "undo", "redo", "commit", "diff", "release", "changelog", "init", "checkpoint", "checkpoints", "branch", "reload", "review", "skill"]
        if ((busy() || app.turns.current) && (midTask.includes(c.name) || (c.name === "plan" && arg && arg !== "show"))) return (view.info("wait for the reply to finish (esc stops it)", "warn"), false)
        return void c.run(cmd, arg)
      }
      const cc = custom().find((x) => x.name === name)
      const sk = cc ? undefined : skillCommands().find((s) => slug(s.name) === slug(name ?? ""))
      const mp = cc || sk ? undefined : app.mcp.prompts().find((m) => m.name === name)
      if (!cc && !sk && !mp) return view.info(`no command /${name} — /help lists them`, "warn")
      if (busy() || app.turns.current) return (view.info("still working — esc stops the current reply; commands wait for it", "warn"), false)
      if (mp)
        return void app.mcp
          .promptText(mp, arg)
          .then((text) => void (text.trim() ? sendAs(text, t, { attachFrom: arg }) : view.info(`/${name}: the prompt came back empty`, "warn")))
          .catch((e) => view.info(`/${name}: ${(e as Error).message}`, "warn"))
      if (sk) return void sendAs(skillMessage(sk, arg), t, { attachFrom: arg })
      return void runCustom(cc!, arg, t)
    }
    // While a task runs, a message joins it: at the next step, or after it (queue).
    if (app.turns.steer(t)) return
    if (busy()) return (view.info("still working — esc stops the current reply", "warn"), false)
    void send(t)
  }

  /** The messages waiting to go in, for ↑ in the box. */
  const queueAccess = {
    count: () => app.engine.queued,
    take: (i: number) => app.engine.unqueue(i),
    putBack: (i: number, text: string) => app.engine.putBack(i, text),
  }

  /** Carry on where it stopped: after esc, a step limit, or an answer that ended too soon. What
   *  it had written before a stop is in the history (the engine keeps it), so it can pick up there. */
  const continueTask = () => {
    if (busy() || app.turns.current) return view.info("it is still working — esc stops it; ctrl+g carries on after that", "warn")
    if (!app.engine.messages.length) return view.info("nothing to continue yet — send a prompt first", "warn")
    void send(CONTINUE_PROMPT, "↻ continue")
  }

  /** Send a prompt with a model and/or mode that hold for this one prompt only. */
  const sendAs = async (prompt: string, shown: string, opts: { model?: string; mode?: string; attachFrom?: string; given?: Parameters<typeof send>[3] } = {}) => {
    const prev = { model: app.engine.model.ref, mode: app.engine.mode, effort: app.engine.effort }
    try {
      if (opts.model) app.switchModel(opts.model)
      if (opts.mode && (MODES as readonly string[]).includes(opts.mode)) app.engine.mode = opts.mode as Mode
      refresh()
      return await send(prompt, shown, opts.attachFrom ?? prompt, opts.given)
    } catch (e) {
      view.info(`${shown.split(" ")[0]}: ${(e as Error).message}`, "warn")
      return "error"
    } finally {
      // The effort as it was too: switching back would set the model's default.
      if (opts.model) {
        app.switchModel(prev.model)
        app.engine.effort = prev.effort
      }
      app.engine.mode = prev.mode
      refresh()
    }
  }

  /** A custom command: its expanded body is the prompt; its frontmatter's model and mode hold for
   *  this one prompt. */
  const runCustom = (cc: CustomCommand, arg: string, typed: string) =>
    sendAs(expandCommand(cc, arg, app.project.root, app.engine.o.perm.hardline), typed, {
      // @files come from what was typed, not from the command's own text.
      attachFrom: arg,
      model: cc.model,
      // A project's command may make the mode stricter for its prompt, never looser; your own may.
      mode: cc.source === "project" && cc.mode && (MODES as readonly string[]).includes(cc.mode) ? stricterMode(cc.mode as Mode, app.engine.mode) : cc.mode,
    })

  const holdToTalk = voiceCfg?.record_mode === "hold"
  let lastPress = 0
  useKeyboard(
    (key) => {
      if (key.eventType === "release") {
        // Hold-to-talk: letting go of the key stops the recording (the modifier may go first).
        if (holdToTalk && voice.state === "recording" && recordKey.released(key)) void voice.toggle()
        return
      }
      // A card or dialog owns the keyboard: esc there means that card's own thing.
      const overlay = dialog() || view.state.pending || view.state.question || view.state.plan
      if (!overlay && recordKey.matches(key) && (voice.canListen || voiceCfg)) {
        key.preventDefault()
        // Held down, a key repeats: in hold mode (or any repeat) only the first press counts.
        const now = Date.now()
        const repeat = key.repeated || (holdToTalk && now - lastPress < 500)
        lastPress = now
        if (!repeat) void voice.toggle()
        return
      }
      if (overlay) return keys(key)
      if (key.name === "escape" && voice.state === "recording") {
        void voice.cancel().then(() => view.info("recording cancelled"))
        return key.preventDefault()
      }
      if (key.name === "escape" && voice.speaking) {
        voice.stopSpeaking()
        return key.preventDefault()
      }
      keys(key)
    },
    { release: holdToTalk },
  )

  const keys = (key: Parameters<Parameters<typeof useKeyboard>[0]>[0]) => {
    if (dialog() || view.state.pending || view.state.question || view.state.plan) return
    if (key.name === "escape" && busy()) {
      app.cancel()
      key.preventDefault()
    } else if (key.ctrl && key.name === "c" && (key.shift || renderer.hasSelection)) {
      // Ctrl+Shift+C (where the terminal passes it on), or Ctrl+C over a selection: copy it.
      const sel = renderer.getSelection()?.getSelectedText() ?? ""
      if (sel) copy(sel)
      else flash("nothing selected — drag over text, or /copy the last reply")
      renderer.clearSelection()
      key.preventDefault()
    } else if (key.ctrl && key.name === "c") {
      // The first press stops the model (if busy); a second within 1.5 s always quits.
      if (Date.now() - quitArmed < 1500) p.onQuit()
      else {
        if (busy()) app.cancel()
        quitArmed = Date.now()
        view.info("ctrl+c again to quit")
      }
      key.preventDefault()
    } else if (key.name === "tab" && key.shift) {
      const i = CYCLE.indexOf(app.engine.mode)
      cmd.setMode(CYCLE[(i + 1) % CYCLE.length]!)
      key.preventDefault()
    } else if (key.ctrl && key.name === "g") {
      continueTask()
      key.preventDefault()
    } else if (key.ctrl && key.name === "r") {
      view.toggleReasoning()
      key.preventDefault()
    } else if (key.ctrl && key.name === "o") {
      view.toggleTools()
      key.preventDefault()
    } else if (key.name === "pageup") {
      // Half a screen: a whole one loses the place.
      scroll?.scrollBy(-Math.max(1, Math.floor(scroll.height / 2)))
      key.preventDefault()
    } else if (key.name === "pagedown") {
      scroll?.scrollBy(Math.max(1, Math.floor(scroll.height / 2)))
      key.preventDefault()
    } else if (key.ctrl && (key.name === "up" || key.name === "down")) {
      scroll?.scrollBy(key.name === "up" ? -3 : 3)
      key.preventDefault()
    }
  }
  // What the mouse selects is copied when the button comes up (see clipboard.ts). It is said in
  // the status bar for a moment, never as a line of the transcript: a line there lands in the
  // middle of a reply and splits a thinking block that is still running. Only a copy that could
  // not go anywhere is a transcript line, since it says what to do instead.
  const copy = (text: string) => {
    if (!text) return
    const m = copiedMessage(text.length, copyText(renderer as never, text))
    if (m.warn) view.info(m.text, "warn")
    else flash(m.text)
  }
  const onSelection = (sel: { getSelectedText(): string } | null) => {
    const text = sel?.getSelectedText() ?? ""
    if (text.trim()) copy(text)
  }
  renderer.on("selection", onSelection)
  onCleanup(() => renderer.off("selection", onSelection))

  return (
    <TuiContext.Provider value={ctx}>
      <box flexDirection="column" width="100%" height="100%">
        <scrollbox
          ref={(r: ScrollBoxRenderable) => (scroll = r)}
          flexGrow={1}
          stickyScroll
          stickyStart="bottom"
          viewportOptions={{ paddingRight: 1 }}
          verticalScrollbarOptions={{ trackOptions: { backgroundColor: theme().colors.panel, foregroundColor: theme().colors.dim } }}
        >
          <Welcome />
          <Messages />
        </scrollbox>
        <box flexShrink={0} flexDirection="column">
          <PlanPanel />
          <Show when={view.state.pending}>
            <PermissionPrompt pending={view.state.pending!} />
          </Show>
          <Show when={view.state.question && !view.state.pending}>
            <QuestionCard pending={view.state.question!} />
          </Show>
          <Show when={view.state.plan && !view.state.pending && !view.state.question}>
            <PlanCard pending={view.state.plan!} />
          </Show>
          <Show when={busy() && !view.state.pending && !view.state.question && !view.state.plan}>
            <Spinner />
          </Show>
          <Queued />
          <Prompt focused={() => !dialog() && !view.state.pending && !view.state.question && !view.state.plan} busy={busy} commands={palette} files={files} onSubmit={submit} ref={(r) => (input = r)} queue={queueAccess} onWheel={(dir, lines) => scroll?.scrollBy(dir * lines)} />
          <StatusBar mode={mode} model={model} effort={effort} branch={branch()} voice={voiceStatus} flash={flashText} remote={() => (rev(), share.label())} credits={credits} />
        </box>
        <Show when={dialog()}>
          <Dialog spec={dialog()!} close={() => setDialog(undefined)} />
        </Show>
      </box>
    </TuiContext.Provider>
  )
}
