// What the account on a LLeMbas instance says about the person: how they want to be
// helped, and the library. Logged in, one account is one person in both places — the web UI and
// this terminal read and write the same three settings, so a personality chosen in either is the
// one both use. Logged out (or on an instance that does not offer it), the local keys apply as
// before, and nothing here is read.
//
//   personality, personality_custom, instructions — from GET /v1/me/personalization when the
//     instance has it `available` (its administrator allows it); /settings writes them back there
//     with PUT. Read with the models at every start (webui.ts) and kept in the same cache.
//   library — with no `library:` written anywhere, a login whose token has the `library` scope
//     means the account's library (`lembas`); `library: local` written keeps this machine's.
import { existsSync, readFileSync } from "node:fs"
import { isLocal } from "../config/paths.ts"
import type { Config } from "../config/schema.ts"
import { PERSONALITIES } from "../config/schema.ts"
import { LembasError, savePersonalization, usage, type Personalization, type Usage } from "./client.ts"
import { instances, keyFile, type Instance } from "./login.ts"
import { readCache, writeCache } from "./webui.ts"

/** The one instance this machine is logged in to, with its key; undefined with none or several. */
export function soleInstance(): { instance: Instance; token: string } | undefined {
  const all = Object.values(instances())
  if (all.length !== 1) return undefined
  const instance = all[0]!
  if (!existsSync(keyFile(instance.connection))) return undefined
  try {
    return { instance, token: readFileSync(keyFile(instance.connection), "utf8").trim() }
  } catch {
    return undefined
  }
}

/** §10: the library a config with no `library:` uses — the account's, when the login may read it. */
export function defaultLibrary(): "lembas" | undefined {
  const one = soleInstance()
  return one?.instance.scope?.split(/\s+/).includes("library") ? "lembas" : undefined
}

/** The instance's personalization as last read, when it is the one that counts. */
export function instancePersonalization(): { connection: string; value: Personalization } | undefined {
  const one = soleInstance()
  if (!one) return undefined
  const p = readCache(one.instance.connection)?.personalization
  return p?.available ? { connection: one.instance.connection, value: p } : undefined
}

export const PERSONAL_KEYS = ["personality", "personality_custom", "instructions"] as const

/** The three keys as the instance has them, put over the config's: what the session uses. Off on
 *  the instance (the person opted out there) is none of them. */
export function withInstancePersonalization(config: Config): { config: Config; connection?: string } {
  const p = instancePersonalization()
  if (!p) return { config }
  return { connection: p.connection, config: { ...config, ...personalConfig(p.value) } }
}

/** Write one of the three back to the instance (/settings, logged in): that one field, and on —
 *  choosing it is opting in. Only what the person set is sent: the other two are the instance's as
 *  saved there (the session may have blanked them, an opted-out account, or not know a preset the
 *  web UI has), and a PUT of the session's copy would wipe them. The cache takes what the instance
 *  answered. */
export async function pushPersonalization(key: (typeof PERSONAL_KEYS)[number], value: string): Promise<Personalization | undefined> {
  if (isLocal()) throw new LembasError("local mode (-l) keeps settings in the project, not in the account")
  const one = soleInstance()
  if (!one) throw new LembasError("not logged in to one LLeMbas instance")
  const saved = await savePersonalization(one.instance.base_url, one.token, one.instance.ca ? { ca: one.instance.ca } : undefined, { enabled: true, [key]: value })
  const cache = readCache(one.instance.connection)
  if (cache) writeCache(one.instance.connection, { ...cache, personalization: saved ?? { ...(cache.personalization ?? { personality: "", personality_custom: "", instructions: "", available: true }), [key]: value, enabled: true } })
  return saved
}

/** The three keys a session uses for what the instance says (an unknown preset is none here, but
 *  stays the instance's). */
export function personalConfig(v: Personalization): Pick<Config, "personality" | "personality_custom" | "instructions"> {
  const preset = v.enabled && (PERSONALITIES as readonly string[]).includes(v.personality) ? (v.personality as Config["personality"]) : ""
  return { personality: preset, personality_custom: v.enabled ? v.personality_custom.slice(0, 1500) : "", instructions: v.enabled ? v.instructions.slice(0, 4000) : "" }
}

/** The account's usage on the one instance logged in to, or undefined: not logged in, or
 *  an instance without /v1/usage. */
export async function accountUsage(timeoutMs?: number): Promise<{ connection: string; usage: Usage } | undefined> {
  const one = soleInstance()
  if (!one) return undefined
  const u = await usage(one.instance.base_url, one.token, one.instance.ca ? { ca: one.instance.ca } : undefined, timeoutMs)
  return u ? { connection: one.instance.connection, usage: u } : undefined
}

const n = (x: number) => Math.round(x).toLocaleString("en")

/** Credits as a person reads them: two decimals where the number is small enough for them
 *  to matter (a balance of 3.47 is not "3"), whole above a thousand, as before. */
export function credits(x: number): string {
  return x.toLocaleString("en", { maximumFractionDigits: Math.abs(x) < 1000 ? 2 : 0 })
}

/** An amount in the instance's currency: `€1.23`, `$1.23`, `£1.23` — or "" without one. */
export function money(x: number | null | undefined, currency: string | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x) || !currency) return ""
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).format(x)
  } catch {
    // A code Intl does not know: the number and the code, rather than nothing.
    return `${x.toFixed(2)} ${currency}`
  }
}

/** A credit amount's money, as the instance gave it, else from what a credit is worth. */
function moneyOf(u: Usage, given: number | null | undefined, amount: number | null | undefined): string {
  if (given !== null && given !== undefined) return money(given, u.currency)
  if (amount === null || amount === undefined || typeof u.credit_value !== "number") return ""
  return money(amount * u.credit_value, u.currency)
}

const withMoney = (text: string, m: string) => (m ? `${text} (${m})` : text)

/** The status bar's word: the balance, when the account has a plan, with its money when the
 *  instance says it; `unlimited` for an administrator; "" otherwise. */
export function balanceLabel(u: Usage | undefined): string {
  if (u?.admin === true) return "unlimited"
  if (!u?.plan || u.balance === null || u.balance === undefined) return ""
  return withMoney(`${credits(u.balance)} ${u.unit || "credits"}`, moneyOf(u, u.balance_money, u.balance))
}

/** /usage: the detail, in lines. */
export function usageLines(connection: string, u: Usage): string[] {
  const unit = u.unit || "credits"
  const amount = (c: number | null | undefined, m: number | null | undefined) => (c !== null && c !== undefined ? ` — ${withMoney(`${credits(c)} ${unit}`, moneyOf(u, m, c))}` : m !== null && m !== undefined ? ` — ${money(m, u.currency)}` : "")
  const head = u.admin === true
    ? `${connection}: unlimited (administrator)`
    : `${connection}: ${u.plan ? `plan ${u.plan.name}, ${n(u.plan.credits_per_month)} ${unit} a month` : "no plan"}${u.balance !== null && u.balance !== undefined ? ` · balance ${withMoney(`${credits(u.balance)} ${unit}`, moneyOf(u, u.balance_money, u.balance))}` : ""}`
  const out = [head]
  const since = u.month?.from ? u.month.from.slice(0, 10) : "the start of the month"
  if (u.month) out.push(`this month (since ${since}): ${n(u.month.tokens_in)} tokens in, ${n(u.month.tokens_out)} out${amount(u.month.cost, u.month.cost_money)}`)
  if (u.device) out.push(`this device: ${n(u.device.tokens_in)} in, ${n(u.device.tokens_out)} out${amount(u.device.cost, u.device.cost_money)}`)
  // The rolling windows: an administrator has none that bind, so none are listed.
  if (u.admin !== true)
    for (const w of Array.isArray(u.windows) ? u.windows : []) {
      if (!w || typeof w.spent !== "number") continue
      const frees = typeof w.frees_at === "string" && w.frees_at ? `, frees from ${w.frees_at.slice(0, 16).replace("T", " ")}` : ""
      const of = typeof w.limit === "number" ? ` of ${credits(w.limit)}` : ""
      out.push(`window ${w.window}: ${credits(w.spent)}${of} ${unit} spent${frees}`)
    }
  return out
}
