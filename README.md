<p align="center">
  <img src="assets/banner.svg" alt="LLeMbas CLI — terminal coding agent" width="100%">
</p>

# LLeMbas CLI

A terminal coding agent and project manager: the `lembas` command. It talks to any LLM API
(OpenAI-compatible servers such as llama.cpp, vLLM or LM Studio, the OpenAI Responses API,
Anthropic, Gemini, Ollama), works in your project with four permission modes and a git snapshot of
every turn, remembers what it learns across sessions, and can sign in to a
[LLeMbas](https://github.com/LLeMbas/LLeMbas) server to use its models, library and search — and
let its web UI work the same sessions. Linux, x64 and arm64.

## Install

```sh
curl -fsSL https://github.com/LLeMbas/LLeMbas-CLI/releases/latest/download/get.sh | bash
```

Or download a binary from [Releases](https://github.com/LLeMbas/LLeMbas-CLI/releases). Every
release's `SHA256SUMS` is signed with the release key, and `get.sh` checks the signature and the
checksum before installing anything ([SECURITY.md](SECURITY.md) shows how to check by hand).

## First steps

```sh
cd your-project && lembas              # the TUI
lembas login https://your-server       # sign in to a LLeMbas server and use its models
```

Without a server, add a connection to `~/.config/lembas/connections.yaml` and set `model:` in
`~/.config/lembas/config.yaml`.

`lembas` updates itself (`lembas update` does it now); `lembas uninstall` removes it, and
`--purge` takes settings and sessions too.

## Links

- Documentation: <https://llembas.eu/cli.html> and <https://llembas.eu/docs/>
- Changelog: <https://llembas.eu/changelog.html>
- The server: <https://github.com/LLeMbas/LLeMbas>

## Licence

MIT — see [LICENSE](LICENSE) and [THIRD_PARTY.md](THIRD_PARTY.md).
