// The link: this machine dials out to the LLeMbas instance it is logged in to, and the web
// UI drives sessions here over ACP. Nothing listens on this machine — the connection is outbound,
// one per device, re-dialled with backoff when it drops — and what the instance may ask is bounded
// by this machine's own global `remote:` block (agent.ts: Limits), never by the server.
//
// One WebSocket message is one JSON-RPC message. The token goes in the Authorization header and
// never in the address. A token the instance refuses (revoked from its Settings → Security, or the
// account lost the permission) ends the link for good: retrying it would only knock on a closed door.
import { existsSync, readFileSync } from "node:fs"
import { hostname } from "node:os"
import { remoteBlock } from "../config/remote.ts"
import type { Mode } from "../config/schema.ts"
import { HARNESS_VERSION } from "../harness.ts"
import { instances, keyFile, rememberProtocols, type Instance } from "../lembas/login.ts"
import { discover, linkProtocol, spoken } from "../lembas/client.ts"
import { VERSION } from "../version.ts"
import { AcpAgent, type Limits } from "./agent.ts"
import type { Hub } from "./hub.ts"
import { Peer, type Transport } from "./rpc.ts"

export class LinkError extends Error {}

/** The device's limits, read from the global `remote:` block each time one is looked at — so a
 *  running service follows `lembas remote …` (or an edit of config.yaml) without a restart. Every
 *  property is a getter: never spread this object, or it stops following.
 *
 *  With remote work off the roots are none, whatever `remote.roots` lists: the link is up, the
 *  instance is told `roots: []`, and every session, directory and terminal is refused.
 *
 *  `sharedOnly`: the link a terminal holds for /remote. While remote work is off it reaches only
 *  what that terminal shares; once it is on, the roots count like the service's. */
export function limitsFromConfig(o: { sharedOnly?: boolean } = {}): Limits & { enabled: boolean } {
  const r = () => remoteBlock()
  return {
    get enabled() {
      return r().enabled === true
    },
    get sharedOnly() {
      return o.sharedOnly === true && r().enabled !== true
    },
    get roots() {
      return r().enabled === true ? (r().roots ?? []) : []
    },
    get maxMode() {
      return (r().max_mode ?? "edit") as Mode
    },
    get approvalTimeoutMs() {
      return (r().approval_timeout ?? 600) * 1000
    },
    get requireTrust() {
      return r().require_trust !== false
    },
    get terminal() {
      return r().terminal === true
    },
    get terminalIntegration() {
      return r().terminal_integration !== false
    },
  }
}

/** What the instance is told when the link opens (the hello, initialize's limits and
 *  capabilities): when it changes, the link is dialled again so the instance hears the new one. */
function announced(L: Limits & { enabled: boolean }): string {
  return JSON.stringify([L.enabled, L.sharedOnly, L.roots, L.maxMode, L.requireTrust, L.terminal])
}

export function pickInstance(name?: string): Instance {
  const all = instances()
  if (name) {
    const one = all[name]
    if (!one) throw new LinkError(`not logged in to ${name}${Object.keys(all).length ? ` — logged in: ${Object.keys(all).join(", ")}` : ""}`)
    return one
  }
  const list = Object.values(all)
  if (!list.length) throw new LinkError("not logged in to any LLeMbas instance — lembas login <address>")
  if (list.length > 1) throw new LinkError(`logged in to several instances; name one: ${Object.keys(all).join(", ")}`)
  return list[0]!
}

export function linkUrl(instance: Instance): string {
  const u = new URL(instance.base_url)
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:"
  u.pathname = "/api/devices/link"
  return u.toString()
}

function wsTransport(ws: WebSocket): Transport {
  let onMsg: (t: string) => void = () => {}
  let onEnd: () => void = () => {}
  ws.addEventListener("message", (e) => onMsg(typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data as ArrayBuffer)))
  ws.addEventListener("close", () => onEnd())
  return { send: (t) => ws.send(t), onMessage: (fn) => (onMsg = fn), onClose: (fn) => (onEnd = fn), close: () => ws.close() }
}

export interface LinkStatus {
  state: "connecting" | "linked" | "waiting" | "stopped"
  instance: string
  since: string
  detail?: string
  attempts: number
}

export interface LinkOptions {
  instance?: string
  /** Each change of state, for the service's status file and log. */
  onStatus?: (s: LinkStatus) => void
  /** Stop for good when this aborts. */
  signal?: AbortSignal
  /** Only for tests: the backoff's first wait and its ceiling. */
  backoffMs?: [number, number]
  /** The hub this link serves: the terminals' sessions reach the instance through it. */
  hub?: Hub
  /** A terminal's link for /remote: it runs whatever `remote.enabled` says; with remote
   *  work off, only the sessions the terminal shares can be reached. */
  sharedOnly?: boolean
  /** Only for tests: how often the config is looked at while linked (default 2 s). */
  pollMs?: number
}

/** Dial, serve, and dial again, until stopped or refused. Resolves when it stops for good.
 *
 *  It links whether remote work is on or not, and with no roots at all: the instance then hears
 *  `roots: []` and can tell a device that allows no folder yet from one that is not running, and a
 *  `lembas remote add` or `enable` makes it serve, without a restart. */
export async function runLink(o: LinkOptions = {}): Promise<LinkStatus> {
  const limits = limitsFromConfig({ sharedOnly: o.sharedOnly })
  const poll = o.pollMs ?? 2000
  const instance = pickInstance(o.instance)
  const token = readFileSync(keyFile(instance.connection), "utf8").trim()
  // A service runs for weeks: the webui connections' models are read again every ten minutes, so a
  // session the web UI opens here starts with the instance's models as they are then.
  const freshen = setInterval(() => void import("../lembas/webui.ts").then((w) => w.refreshWebui()), 10 * 60_000)
  freshen.unref?.()
  const [first, ceiling] = o.backoffMs ?? [1000, 60_000]
  let wait = first
  let attempts = 0
  const status = (state: LinkStatus["state"], detail?: string): LinkStatus => {
    const s = { state, instance: instance.base_url, since: new Date().toISOString(), detail, attempts }
    o.onStatus?.(s)
    return s
  }
  const ca = instance.ca && existsSync(instance.ca) ? readFileSync(instance.ca, "utf8") : undefined
  /** A 4400 to a hello that said 2: the protocols known were stale (or discovery said more than the
   *  link takes) — the next dial, at once, says 1; only a 4400 to that stops the link. */
  let downgraded = false

  while (!o.signal?.aborted) {
    attempts++
    status("connecting")
    // What the instance speaks now: asked at every dial, since it may have been updated
    // since the login; what was said last when it cannot be asked.
    let protocols = instances()[instance.connection]?.protocols ?? instance.protocols
    try {
      const { discovery } = await discover(instance.base_url, ca ? { ca: instance.ca } : undefined)
      protocols = spoken(discovery)
      rememberProtocols(instance.connection, protocols)
    } catch {}
    const protocol = downgraded ? 1 : linkProtocol(protocols)
    const outcome = await new Promise<{ refused?: string; dropped?: string; final?: boolean; changed?: boolean }>((resolve) => {
      let opened = false
      let changed = false
      let watch: ReturnType<typeof setInterval> | undefined
      const ws = new WebSocket(linkUrl(instance), {
        headers: { authorization: `Bearer ${token}`, "user-agent": `lembas-cli/${VERSION}` },
        ...(ca ? { tls: { ca } } : {}),
      } as unknown as string[])
      const stop = () => ws.close()
      o.signal?.addEventListener("abort", stop, { once: true })
      ws.addEventListener("open", () => {
        opened = true
        wait = first
        const peer = new Peer(wsTransport(ws))
        new AcpAgent(peer, limits, instance.connection, o.hub, protocol)
        peer.notify("_lembas/hello", {
          protocol,
          version: VERSION,
          harness_spec: HARNESS_VERSION,
          device: { host: hostname(), platform: `${process.platform}-${process.arch}` },
          limits: { roots: limits.roots, max_mode: limits.maxMode, require_trust: limits.requireTrust },
        })
        status("linked")
        // The limits apply at once, each time they are looked at. What the instance was told at
        // the start is told again by dialling again, once nothing is working here: the sessions
        // are the hub's, so they outlive the link either way.
        const said = announced(limits)
        watch = setInterval(() => {
          if (changed || announced(limits) === said || o.hub?.busy()) return
          changed = true
          ws.close()
        }, poll)
        watch.unref?.()
      })
      ws.addEventListener("close", (e) => {
        o.signal?.removeEventListener("abort", stop)
        clearInterval(watch)
        if (changed) return resolve({ changed: true })
        // 4401/4403: the instance's word that this token is done; 1008 policy, likewise.
        if ([4401, 4403, 1008].includes(e.code)) return resolve({ refused: e.reason || "the instance refused this device's token" })
        // 4400: the hello's protocol is not one it speaks. Dialling again would say the same.
        if (e.code === 4400) return resolve({ refused: "the instance and this CLI speak different link protocols — update one of them", final: true })
        resolve({ dropped: opened ? `the link dropped (${e.code}${e.reason ? `: ${e.reason}` : ""})` : "could not reach the instance" })
      })
      ws.addEventListener("error", () => {})
    })
    if (o.signal?.aborted) break
    if (outcome.changed) {
      status("waiting", "the remote settings changed; linking again")
      wait = first
      continue
    }
    if (outcome.final && protocol === 2 && !downgraded) {
      downgraded = true
      status("waiting", "the instance does not take link protocol 2; trying again with 1")
      continue
    }
    if (outcome.refused) {
      clearInterval(freshen)
      return status("stopped", outcome.final ? outcome.refused : `${outcome.refused} — sign in again: lembas login`)
    }
    status("waiting", `${outcome.dropped}; trying again in ${Math.round(wait / 1000)}s`)
    await sleep(wait, o.signal)
    wait = Math.min(ceiling, wait * 2)
  }
  clearInterval(freshen)
  return status("stopped", "stopped")
}

/** Wait, or stop waiting when `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(done, ms)
    function done() {
      clearTimeout(t)
      signal?.removeEventListener("abort", done)
      r()
    }
    signal?.addEventListener("abort", done, { once: true })
  })
}
