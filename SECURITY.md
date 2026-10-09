# Security

## Reporting a problem

Please report a vulnerability privately, not in a public issue: on GitHub, **Security → Report a
vulnerability** on [LLeMbas/LLeMbas-CLI](https://github.com/LLeMbas/LLeMbas-CLI/security).

Say what it is, how to reproduce it, and which version (`lembas --version`). You will get an
answer within a week. Fixes go out as a release, and the CHANGELOG says what was fixed once the release is out.

## Supported versions

Only the newest release. LLeMbas
CLI updates itself (`update.auto`), so staying on it is the default.

## What counts

LLeMbas CLI runs commands and changes files for a language model, so the model's output — and
everything the model reads: files, web pages, tool results, MCP servers — is treated as
untrusted. A report is most useful when it shows one of these:

- a tool call that runs, or changes something, **without the approval** the permission mode and
  rules say it needs — including a way past the hardline list (refused in every mode) or a write
  to a protected path (`~/.ssh`, `~/.gnupg`, `connections.yaml`);
- something a repository can do **before the user trusts it**, or in read-only mode, beyond being
  read; or anything that weakens a global-only setting from a project;
- a way for the agent to change a setting it must not (permission rules, the hardline, MCP
  servers, connections, the update source or key, `settings_tool`), or to loosen the permission
  mode without being asked every time;
- an update that installs without a valid signature from the release key, an older release
  installed as an update, or files written outside where the installer and uninstaller say;
- secrets — API keys, OAuth tokens — written somewhere readable, logged, or sent to a host other
  than the one they belong to.

A model doing something unwise **with** the user's approval, or in `unrestricted` mode, is how
LLeMbas CLI is meant to work, not a vulnerability; ways to make that clearer are still welcome as
ordinary issues ([GitHub Issues](https://github.com/LLeMbas/LLeMbas-CLI/issues)).

## Verifying a release

Each release's `SHA256SUMS` is signed with the release key, an SSH ed25519 key used for nothing
else:

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDSZO3Byow7R3ZpOH3MCvpPIga2pZBzhfX5wXfNP1cLa
SHA256:aPrR1ptc5sIwmyJgmqtu1iXmciq466Wv9kZNfm8Ddmg
```

`get.sh` and the updater check it before installing anything. By hand:

```sh
echo "lembas-release ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDSZO3Byow7R3ZpOH3MCvpPIga2pZBzhfX5wXfNP1cLa" > allowed
ssh-keygen -Y verify -f allowed -I lembas-release -n lembas-release -s SHA256SUMS.sig < SHA256SUMS
sha256sum -c --ignore-missing SHA256SUMS
```

Tags and commits are signed too (SSH signatures, shown as verified on the forge).
