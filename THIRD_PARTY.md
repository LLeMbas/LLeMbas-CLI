# Third-party code and text

LLeMbas CLI is MIT licensed. It takes code, prompt
text and design from the projects below. Every file lifted or ported from one of
them says so in its header, naming the upstream path.

| Project | Licence | Copyright | What LLeMbas CLI takes |
|---|---|---|---|
| [OpenCode](https://github.com/anomalyco/opencode) | MIT | © 2025 opencode | Project data system (AGENTS.md / CLAUDE.md discovery, per-project directory), permission rules and bash arity, question tool, `@` / `/` autocomplete, shadow-git snapshots, per-model-family system prompts, MCP (prompts as commands, server instructions, the OAuth callback and token store) |
| [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) | MIT | © 2024 Anthropic, PBC | The MCP client, used as a dependency (and its example OAuth server, in the tests) |
| [OpenTUI](https://github.com/anomalyco/opentui) | MIT | © 2025 opentui | The terminal rendering engine, used as a dependency |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | MIT | © 2025 Nous Research | Persistent memory, skills, session search, the prompt-injection patterns, MCP client shape, voice mode (silence auto-stop, spoken-text normalisation, the silence-phrase filter), the default skin and tool-line style, prompt guidance blocks, dangerous-command patterns |
| [LLeMbas](https://github.com/LLeMbas/LLeMbas) | MIT | © Jaroslav Beneš | Connection and model settings, reasoning-effort handling for llama.cpp, the ask-user design, prompt text, the library's chunker, the personality presets and their headings, the unified-diff applier (`src/tool/unidiff.ts`), the capacity rule, the per-prompt budgets and editing a command before allowing it. The two share one harness design (`harness/`) |

The MIT licence texts of OpenCode, OpenTUI and Hermes Agent require their
copyright notice to travel with substantial portions of their code. Their full
notices:

```
MIT License — Copyright (c) 2025 opencode
MIT License — Copyright (c) 2025 opentui
MIT License — Copyright (c) 2025 Nous Research

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Inside the release binaries

A release binary is LLeMbas CLI's code bundled with the npm packages it uses, OpenTUI's native
library, and the Bun runtime, compiled into one file. **[LICENSES.txt](LICENSES.txt)** has every
licence that comes with that — generated from what the bundle actually contains by
`bun run licenses`, checked by CI, published with each release, and printed by
`lembas --licenses`. In short:

- **npm packages** (29): MIT, ISC, BSD-2-Clause and BSD-3-Clause — among them OpenTUI, Solid,
  the MCP SDK, zod, yaml, turndown (with domino), diff, fuzzysort and ajv.
- **`libopentui.so`**, OpenTUI's native library (MIT), with Ghostty's terminal code (MIT),
  Little CMS (MIT), libwebp (BSD-3-Clause, with Google's patent grant), stb (MIT / public domain),
  Wuffs (Apache-2.0) and Meta's Yoga layout (MIT) compiled in; tree-sitter grammars for its syntax
  highlighting (MIT).
- **Bun** (MIT), which statically links JavaScriptCore and parts of WebKit under the **LGPL 2**,
  and other libraries under permissive licences ([Bun's own list](third_party/bun-1.4.2-LICENSE.md)).
  The LGPL asks that a user can relink the program against a modified library: LLeMbas CLI's whole
  source is public, so the binary can be rebuilt against a modified Bun (and so a modified
  JavaScriptCore) with `bun run build`. Bun's sources: <https://github.com/oven-sh/bun> at
  `bun-v1.4.2`; its JavaScriptCore: <https://github.com/oven-sh/WebKit>.
