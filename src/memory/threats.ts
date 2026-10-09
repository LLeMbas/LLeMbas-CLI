// Prompt-injection and exfiltration patterns for text that ends up in the system prompt: memory
// entries and skills. Ported from Hermes Agent (tools/threat_patterns.py, MIT, © Nous Research).
// Patterns anchor on attack vocabulary, not bossy English: "you must" is normal in an AGENTS.md.

const F = String.raw`(?:\w+\s+){0,8}` // bounded filler between key words
const SECRET_VAR = String.raw`\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)S?\b`
const MODIFY = String.raw`(update|modify|edit|write|change|append|add\s+to)\s+[^\n]{0,2048}`

/** "all": everywhere. "context": text not written by the user (files, tool results). "strict":
 *  writes the user can resolve (memory, skills). Inclusion is cumulative: strict checks all. */
export type Scope = "all" | "context" | "strict"

const PATTERNS: [string, string, Scope][] = [
  [String.raw`ignore\s+${F}(previous|all|above|prior)\s+${F}instructions`, "prompt_injection", "all"],
  [String.raw`system\s+prompt\s+override`, "sys_prompt_override", "all"],
  [String.raw`disregard\s+${F}(your|all|any)\s+${F}(instructions|rules|guidelines)`, "disregard_rules", "all"],
  [String.raw`act\s+as\s+(if|though)\s+${F}you\s+${F}(have\s+no|don't\s+have)\s+${F}(restrictions|limits|rules)`, "bypass_restrictions", "all"],
  [String.raw`<!--[^>]{0,512}(?:ignore|override|system|secret|hidden)[^>]{0,512}-->`, "html_comment_injection", "all"],
  [String.raw`<\s*div\s+style\s*=\s*["'][^>]{0,2048}display\s*:\s*none`, "hidden_div", "all"],
  [String.raw`translate\s+[^\n]{0,512}\s+into\s+\w+(?:[\s-]+\w+){0,2}\s+and\s+(execute|run|eval)\b`, "translate_execute", "all"],
  [String.raw`do\s+not\s+${F}tell\s+${F}the\s+user`, "deception_hide", "all"],
  [String.raw`you\s+are\s+${F}now\s+(?:a|an|the)\s+`, "role_hijack", "context"],
  [String.raw`pretend\s+${F}(you\s+are|to\s+be)\s+`, "role_pretend", "context"],
  [String.raw`output\s+${F}(system|initial)\s+prompt`, "leak_system_prompt", "context"],
  [String.raw`(respond|answer|reply)\s+without\s+${F}(restrictions|limitations|filters|safety)`, "remove_filters", "context"],
  [String.raw`you\s+have\s+been\s+${F}(updated|upgraded|patched)\s+to`, "fake_update", "context"],
  [String.raw`\bname\s+yourself\s+\w+`, "identity_override", "context"],
  [String.raw`register\s+(as\s+)?a?\s*node`, "c2_node_registration", "context"],
  [String.raw`(heartbeat|beacon|check[\s\-]?in)\s+(to|with)\s+`, "c2_heartbeat", "context"],
  [String.raw`pull\s+(down\s+)?(?:new\s+)?task(?:ing|s)?\b`, "c2_task_pull", "context"],
  [String.raw`connect\s+to\s+the\s+network\b`, "c2_network_connect", "context"],
  [String.raw`you\s+must\s+(?:\w+\s+){0,3}(register|connect|report|beacon)\b`, "forced_action", "context"],
  [String.raw`only\s+use\s+one[\s\-]?liners?\b`, "anti_forensic_oneliner", "context"],
  [String.raw`never\s+${F}(?:create|write)\s+${F}(?:script|file)\s+${F}disk`, "anti_forensic_disk", "context"],
  [String.raw`unset\s+\w*(?:CLAUDE|CODEX|HERMES|LEMBAS|AGENT|OPENAI|ANTHROPIC)\w*`, "env_var_unset_agent", "context"],
  [String.raw`\b(?:cobalt\s*strike|sliver|havoc|mythic|metasploit|brainworm)\b`, "known_c2_framework", "context"],
  [String.raw`\bc2\s+(?:server|channel|infrastructure|beacon)\b`, "c2_explicit", "context"],
  [String.raw`\bcommand\s+and\s+control\b`, "c2_explicit_long", "context"],
  [String.raw`curl\s+[^\n]{0,2048}${SECRET_VAR}`, "exfil_curl", "all"],
  [String.raw`wget\s+[^\n]{0,2048}${SECRET_VAR}`, "exfil_wget", "all"],
  [String.raw`cat\s+[^\n]{0,2048}(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)`, "read_secrets", "all"],
  [String.raw`(send|post|upload|transmit)\s+[^\n]{0,2048}\s+(to|at)\s+https?://`, "send_to_url", "strict"],
  [String.raw`(include|output|print|share)\s+${F}(conversation|chat\s+history|previous\s+messages|full\s+context|entire\s+context)`, "context_exfil", "strict"],
  [String.raw`authorized_keys`, "ssh_backdoor", "strict"],
  [String.raw`(?:\b(?:echo|cat|cp|mv|dd|tee|install|printf|rsync|scp|ln|append|add|write|sed|chmod|chown|truncate|rm|touch|curl|wget|git)\b|\bopen\s*\(|>>?)[^\n]{0,512}(?:\$HOME/\.ssh|~/\.ssh)`, "ssh_access", "strict"],
  [String.raw`${MODIFY}(?:AGENTS\.md|CLAUDE\.md|\.cursorrules|\.clinerules)`, "agent_config_mod", "strict"],
  [String.raw`${MODIFY}(?:lembas/)?(connections\.yaml|config\.yaml|SOUL\.md)`, "lembas_config_mod", "strict"],
]

const INCLUDES: Record<Scope, Scope[]> = { all: ["all"], context: ["all", "context"], strict: ["all", "context", "strict"] }
// Python's \w (what Hermes wrote these for) is Unicode; JavaScript's is ASCII, so "ignore všetky
// previous instructions" slipped through. A letter is any letter.
const COMPILED = PATTERNS.map(([re, id, scope]) => ({ re: new RegExp(re.replaceAll(String.raw`\w`, String.raw`[\p{L}\p{N}_]`), "iu"), id, scope }))
// A value that names an environment variable (MY_APP_PASSWORD) says where a secret lives; it is
// not one. Hermes does this with a case-sensitive inline group, which JavaScript lacks.
const SECRET = /(?:api[_-]?key|token|secret|password)\s*[=:]\s*["']([A-Za-z0-9+/=_-]{20,})/gi
const ENV_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/

export const INVISIBLE = new Set("​‌‍⁠⁢⁣⁤﻿‪‫‬‭‮⁦⁧⁨⁩")
// As much as anything scanned may hold (a skill file is up to 100,000 characters).
const MAX_SCAN = 131_072

/** The ids of every pattern `text` matches in `scope`. */
export function scanThreats(text: string, scope: Scope = "context"): string[] {
  if (!text) return []
  text = text.slice(0, MAX_SCAN)
  // Invisible characters on the raw text: NFKC can remove them.
  const found = [...new Set(text)].filter((c) => INVISIBLE.has(c)).map((c) => `invisible_unicode_U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`)
  const norm = text.normalize("NFKC")
  const scopes = INCLUDES[scope]
  for (const p of COMPILED) if (scopes.includes(p.scope) && p.re.test(norm)) found.push(p.id)
  if (scope === "strict") for (const m of norm.matchAll(SECRET)) if (!ENV_NAME.test(m[1]!)) found.push("hardcoded_secret")
  return [...new Set(found)]
}

/** A refusal for the first threat found, or undefined. */
export function threatMessage(text: string, what = "Content"): string | undefined {
  const [first] = scanThreats(text, "strict")
  if (!first) return undefined
  if (first.startsWith("invisible_unicode_")) return `Blocked: ${what.toLowerCase()} contains the invisible character ${first.slice(18)} (a common injection carrier).`
  return `Blocked: ${what.toLowerCase()} matches the threat pattern "${first}". It goes into the system prompt of every session, so it must not carry instructions aimed at the agent or anything that leaks secrets.`
}
