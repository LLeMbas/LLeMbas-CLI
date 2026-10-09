// Settings while a session runs: what each one is now, where that comes from, and changing it —
// for this session, in the global config, or in the project's. The list is config/settings.ts;
// what a change does to the running session is the app's (`apply`).
import { mkdirSync, writeFileSync } from "node:fs"
import { assertProjectFile } from "./project/safe.ts"
import { dirname, join } from "node:path"
import { findSetting, globalConfigFile, legacyInstructionFiles, parseValue, readRaw, SettingError, SETTINGS, show, sourceOf, writeKey, type Entry, type Scope, type SettingDef } from "./config/settings.ts"

export interface SettingsHost {
  /** The project's config.yaml, when the project is trusted (else project scope is refused). */
  projectFile?: string
  /** The value in force now, where the session holds it (the model, the mode). */
  live(key: string): unknown
  /** Make it so for the running session. Throws when the value is not usable (no such model). */
  apply(key: string, value: unknown): void
  /** Checks that need the session: the model exists, the effort is one it takes. */
  check?(key: string, value: unknown): void
  /** A global setting that lives elsewhere (personalization, logged in, is the account's on the
   *  instance): handle it there and say where, or undefined to write config.yaml as usual. */
  remote?(key: string, value: unknown): string | undefined
}

export interface SetResult {
  def: SettingDef
  value: unknown
  scope: Scope
  /** For whoever asked: what changed, and when it counts. */
  message: string
}

export class Settings {
  /** Changed for this session only. */
  readonly session = new Map<string, unknown>()
  /** Checks a front end adds (the TUI knows which skins exist). */
  readonly checks = new Map<string, (value: unknown) => void>()

  constructor(private host: SettingsHost) {}

  private files() {
    return { global: readRaw(globalConfigFile()), project: this.host.projectFile ? readRaw(this.host.projectFile) : undefined }
  }

  get(key: string): Entry {
    const def = findSetting(key)
    if (!def) throw new SettingError(`${key} is not a setting — ${SETTINGS.map((s) => s.key).join(", ")}`)
    const f = this.files()
    // A key a project may not set is not set by a project's file, whatever is written there:
    // loading ignores it (load.ts GLOBAL_ONLY), so it is not shown as the value either.
    const { value, source } = sourceOf(key, this.session, def.scopes.includes("project") ? f.project : undefined, f.global)
    // A list under `instructions` is an old config's instruction files, not text: it is
    // no custom instructions, and the files are read as instruction_files.
    const files = key === "instructions" && source !== "session" ? legacyInstructionFiles(value) : undefined
    if (files) return { def, value: undefined, source: "default", note: `instructions holds a list of files (${files.join(", ")}), from an older config: they are read as instruction_files, and setting instructions moves them there` }
    const live = this.host.live(key)
    return { def, value: live !== undefined ? live : value, source }
  }

  list(): Entry[] {
    return SETTINGS.map((s) => this.get(s.key))
  }

  set(key: string, raw: unknown, scope: Scope = "session"): SetResult {
    const def = findSetting(key)
    if (!def) throw new SettingError(`${key} is not a setting — ${SETTINGS.map((s) => s.key).join(", ")}`)
    if (!def.scopes.includes(scope)) throw new SettingError(`${key} can be set for: ${def.scopes.join(", ")}`)
    if (scope === "project" && !this.host.projectFile) throw new SettingError("project settings need a trusted project")
    const value = parseValue(def, raw)
    try {
      this.host.check?.(key, value)
      this.checks.get(key)?.(value)
    } catch (e) {
      throw new SettingError((e as Error).message)
    }

    const notes: string[] = []
    const elsewhere = scope === "global" ? this.host.remote?.(key, value) : undefined
    if (scope === "session") this.session.set(key, value)
    else if (elsewhere) {
      notes.push(elsewhere)
      this.session.set(key, value)
    } else {
      const file = scope === "global" ? globalConfigFile() : this.host.projectFile!
      mkdirSync(dirname(file), { recursive: true })
      if (scope === "project") assertProjectFile(file, dirname(dirname(file)))
      notes.push(...writeKey(file, key.split("."), value, (f, text) => writeFileSync(f, text)))
      this.session.delete(key)
    }
    if (!def.reload) this.host.apply(key, value)

    const where = scope === "session" ? "for this session" : elsewhere ? "for your account" : scope === "global" ? "in the global config" : "in this project's config"
    let message = `${key} = ${show(value)} ${where}`
    if (def.reload) message += "; it takes effect from the next start (/reload)"
    for (const n of notes) message += `; ${n}`
    // A global value under a project's own is set, but the project's wins here from the next start.
    if (scope === "global") {
      const p = this.files().project
      const shadow = p && key.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), p)
      if (shadow !== undefined) message += ` — this project's config sets ${show(shadow)}, which wins here from the next start`
    }
    return { def, value, scope, message }
  }
}

export const projectConfigFile = (dir: string) => join(dir, "config.yaml")
