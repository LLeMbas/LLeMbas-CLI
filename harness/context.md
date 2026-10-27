# Context hygiene

Spec 3.0.0. What a session does to keep tool results from filling the model's context — the same in
a chat and in an agent session, in both projects. The texts and numbers are `loop.json` `context`;
the cases are `conformance/context.json`; what the model is told is `prompts/blocks/context.md`.

## The one rule

**Every measure acts when a result is inserted. Nothing already sent to the model is ever
rewritten.** Changing earlier context invalidates the prompt cache from that point on: a local
server processes everything after it again, and a cloud API charges full input price for it again —
on a long context that costs more than the measure saves. So no earlier result is ever shortened,
replaced by a stub or removed afterwards. The one deliberate break is compaction, which already
replaces the history with a summary.

## 1. Every result has an id

Every tool result is given an id when it is inserted: `#` and lowercase hex, at least
`ids.digits` (4) digits, unique in the session and never reused — not after a compaction either. It
is the first thing in the result, in brackets: `[#a3f2]`, then a newline and the result.

A read's bracket says more: the path as the call gave it, the lines shown, the file's length in
lines and the first `sha_digits` (8) hex digits of the SHA-256 of the file's content —

```
[#a3f2 src/app.ts lines 1-200 of 340 sha 1c9e04ab]
1: import …
```

— and an empty file `[#a3f2 notes.txt empty sha e3b0c442]`. The full hash is kept by the session;
only it decides whether a file is unchanged.

**Every result is stored with the session, in full** — before any cap, and for a stub the text it
stands for — so `recall` can show any of them for as long as the session exists.

## 2. An unchanged re-read is a stub

A read is answered with a stub when the file's content hash equals that of an **earlier full read
of the same path still in the dedupe table**, and the lines asked for lie **wholly inside** that
read's lines:

```
[#b710 src/app.ts lines 50-80 of 340 sha 1c9e04ab] Unchanged since #a3f2, which already shows lines 1-200.
```

The bracket is the new read's; the sentence names the earlier result and its lines. A stub points
at a full result, never at another stub. A file that changed — by this session's own edit or from
outside — has another hash and is read in full; a range reaching past the earlier read is read in
full.

## 3. Large output is capped on the way in

A result over `cap.max_lines` (400) lines or `cap.max_chars` (40,000) characters keeps its head —
as many whole lines as fit `head_lines` (200) and `head_chars` (20,000) — and its tail — likewise,
`tail_lines` (100) and `tail_chars` (10,000) — with one line between:

```
[1234 lines elided, full output #c9d0]
```

A first line longer than `head_chars` is cut to it and ends ` […cut]`; the elided line follows it
whatever it counts. Reads and `recall` are not capped this way: each has its own window (2000 lines
from an offset).

## 4. `recall`

`recall(id, offset?, limit?)` shows a stored result again, in full, up to 2000 lines from `offset`:

```
[#d004 recall #c9d0 lines 1-2000 of 3400]
…
```

An id the session never gave: `[#d004] No stored result #ffff in this session.` The `#` may be left
out of the argument. A recall is not capped, is not deduplicated, and is itself stored.

## 5. Edits answer with the diff

`edit`, `multiedit`, `apply_patch` and `write` over an existing file answer with the unified diff
of the change (three lines of context, hunks only — the path is in the bracket) under a bracket
naming the path and the new content's hash:

```
[#e201 src/app.ts sha 7d0a91c3]
@@ -12,3 +12,3 @@
```

`write` of a new file answers `[#e202 docs/new.md sha 52b6e3a0] Created, 14 lines.` — the model
wrote the content and has it. The diff is capped like any output.

## 6. The same search or listing twice is a stub

For `dedupe.by_result` — `list`, `glob`, `grep`, `search` — a call with the same arguments (compared
as JSON with sorted keys) as an earlier one in the dedupe table, **whose result is the same text**,
is answered `[#f002] Same result as #f001.` The call is run again and compared, so a change from
anywhere shows up as a full result. Other tools are never deduplicated: a command's output twice is
two results.

## 7. Compaction

Compaction is the one deliberate break of the cache, and it already exists. In 3.0.0 two things
come with it:

- After the summary the harness adds — itself, not the model — a table of the reads still in the
  dedupe table: the newest full read of each path, newest last, at most `compaction.rows` (50):

  ```
  ## Files read before this summary

  Read a file again for its content; recall shows a result by its id.

  | Path | Lines | sha | Result |
  |---|---|---|---|
  | src/app.ts | 1-200 of 340 | 1c9e04ab | #a3f2 |
  ```

  With no reads there is no table.
- **The dedupe table is emptied**, so no stub ever points at content that is no longer in the
  context. A read after compaction is a full read; a `recall` of any earlier id still works.

## 8. Earlier reasoning

Left to the model's own chat template: the harness sends the history as it does, and neither strips
reasoning a template keeps nor adds what it drops.

## 9. What the model is told

`prompts/blocks/context.md`, in every session that has `recall`.

## Not in 3.0.0

Eliding old content in batches behind a threshold, and measuring quality and tokens with and without
these measures, are left for a later spec. Every measure above ships with its unit and conformance
cases.

## Over the link

A device keeps its sessions' stored results itself; `recall` in an agent session reads the device's
store. The ids are in the result text, so a client showing the transcript shows them as they are.
