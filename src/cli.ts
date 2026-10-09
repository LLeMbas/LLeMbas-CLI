#!/usr/bin/env bun
import { existsSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { createApp } from "./app.ts"
import { attachmentsFor } from "./project/attach.ts"
import { ConfigError, loadConfig } from "./config/load.ts"
import { asMode, EFFORTS, MODES, type Effort, type Mode } from "./config/schema.ts"
import { SettingError } from "./config/settings.ts"
import { renderJson, renderPlain, terminalAsker } from "./headless.ts"
import { findProject, setTrust, trustOf } from "./project/root.ts"
import { effortsFor } from "./provider/effort.ts"
import { clientFor, ModelError, resolveModel } from "./provider/index.ts"
import { Store } from "./session/store.ts"
import { promptTitle } from "./session/title.ts"
import { VERSION } from "./version.ts"

const HELP = `lembas ${VERSION} — terminal coding agent and project manager

Usage:
  lembas [-m model] [--mode M] [-c | -s id]
                                  the TUI (-c continues the last session here, -s resumes one)
  lembas run [options] "…"        one prompt, headless
  lembas models [--discover]      list configured models
  lembas sessions                 list recent sessions
  lembas sessions delete <id>…    delete sessions, here and in the web UI
  lembas sessions prune [--dry-run]
                                  delete every session nobody said anything in, but the last
                                  hour's (--dry-run: list them)
  lembas config check             validate ~/.config/lembas
  lembas config list | get <key> | set <key> <value> [--project]
                                  settings (the same as /settings in the TUI)
  lembas config schema [--link]
                                  write JSON Schemas for editors (--link: point the files at them)
  lembas login [address] [--ca file] [--default] [--keep-services]
                                  sign in to a LLeMbas instance: its models, voice and search
                                  (again: read them now; --default pins its default model)
  lembas logout [connection]      sign out of one, and remove what login wrote
  lembas serve --stdio            an ACP agent on stdin/stdout, for an editor that speaks ACP
  lembas service install | uninstall | status | logs [-f] | run
                                  work from a LLeMbas instance as a background service (remote:)
  lembas mcp [list]               connect the MCP servers and list their tools and prompts
  lembas mcp auth <server>        sign in to a remote MCP server (OAuth)
  lembas mcp logout <server>      forget a server's stored sign-in
  lembas voice [check]            what voice input and output use
  lembas voice say "…" [-o f]     speak (or write a WAV); voice transcribe <file>
  lembas trust [--readonly]       trust the current project (its .agent/ config is then honoured)
  lembas update [--check] [--channel stable|beta] [vX.Y.Z] [--rollback]
                                  install the newest release (or that one; --rollback: the one before)
  lembas kb [create|add|docs|search|rm|reindex]
                                  knowledge bases the agent can search (lembas kb help)
  lembas uninstall [--purge] [--yes]
                                  remove LLeMbas CLI (--purge: settings, sessions and memory too)
  lembas --version
  lembas --licenses               the licences of everything this binary contains

Options for run:
  -m, --model conn/model    model to use (default: config.yaml \`model\`)
      --mode MODE           manual | edit | auto | plan
  -e, --effort LEVEL        ${EFFORTS.join(" | ")} | off
  -y, --yes                 approve every ask (still never the hardline)
      --json                events as JSON lines
      --reasoning           show the model's reasoning
      --no-store            do not record the session
`

function fail(msg: string, code = 1): never {
  process.stderr.write(`lembas: ${msg}\n`)
  process.exit(code)
}

async function loginCommand(cmd: "login" | "logout", args: string[]) {
  const { codeInstructions, instances, isWebuiEntry, login, loginSummary, logout, sync, LembasError } = await import("./lembas/login.ts")
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { ca: { type: "string" }, default: { type: "boolean" }, "keep-services": { type: "boolean" } },
  })
  const known = instances()
  try {
    if (cmd === "logout") {
      const name = positionals[0] ?? (Object.keys(known).length === 1 ? Object.keys(known)[0]! : "")
      if (!name) fail(Object.keys(known).length ? `which one? lembas logout <${Object.keys(known).join("|")}>` : "not logged in to any instance", 2)
      const r = await logout(name)
      console.log(`Signed out of ${name}${r.revoked ? "" : " here (the instance could not be told — revoke it under User → Security → Devices there)"}; its connection is removed.`)
      if (r.modelLeft) console.log(`config.yaml still starts on ${r.modelLeft}: choose another with lembas config set model <connection/model>.`)
      return
    }
    let address = positionals[0] ?? ""
    // `login` again with no address refreshes the one instance there is.
    const again = address ? Object.values(known).find((i) => i.base_url.replace(/^https?:\/\//, "") === address.replace(/^https?:\/\//, "").replace(/\/+$/, "")) : Object.keys(known).length === 1 ? Object.values(known)[0] : undefined
    if (again && !values.ca && isWebuiEntry(again.connection)) {
      const r = await sync(again.connection, { setDefault: values.default })
      console.log(loginSummary(r, false).join("\n"))
      return
    }
    // An older kind of login (the models copied into connections.yaml) is replaced by signing in
    // again, at the address it had.
    if (again && !address) address = again.base_url
    if (!address) {
      if (!process.stdin.isTTY) fail("usage: lembas login <instance address>", 2)
      process.stdout.write("LLeMbas instance address: ")
      for await (const line of console) {
        address = line.trim()
        break
      }
      if (!address) fail("no address given", 2)
    }
    const r = await login(address, {
      ca: values.ca ?? again?.ca,
      setDefault: values.default,
      keepServices: values["keep-services"],
      onCode: (start, d) => console.log(`\n${codeInstructions(start, d)}\n`),
    })
    console.log(loginSummary(r, true).join("\n"))
  } catch (e) {
    if (e instanceof LembasError) fail(e.message)
    throw e
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const cmd = argv[0]
  // install.sh asks where the three directories are before it writes anything into them.
  // Internal, so not in --help; it prints where each one is, and install.sh writes where it says.
  if (cmd === "__paths") {
    const { paths } = await import("./config/paths.ts")
    return void console.log(`config=${paths.config}\ndata=${paths.data}\nstate=${paths.state}`)
  }
  if (cmd === "-h" || cmd === "--help" || cmd === "help") return void process.stdout.write(HELP)
  if (cmd === "--licenses" || cmd === "licenses") return void process.stdout.write((await import("../LICENSES.txt", { with: { type: "text" } })).default)

  if (!cmd || cmd.startsWith("-") && !["-v", "--version"].includes(cmd)) {
    const { values } = parseArgs({
      args: argv,
      options: {
        model: { type: "string", short: "m" },
        mode: { type: "string" },
        effort: { type: "string", short: "e" },
        continue: { type: "boolean", short: "c" },
        session: { type: "string", short: "s" },
      },
    })
    if (!process.stdin.isTTY || !process.stdout.isTTY) fail('the TUI needs a terminal; use: lembas run "…"', 2)
    if (values.mode && !asMode(values.mode)) fail(`--mode must be one of ${MODES.join(", ")}`, 2)
    await (await import("./lembas/webui.ts")).refreshWebui({ timeoutMs: 3000 })
    const { runTui } = await import("./tui/index.tsx")
    const done = await runTui({
      cwd: process.cwd(),
      model: values.model,
      mode: asMode(values.mode),
      effort: values.effort as Effort | "off" | undefined,
      resume: values.session ?? (values.continue ? "last" : undefined),
    })
    if (done.reload) await (await import("./reload.ts")).restart(done.reload)
    process.exit(0)
  }
  if (cmd === "--version" || cmd === "-v") return void console.log(VERSION)

  if (cmd === "login" || cmd === "logout") return void (await loginCommand(cmd, argv.slice(1)))

  // A webui connection's models are the instance's as they are now: read before anything that
  // loads the configuration to use it. A few seconds at most; an instance that does not answer
  // leaves what it said last.
  if (["run", "models", "serve", "service", "voice", "config"].includes(cmd ?? "")) await (await import("./lembas/webui.ts")).refreshWebui({ timeoutMs: 3000 })

  if (cmd === "serve") {
    if (!argv.includes("--stdio")) fail("usage: lembas serve --stdio", 2)
    const { Peer, stdioTransport } = await import("./acp/rpc.ts")
    const { AcpAgent } = await import("./acp/agent.ts")
    // stdout is the protocol: anything else printed would corrupt it, so it goes to stderr.
    console.log = (...a: unknown[]) => console.error(...a)
    const peer = new Peer(stdioTransport())
    new AcpAgent(peer)
    await new Promise<void>((resolve) => peer.onClose(resolve))
    process.exit(0)
  }

  if (cmd === "service") {
    const service = await import("./service.ts")
    const sub = argv[1] ?? "status"
    if (sub === "install") return void console.log(service.install().join("\n"))
    if (sub === "uninstall") return void console.log(service.uninstall().join("\n"))
    if (sub === "status") return void console.log(service.status().join("\n"))
    if (sub === "logs") process.exit(service.logs(argv.includes("-f") || argv.includes("--follow")))
    if (sub === "run") process.exit(await service.run(argv[2]))
    fail("usage: lembas service install | uninstall | status | logs [-f] | run [connection]", 2)
  }

  if (cmd === "run") {
    const { values, positionals } = parseArgs({
      args: argv.slice(1),
      allowPositionals: true,
      options: {
        model: { type: "string", short: "m" },
        mode: { type: "string" },
        effort: { type: "string", short: "e" },
        yes: { type: "boolean", short: "y" },
        json: { type: "boolean" },
        reasoning: { type: "boolean" },
        "no-store": { type: "boolean" },
      },
    })
    let prompt = positionals.join(" ").trim()
    if (!prompt && !process.stdin.isTTY) prompt = (await new Response(Bun.stdin.stream()).text()).trim()
    if (!prompt) fail('nothing to do: lembas run "your prompt"', 2)
    if (values.mode && !asMode(values.mode)) fail(`--mode must be one of ${MODES.join(", ")}`, 2)
    if (values.effort && values.effort !== "off" && !(EFFORTS as readonly string[]).includes(values.effort))
      fail(`--effort must be one of ${EFFORTS.join(", ")}, off`, 2)

    const app = createApp({
      cwd: process.cwd(),
      model: values.model,
      mode: asMode(values.mode),
      effort: values.effort as Effort | "off" | undefined,
      asker: terminalAsker({ yes: values.yes ?? false, unattended: loadConfig().config.question?.unattended, theme: loadConfig().config.theme }),
      unattended: !values.yes && !process.stdin.isTTY,
      store: values["no-store"] ? false : undefined,
      snapshots: false,
      modelTitles: false,
    })
    if (values.json) renderJson(app.bus)
    else renderPlain(app.bus, { color: process.stderr.isTTY ?? false, showReasoning: values.reasoning ?? false, icons: app.loaded.config.icons, theme: app.loaded.config.theme })
    process.on("SIGINT", () => app.engine.cancel())
    // One prompt, so the MCP servers' tools must be there before it (each server has its own
    // connect timeout; a failure is a notice, not a stop).
    await app.mcpReady
    const atts = attachmentsFor(prompt, app.engine.o.toolCtx, app.engine.model.spec.vision === true)
    const reason = await app.engine.prompt(prompt, atts.flatMap((a) => (a.image ? [a.text, a.image] : [a.text])))
    // Refused before the prompt was written (capacity, a cancel at once): no empty session is left
    // to crowd `lembas sessions`. Never shared, so nobody else is told.
    app.discardIfEmpty()
    process.exit(reason === "stop" ? 0 : reason === "steps" || reason === "budget" ? 3 : reason === "cancelled" ? 130 : 1)
  }

  if (cmd === "models") {
    const loaded = loadConfig()
    const discover = argv.includes("--discover")
    for (const [name, c] of Object.entries(loaded.connections)) {
      console.log(
        c.webui
          ? `${name}  (webui, ${c.webui.url}${c.webui.name ? ` — ${c.webui.name}` : ""}; models ${c.webui.fetched_at ? `read ${c.webui.fetched_at.slice(0, 16).replace("T", " ")}` : "not read yet"})`
          : `${name}  (${c.dialect}, ${c.base_url})`,
      )
      for (const [id, spec] of Object.entries(c.models)) {
        // Its ref: an instance's model by provider, anything else connection/model.
        const ref = loaded.refs.find((r) => r.connection === name && r.id === id)?.ref ?? `${name}/${id}`
        const m = resolveModel(loaded, ref)
        const bits = [
          spec.context ? `ctx ${spec.context}` : "",
          spec.max_output ? `out ${spec.max_output}` : "",
          spec.vision ? "vision" : "",
          spec.tools === false ? "no-tools" : "",
          spec.effort || spec.efforts ? `effort ${spec.effort ?? "off"} of ${effortsFor(m).join("/")}` : "",
        ].filter(Boolean)
        console.log(`  ${ref}${bits.length ? "  — " + bits.join(", ") : ""}`)
      }
      if (discover) {
        try {
          const found = await clientFor(resolveModel(loaded, `${name}/${Object.keys(c.models)[0] ?? "?"}`)).listModels()
          for (const d of found) if (!c.models[d.id]) console.log(`  ${name}/${d.id}  (discovered${d.context ? `, ctx ${d.context}` : ""})`)
        } catch (e) {
          console.log(`  (discovery failed: ${(e as Error).message})`)
        }
      }
    }
    for (const [name, why] of Object.entries(loaded.broken)) console.log(`${name}  ✗ ${why}`)
    for (const w of loaded.warnings) console.error(`⚠ ${w}`)
    return
  }

  if (cmd === "sessions" && (argv[1] === "delete" || argv[1] === "prune")) {
    // Deleted the way /sessions deletes: a running hub lets go of the session first and
    // tells the instance, so the web UI's chat goes too; with no hub, the word waits in the pending
    // list for the service's next link (acp/pending.ts).
    const { deleteEverywhere } = await import("./acp/share.ts")
    const { addPendingDeleted } = await import("./acp/pending.ts")
    const { REMOTE_META } = await import("./session/store.ts")
    const store = new Store()
    if (argv[1] === "delete") {
      const ids = argv.slice(2).filter((a) => !a.startsWith("-"))
      if (!ids.length) fail("usage: lembas sessions delete <id>…", 2)
      let failed = 0
      for (const id of ids) {
        if (!store.session(id)) {
          console.error(`${id}: no such session`)
          failed++
          continue
        }
        const why = await deleteEverywhere(store, id)
        if (why) {
          console.error(`${id}: not deleted — ${why}`)
          failed++
        } else console.log(`${id}: deleted`)
      }
      if (failed) process.exit(1)
      return
    }
    const dry = argv.includes("--dry-run")
    // Every session, not a page of them: the empty ones are what crowded the lists. Not one touched
    // in the last hour: with no service running nothing can say whether a terminal has it open
    // right now, empty because nobody has typed yet — and deleting that would fail its first turn.
    const settled = Date.now() - 3_600_000
    const empty = store.sessions(1_000_000).filter((s) => s.updated < settled && store.isEmpty(s.id))
    if (dry) {
      for (const s of empty) console.log(`${s.id}  ${new Date(s.updated).toISOString().slice(0, 16).replace("T", " ")}  ${s.root}`)
      console.log(`${empty.length} empty session${empty.length === 1 ? "" : "s"} would be deleted`)
      return
    }
    // The instance is told only of the ones it was shown (REMOTE_META): it never heard of the
    // rest, and a prune of a thousand must not push real deletes out of the bounded pending list.
    // Not through the hub one by one either: an empty session is held by nobody, and nobody is
    // working in it, so there is nothing to release — it goes from the store, and the word with it.
    const { connectHub } = await import("./acp/hub.ts")
    const hub = await connectHub()
    let n = 0
    const told: string[] = []
    for (const s of empty) {
      if (hub) {
        // A session open in a terminal right now, or held by the service, is not pruned from under it.
        const free = await hub.request("hub/release", { sessionId: s.id }, 5000).then(() => true, () => false)
        if (!free) continue
      }
      const shown = store.meta<boolean>(s.id, REMOTE_META) === true
      if (!store.deleteSession(s.id)) continue
      n++
      if (shown) told.push(s.id)
    }
    if (hub) {
      for (const id of told) hub.notify("hub/deleted", { sessionId: id })
      await hub.request("hub/hello", { pid: process.pid }, 5000).catch(() => {})
      hub.close()
    } else addPendingDeleted(told)
    console.log(`deleted ${n} empty session${n === 1 ? "" : "s"}`)
    return
  }

  if (cmd === "sessions") {
    const store = new Store()
    // Only sessions somebody said something in: every start makes one, as /sessions knows.
    for (const s of store.sessions(30, undefined, true)) {
      // Sessions from before titles: their first prompt's line.
      const title = s.title || promptTitle(store.firstPrompt(s.id))
      console.log(`${s.id}  ${new Date(s.updated).toISOString().slice(0, 16).replace("T", " ")}  ${s.model}  ${s.root}${title ? "  — " + title : ""}`)
    }
    return
  }

  if (cmd === "config" && argv[1] === "schema") {
    const { installSchemas, modeline, SCHEMA_FILES } = await import("./config/jsonschema.ts")
    for (const line of installSchemas(undefined, argv.includes("--link"))) console.log(line)
    if (!argv.includes("--link"))
      console.log(
        `\nAn editor with a YAML language server checks a file against these when its first line is:\n  config.yaml:      ${modeline(SCHEMA_FILES.config)}\n  connections.yaml: ${modeline(SCHEMA_FILES.connections)}\n(lembas config schema --link adds them.)`,
      )
    return
  }

  if (cmd === "config" && (argv[1] === "list" || argv[1] === "get" || argv[1] === "set")) {
    const { Settings } = await import("./settings.ts")
    const { show, describe } = await import("./config/settings.ts")
    const p = findProject(process.cwd())
    const trusted = trustOf(p.root) === "trusted"
    const project = argv.includes("--project")
    if (project && !trusted) fail(`${p.root} is not a trusted project (lembas trust)`)
    const args = argv.slice(2).filter((a) => a !== "--project")
    // Out of a session: nothing is live, so a value is checked and written, no more — except where
    // it is the account's (personalization, logged in), which is written there.
    const { PERSONAL_KEYS, pushPersonalization } = await import("./lembas/personal.ts")
    const pushes: Promise<unknown>[] = []
    const settings = new Settings({
      projectFile: trusted ? join(p.dir, "config.yaml") : undefined,
      live: () => undefined,
      apply: () => {},
      remote(key, v) {
        const loaded = loadConfig()
        if (!loaded.personalFrom || !(PERSONAL_KEYS as readonly string[]).includes(key)) return undefined
        pushes.push(pushPersonalization(key as (typeof PERSONAL_KEYS)[number], String(v ?? "")).catch((e) => fail(`could not save ${key} to ${loaded.personalFrom}: ${(e as Error).message}`)))
        return `on ${loaded.personalFrom}, shared with the web UI`
      },
      check(key, v) {
        if (key === "model" || key === "small_model") resolveModel(loadConfig(), String(v))
      },
    })
    if (argv[1] === "list") {
      for (const e of settings.list()) console.log(`${e.def.key} = ${show(e.value) || `(${e.def.fallback ?? "unset"})`}${e.source === "default" ? "" : `  [${e.source}]`}${e.note ? `  (${e.note})` : ""}`)
      return
    }
    const [key, ...rest] = args
    if (!key) fail(`usage: lembas config ${argv[1]} <key>${argv[1] === "set" ? " <value> [--project]" : ""}`, 2)
    if (argv[1] === "get") {
      const e = settings.get(key)
      console.log(`${key} = ${show(e.value) || `(${e.def.fallback ?? "unset"})`}${e.source === "default" ? "" : `  [${e.source}]`}`)
      if (e.note) console.log(`⚠ ${e.note}`)
      const d = describe(e.def)
      if (d) console.log(d)
      return
    }
    if (!rest.length) fail(`usage: lembas config set ${key} <value> [--project]`, 2)
    const said = settings.set(key, rest.join(" "), project ? "project" : "global").message
    await Promise.all(pushes)
    console.log(said)
    return
  }

  if (cmd === "config" && argv[1] === "check") {
    const p = findProject(process.cwd())
    const trusted = trustOf(p.root) === "trusted"
    const loaded = loadConfig({ projectConfigDir: p.dir, trusted })
    if (!trusted && existsSync(join(p.dir, "config.yaml"))) console.log(`(${p.dir}/config.yaml not read: this project is not trusted — lembas trust)`)
    console.log(`files: ${loaded.files.join(", ") || "(none)"}`)
    console.log(`connections: ${Object.keys(loaded.connections).join(", ") || "(none)"}`)
    for (const [name, why] of Object.entries(loaded.broken)) console.log(`✗ ${name}: ${why}`)
    for (const w of loaded.warnings) console.log(`⚠ ${w}`)
    // Another `lembas` first on PATH — the LLeMbas server's console script.
    const shadowed = (await import("./doctor.ts")).lembasShadowed()
    if (shadowed) console.log(`⚠ ${shadowed}`)
    if (loaded.config.model) resolveModel(loaded, loaded.config.model)
    console.log("ok")
    return
  }

  if (cmd === "mcp") {
    const { McpManager } = await import("./mcp/index.ts")
    const p = findProject(process.cwd())
    const loaded = loadConfig({ projectConfigDir: p.dir, trusted: trustOf(p.root) === "trusted" })
    const sub = argv[1] ?? "list"
    const name = argv[2]
    const mcp = new McpManager(loaded.mcp, { root: p.root, version: VERSION, notice: (m) => console.error(`⚠ ${m}`) })
    for (const [n, why] of Object.entries(loaded.broken)) if (n.startsWith("mcp:")) console.log(`✗ ${n.slice(4)}: ${why}`)
    if (!mcp.servers.size && !Object.keys(loaded.broken).some((n) => n.startsWith("mcp:"))) {
      console.log("no MCP servers configured (mcp: in ~/.config/lembas/config.yaml)")
      process.exit(0)
    }
    if (sub === "list") {
      await mcp.start()
      for (const s of mcp.servers.values()) {
        console.log(`${s.status === "connected" ? "●" : s.status === "disabled" ? "○" : "✗"} ${s.name}  (${s.cfg.command !== undefined ? "local" : s.cfg.url}${s.cfg.source === "project" ? ", project" : ""})  ${s.status}${s.error ? ` — ${s.error}` : ""}`)
        for (const t of s.tools) console.log(`    ${t.name}${t.description ? ` — ${t.description.split("\n")[0]!.slice(0, 90)}` : ""}`)
        for (const pr of s.prompts) console.log(`    /${s.name}:${pr.name}  (prompt)`)
        if (s.resources) console.log(`    (resources)`)
      }
      await mcp.close()
      process.exit(0)
    }
    if (sub === "auth" && name) {
      console.log(`Signing in to ${name}…`)
      const rl = (await import("node:readline")).createInterface({ input: process.stdin })
      const pasted = new Promise<string>((resolve) => rl.once("line", resolve))
      const s = await mcp.auth(name, (url) => console.log(`\nOpen this page and sign in:\n\n  ${url}\n\nIf the browser cannot reach this machine afterwards, paste the address it ends on here.`), pasted).catch((e) => fail((e as Error).message))
      rl.close()
      console.log(s.status === "connected" ? `${name}: signed in — ${s.tools.length} tools` : `${name}: ${s.error ?? s.status}`)
      await mcp.close()
      process.exit(s.status === "connected" ? 0 : 1)
    }
    if (sub === "logout" && name) {
      mcp.logout(name)
      console.log(`${name}: stored sign-in removed`)
      process.exit(0)
    }
    fail("usage: lembas mcp [list] | mcp auth <server> | mcp logout <server>", 2)
  }

  if (cmd === "voice") {
    const { synthesize, transcribe } = await import("./voice/speech.ts")
    const { play, playerFor, recorderFor, PLAYER_NAMES } = await import("./voice/audio.ts")
    const { spokenText, believable } = await import("./voice/text.ts")
    const v = loadConfig().config.voice
    const sub = argv[1] ?? "check"
    if (sub === "check") {
      const rec = recorderFor(v)
      const pl = playerFor(v)
      console.log(`input:  ${v?.stt ? `${v.stt.provider ?? "openai"} ${v.stt.base_url ?? ""}` : "not set up (voice.stt)"}`)
      console.log(`output: ${v?.tts ? `${v.tts.provider ?? "openai"} ${v.tts.base_url ?? v.tts.model_path ?? ""}` : "not set up (voice.tts)"}`)
      console.log(`record: ${typeof rec === "string" ? `✗ ${rec}` : rec.join(" ")}`)
      console.log(`play:   ${typeof pl === "string" ? `✗ ${pl}` : `${pl.join(" ")} — the program that plays speech (${PLAYER_NAMES[pl[0]!] ?? "an audio player"})`}`)
      if (v?.tts)
        console.log(`\nTo hear it: lembas voice say "some text" here; in the TUI, /speak reads replies aloud and\n/voice test says one sentence (voice.speak: true in config.yaml speaks from the start).`)
      process.exit(0)
    }
    if (sub === "say") {
      const { values, positionals } = parseArgs({ args: argv.slice(2), options: { out: { type: "string", short: "o" } }, allowPositionals: true })
      const text = spokenText(positionals.join(" ") || (await new Response(Bun.stdin.stream()).text()))
      if (!text) fail("nothing to say", 2)
      const audio = await synthesize(v, text).catch((e) => fail((e as Error).message))
      if (values.out) {
        await Bun.write(values.out, audio)
        console.log(`${values.out}: ${audio.length} bytes`)
      } else {
        const pl = playerFor(v)
        if (typeof pl === "string") fail(`${pl} (or give -o file.wav)`)
        await play(pl, audio).done
      }
      process.exit(0)
    }
    if (sub === "transcribe" && argv[2]) {
      const audio = new Uint8Array(await Bun.file(argv[2]).arrayBuffer())
      const text = await transcribe(v, audio).catch((e) => fail((e as Error).message))
      console.log(believable(text) || "(nothing recognisable)")
      process.exit(0)
    }
    fail('usage: lembas voice [check] | voice say "text" [-o file.wav] | voice transcribe <file>', 2)
  }

  if (cmd === "update") {
    const { autoUpdate, check, install, installTag, lock, rollback, installedBinary } = await import("./update/index.ts")
    const { values, positionals } = parseArgs({
      args: argv.slice(1),
      allowPositionals: true,
      options: { check: { type: "boolean" }, channel: { type: "string" }, rollback: { type: "boolean" } },
    })
    if (values.channel && values.channel !== "stable" && values.channel !== "beta") fail("--channel is stable or beta", 2)
    // One update at a time: a session updating itself on start holds the same lock.
    const unlock = lock()
    if (!unlock) fail("another LLeMbas CLI is updating right now; try again in a minute")
    process.on("exit", () => unlock())
    if (values.rollback) {
      const v = rollback()
      console.log(`rolled back to ${v} (run it again to undo)`)
      return
    }
    const config = { ...loadConfig().config.update, ...(values.channel ? { channel: values.channel as "stable" | "beta" } : {}) }
    const say = (r: Awaited<ReturnType<typeof autoUpdate>>) => {
      if (r.kind === "installed") console.log(`updated ${r.previous} → ${r.version} (${installedBinary()}); restart lembas, or /reload in a running one`)
      else if (r.kind === "current") console.log(`${r.version} is the newest ${config.channel ?? "stable"} release`)
      else if (r.kind === "available") console.log(`${r.version} is out — lembas update installs it`)
      else if (r.kind === "skipped") console.log(r.reason)
      else fail(r.reason)
    }
    if (positionals[0]) return say(await installTag(positionals[0], { config }))
    const found = await check({ config })
    if ("kind" in found) return say(found)
    if (values.check) return say({ kind: "available", version: found.release.tag.replace(/^v/, "") })
    return say(await install(found.release, found.version, { config }))
  }

  if (cmd === "kb") {
    const { kbCommand } = await import("./library/cli.ts")
    process.exit(await kbCommand(argv.slice(1)))
  }

  if (cmd === "uninstall") {
    const { uninstall } = await import("./uninstall.ts")
    process.exit(await uninstall({ purge: argv.includes("--purge"), yes: argv.includes("--yes") || argv.includes("-y") }))
  }

  if (cmd === "trust") {
    const p = findProject(process.cwd())
    setTrust(p.root, argv.includes("--readonly") ? "readonly" : "trusted")
    console.log(`${p.root}: ${argv.includes("--readonly") ? "read-only" : "trusted"}`)
    return
  }

  fail(`unknown command "${cmd}" — see lembas --help`, 2)
}

main().catch((e) => {
  if (e instanceof ConfigError || e instanceof ModelError || e instanceof SettingError) fail(e.message)
  fail((e as Error).stack ?? String(e))
})
