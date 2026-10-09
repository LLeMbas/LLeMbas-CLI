// Shell integration for a terminal opened from the web UI: the shell marks where each
// prompt, command and its output start and how the command ended (OSC 133 A/B/C/D), and says its
// working directory after every command (OSC 7). The web UI's terminal reads those marks — the
// directory in the panel's header, a green or red mark beside each finished command, jumping
// between commands, copying the last one's output — and nothing on the server parses anything.
//
// The user's own startup files run first, exactly as for `$SHELL -l`, and the marks go in after
// them; nothing else in their environment changes. bash gets an rc file in place of its login
// files (which it sources), zsh a ZDOTDIR whose files source the user's own and hand ZDOTDIR back,
// fish a command run after its config. Any other shell starts as it did before, without marks.
// `remote.terminal_integration: false` turns it off.
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { paths } from "../config/paths.ts"

export type ShellKind = "bash" | "zsh" | "fish" | "other"

export function shellKind(shell: string): ShellKind {
  const b = basename(shell)
  return b === "bash" || b === "zsh" || b === "fish" ? b : "other"
}

const BASH = `# LLeMbas CLI: shell integration for a terminal opened from the web UI. Generated; deleted when
# the terminal closes.
#
# bash reads this in place of ~/.bashrc (--rcfile), after /etc/bash.bashrc, so it does what a login
# shell would: your profile files, in a login shell's order, then logout and ~/.bash_logout as a
# login shell has them. /etc/profile reads /etc/bash.bashrc again when PS1 is set (Debian's does),
# so it is read with PS1 unset: once is enough.
__lembas_ps1=$PS1
unset PS1
[ -r /etc/profile ] && . /etc/profile
PS1=$__lembas_ps1
unset __lembas_ps1
if [ -r ~/.bash_profile ]; then . ~/.bash_profile
elif [ -r ~/.bash_login ]; then . ~/.bash_login
elif [ -r ~/.profile ]; then . ~/.profile
fi
logout() { exit "$@"; }
[ -z "$(trap -p EXIT)" ] && trap '[ -r ~/.bash_logout ] && . ~/.bash_logout' EXIT

# Then the marks: D (how the last command ended), the directory and A before every prompt, B at
# its end, C when a command starts to run. PS0 sets __lembas_ran in this shell (an array index is
# evaluated here, not in a subshell), so an empty line ends no command. The path in OSC 7 is
# percent-encoded byte by byte.
__lembas_url() {
  local LC_ALL=C s=$1 out= c i
  for ((i = 0; i < \${#s}; i++)); do
    c=\${s:i:1}
    case $c in
      [A-Za-z0-9/._~-]) out+=$c ;;
      *) printf -v c '%%%02X' "'$c"; out+=$c ;;
    esac
  done
  printf '%s' "$out"
}
__lembas_prompt() {
  local s=$?
  [ -n "$__lembas_ran" ] && printf '\\e]133;D;%s\\a' "$s"
  __lembas_ran=
  printf '\\e]7;file://%s%s\\a' "\${HOSTNAME:-localhost}" "$(__lembas_url "$PWD")"
  printf '\\e]133;A\\a'
  return $s
}
# B at the end of the prompt, put back after every hook that builds PS1 afresh (starship, a
# powerline prompt): this one runs last.
__lembas_mark() {
  local s=$?
  case $PS1 in *'\\[\\e]133;B\\a\\]') ;; *) PS1="\${PS1}\\[\\e]133;B\\a\\]" ;; esac
  return $s
}
if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
  PROMPT_COMMAND=(__lembas_prompt "\${PROMPT_COMMAND[@]}" __lembas_mark)
else
  PROMPT_COMMAND="__lembas_prompt\${PROMPT_COMMAND:+; $PROMPT_COMMAND}; __lembas_mark"
fi
PS0="\${PS0}\\e]133;C\\a\\\${__lembas_nil[__lembas_ran=1]}"
`

const ZSH_HOOKS = `# Then the marks: D (how the last command ended), the directory and A before every prompt, B at
# its end, C when a command starts to run. The path in OSC 7 is percent-encoded byte by byte.
__lembas_url() {
  emulate -L zsh
  local LC_ALL=C s=$1 out= c i
  for (( i = 1; i <= \${#s}; i++ )); do
    c=\${s[i]}
    if [[ $c == [A-Za-z0-9/._~-] ]]; then out+=$c; else out+=$(printf '%%%02X' "'$c"); fi
  done
  print -rn -- $out
}
__lembas_precmd() {
  local s=$?
  [[ -n $__lembas_ran ]] && printf '\\e]133;D;%s\\a' $s
  __lembas_ran=
  printf '\\e]7;file://%s%s\\a' "$HOST" "$(__lembas_url "$PWD")"
  printf '\\e]133;A\\a'
  return $s
}
# B at the end of the prompt, put back after any hook that builds PS1 afresh: this one runs last.
__lembas_mark() {
  [[ $PS1 == *$'\\e]133;B\\a%}' ]] || PS1="$PS1%{"$'\\e]133;B\\a'"%}"
}
__lembas_preexec() { __lembas_ran=1; printf '\\e]133;C\\a' }
precmd_functions=(__lembas_precmd $precmd_functions __lembas_mark)
preexec_functions=($preexec_functions __lembas_preexec)
`

/** zsh: our ZDOTDIR's .zshenv and .zprofile read the user's own, from the directory they use — the
 *  one ZDOTDIR named when the terminal started, or HOME, or the one their own .zshenv sets (the
 *  XDG way). Our .zshrc hands ZDOTDIR back and drops our variables *before* it reads theirs, so a
 *  .zshrc that execs (tmux) leaves nothing of ours behind, and zsh then reads their .zlogin itself. */
const ZSHENV = `# LLeMbas CLI: shell integration (generated; deleted when the terminal closes).
__lembas_dir=$ZDOTDIR
ZDOTDIR=\${LEMBAS_USER_ZDOTDIR:-$HOME}
[[ -r $ZDOTDIR/.zshenv ]] && . $ZDOTDIR/.zshenv
# Their .zshenv may have moved their files elsewhere: the rest are read from there.
[[ $ZDOTDIR != \${LEMBAS_USER_ZDOTDIR:-$HOME} ]] && export LEMBAS_USER_ZDOTDIR_SET=1
export LEMBAS_USER_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$__lembas_dir
unset __lembas_dir
`
const ZPROFILE = `# LLeMbas CLI: shell integration (generated; deleted when the terminal closes).
if [[ -r $LEMBAS_USER_ZDOTDIR/.zprofile ]]; then
  __lembas_dir=$ZDOTDIR
  ZDOTDIR=$LEMBAS_USER_ZDOTDIR
  . $ZDOTDIR/.zprofile
  ZDOTDIR=$__lembas_dir
  unset __lembas_dir
fi
`
const ZSHRC = `# LLeMbas CLI: shell integration (generated; deleted when the terminal closes).
__lembas_user=$LEMBAS_USER_ZDOTDIR
if [[ -n $LEMBAS_USER_ZDOTDIR_SET ]]; then ZDOTDIR=$__lembas_user; else unset ZDOTDIR; fi
unset LEMBAS_USER_ZDOTDIR LEMBAS_USER_ZDOTDIR_SET
[[ -r $__lembas_user/.zshrc ]] && . $__lembas_user/.zshrc
unset __lembas_user
${ZSH_HOOKS}`

const FISH = `# LLeMbas CLI: shell integration (generated; deleted when the terminal closes). Run after your
# own config: D (how the last command ended) after it, the directory and A before every prompt, B
# at its end, C when a command starts.
function __lembas_preexec --on-event fish_preexec
  printf '\\e]133;C\\a'
end
function __lembas_postexec --on-event fish_postexec
  printf '\\e]133;D;%s\\a' $status
end
function __lembas_prompt --on-event fish_prompt
  printf '\\e]7;file://%s%s\\a' (hostname) $PWD
  printf '\\e]133;A\\a'
end
if functions -q fish_prompt
  functions -c fish_prompt __lembas_user_prompt
  function fish_prompt
    __lembas_user_prompt
    printf '\\e]133;B\\a'
  end
end
`

export interface ShellLaunch {
  kind: ShellKind
  integration: boolean
  argv: string[]
  env: Record<string, string>
  /** Remove what was written for it. */
  cleanup(): void
}

/** How to start `shell` for terminal `id`: with the marks when it is bash, zsh or fish and
 *  `integration` is on; as `$SHELL -l` otherwise. */
export function shellLaunch(shell: string, id: string, integration: boolean, env: NodeJS.ProcessEnv = process.env): ShellLaunch {
  const kind = shellKind(shell)
  const plain: ShellLaunch = { kind, integration: false, argv: [shell, "-l"], env: {}, cleanup: () => {} }
  if (!integration || kind === "other") return plain
  const dir = join(paths.state, "terminal", id.replace(/[^\w-]/g, "_"))
  const cleanup = () => rmSync(dir, { recursive: true, force: true })
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (kind === "bash") {
      writeFileSync(join(dir, "bashrc"), BASH, { mode: 0o600 })
      return { kind, integration: true, argv: [shell, "--rcfile", join(dir, "bashrc"), "-i"], env: {}, cleanup }
    }
    if (kind === "zsh") {
      writeFileSync(join(dir, ".zshenv"), ZSHENV, { mode: 0o600 })
      writeFileSync(join(dir, ".zprofile"), ZPROFILE, { mode: 0o600 })
      writeFileSync(join(dir, ".zshrc"), ZSHRC, { mode: 0o600 })
      return {
        kind,
        integration: true,
        argv: [shell, "-l"],
        env: { ZDOTDIR: dir, LEMBAS_USER_ZDOTDIR: env.ZDOTDIR || env.HOME || "", ...(env.ZDOTDIR ? { LEMBAS_USER_ZDOTDIR_SET: "1" } : {}) },
        cleanup,
      }
    }
    writeFileSync(join(dir, "integration.fish"), FISH, { mode: 0o600 })
    return { kind, integration: true, argv: [shell, "-l", "-C", `source '${join(dir, "integration.fish").replace(/'/g, "\\'")}'`], env: {}, cleanup }
  } catch {
    cleanup()
    return plain
  }
}
