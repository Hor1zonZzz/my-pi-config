# Memory

Per-project memory for Pi, after Anthropic's [The components of agent memory](https://www.anthropic.com/research/components-of-agent-memory): the agent writes notes as it works, an injected index tells each new session what earlier sessions learned, and a "dream" folds the last three days' sessions into the notes and tidies them.

Memory is per project only; there is no global memory. It is on by default in every project and is switched with `/memory`.

## Layers

| Layer | What it is | Where |
|---|---|---|
| Transcripts | Pi's own session files, the record of what happened | `<agent-dir>/sessions/--<project>--/*.jsonl` (read only) |
| Notes | One markdown file per note, with frontmatter | `<agent-dir>/memory/--<project>--/notes/*.md` (`/memories` to the model) |
| Index | One line per note, generated from the frontmatter | `notes/MEMORY.md` |
| Injected context | What memory is for, plus the index (≤ 200 lines / 25 KB) | the `memory` system-prompt section |

`--<project>--` uses the same naming as Pi's session directories (`/Users/me/app` → `--Users-me-app--`).

## Injection and prompt caching

The `memory` section says what memory is for, not how to use it, and lists the index. The index is read once on `session_start` and frozen: notes written later in the session (by the model, by passive capture, or by a dream) go to disk but do not change the injected bytes, so Pi's section diff stays empty and the prompt cache keeps hitting. The frozen index is refreshed after compaction, which already invalidates the cache. The purpose text is a constant and the index is sorted by path with no timestamps or counts, so new sessions with unchanged notes also send identical bytes.

## Active memory: the `memory` tool

The tool follows Anthropic's memory tool (`memory_20250818`) commands and result strings: `view` (directory up to two levels, or a file with optional `view_range`), `create` (creates or overwrites), `str_replace`, `insert`, `delete`, `rename`.

- Every path must start with `/memories`; `..`, backslashes, and URL-encoded traversal are rejected, and resolved paths must stay inside the notes directory.
- `MEMORY.md` is generated after every write and cannot be edited, deleted, or renamed through the tool. The root cannot be deleted or renamed.
- Files are limited to 100 KB; unranged views stop at 16,000 characters.
- The tool is active only while memory is on for the project.

Note frontmatter:

```text
---
name: use-pnpm
description: This project uses pnpm, never npm
type: feedback            # user | feedback | project | reference
source: passive           # active | passive | dream (missing = written with the tool)
sessions: ["01a1…"]
updated: 2026-11-10
verified: 2026-11-11      # passive notes a dream confirmed
unverifiedDreams: 1       # passive notes no dream has confirmed yet
---
```

## Passive memory (experimental)

The blog does not evaluate a background model that judges each turn; it reports that strong models judge salience best themselves. Passive capture is therefore a separate switch so its notes can be compared with and without it.

After each settled, non-aborted turn in a TUI or RPC session, unless the model already wrote memory during that run:

1. **Jev** (`openrouter` / `~typesafe/jev-latest`, through `ctx.modelRegistry.classify()`) gets the focus turn, the turn before it, and the current index, and answers `durable` (bool) and `kind` (user / feedback / project / reference).
2. If `durable ≥ 0.75`, **DeepSeek Flash** (`deepseek` / `deepseek-flash`, reasoning `low`, through `ctx.modelRegistry.streamSimple()`) gets up to three turns (≈ 24,000 characters, oldest dropped first), the kind, the full text of up to five related notes (matched on name and description terms, including Chinese bigrams), and the index. It answers one JSON operation: `create`, `update`, or `skip`.
3. The note is written with `source: passive` and the session ID; an updated note keeps its source.

Turns are rendered as `USER:` / `AGENT:` text without thinking; tool calls become one line (name and the first 200 characters of the arguments); tool results keep 300 characters (800 for errors). Captures run one at a time in the background, at most three queued, and are aborted on `session_shutdown`. Jev is used only through OpenRouter. When OpenRouter or DeepSeek is not logged in, passive capture pauses with one warning per session.

## Dream

Dreams follow the Claude cookbook's [dreaming with a dynamic workflow](https://platform.claude.com/cookbook/managed-agents-cma-dreaming-with-a-dynamic-workflow): one analyzer agent over the new past sessions, then one organizer agent, each in its own Pi session.

1. Pick the sessions changed since the last dream but within the last three days (`DREAM_WINDOW_MS`; oldest first, at most 20 (`DREAM_MAX_SESSIONS`), leaving out the running session; the rest wait for the next dream). Like the cookbook's window, older sessions are never read: they describe a project that has since moved on, and with only the session to go on an analyzer records that old state as current. Then snapshot `notes/` to `.snapshots/<time>/` (the newest five are kept), and copy each raw session file unchanged to `.dream-work/<time>/sessions/NN-<session>.jsonl`. The copy is stable while that session keeps running; nothing is rendered, clipped, or dropped (thinking and full tool results included).
2. **Analyze**: one agent reads every session copy in order, oldest first (the prompt describes the JSONL entry format and suggests `jq`). For each session it fixes notes the session contradicts or a later session undoes (saying what it replaced), calls `confirm_passive` for passive notes the session supports, and adds durable facts no note holds yet. One analyzer rather than one per session: parallel analyzers writing the same notes created duplicate notes and overwrote each other's edits, and only a single reader in time order sees a later session revert an earlier one. If it fails, the dream is an error and every session is read again next time.
3. **Organize**: one agent over the whole store: frontmatter, merges that keep every fact line, and `CONFLICT: …` lines instead of guesses. It does not read session files.
4. Passive notes: a confirmed one gets `verified: <date>`. A dream counts a miss only when an analyzer finished one of the note's `sessions`; a dream that did not read the session the note came from leaves the count alone (a note without `sessions` counts every dream). Two misses delete the note (it stays in the snapshots and `log.md`). This rule is code, not a model decision.
5. Rebuild the index, measure what changed on disk (created, updated, deleted), append to `log.md`, store `lastDreamAt` (the newest session file read), and remove the work directory.

### Dream agents

Each agent is a Pi SDK session (`createAgentSession`) on DeepSeek Flash with `high` thinking:

- **No discovered resources**: `DefaultResourceLoader` with no extensions, skills, prompt templates, themes, or context files, and the agent prompt as its system prompt. The full memory extension must not load there: it would inject itself, capture the agent's own turns, and start dreams inside the dream.
- **Tools**: Pi's base tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) without a path guard in code, plus `memory` (its `create` never overwrites; an existing note is changed with `str_replace` or `insert`); analyzers also get `confirm_passive`. `/memories/...` paths given to `read`, `grep`, `find`, `ls` are mapped to the notes directory.
- **Notes and sessions only**: agents run in the dream's work directory, and the prompt tells them to read only the notes and the session copies they are given (not the project or git) and to write nothing outside the notes. This is an instruction, not a sandbox; in tests DeepSeek Flash kept to it.
- **Prompt rules**: the prompt states today's date and the session id, keeps `source`, `sessions`, `verified`, and `unverifiedDreams` for the memory system (never added or changed by an agent), and asks for no temporary state or line numbers, dating facts that may change.
- **One writer at a time**: the analyzer and then the organizer are the only agents changing the notes, one after the other.
- **Own transcripts**: agent sessions are saved under `<memory>/dreams/`, never in the project's session directory, so later dreams do not review dreams. Files older than 30 days are deleted on session start.
- **Records**: each agent run appends one `calls.jsonl` line with its summed usage and cost, tool-call count, final reply, confirmed names, and session file.

Session files and notes are treated as data, never instructions. Dreams run from `/memory` → Dream → Run now, or automatically on session start at most once a day when at least three new sessions exist within the window and auto-dream is on. A lock file keeps one dream per project across Pi processes. Dreams are aborted on `session_shutdown` (the running agents are aborted too) and leave `lastDreamAt` unchanged.

## `/memory`

One command opens a `SettingsList` panel, like `/settings`:

- **记忆** on/off: injection, the tool, and passive capture.
- **被动捕获（实验）** on/off.
- **笔记** › list → Enter shows the note, `d` twice deletes it.
- **Dream** › run now, daily auto-dream on/off, `log.md`.
- **调用历史** › totals per role → the last 50 calls → one call's full record.
- **存放位置**.

Outside the TUI, `/memory` prints a one-line status.

## Call history

Every Jev and DeepSeek call appends one line to `calls.jsonl` in the memory directory: time, session, role (`jev-judge`, `deepseek-capture`, `deepseek-analyze`, `deepseek-organize`), provider, model, reasoning level, latency, usage and cost (from the reply's `usage`, summed over an agent run), stop reason, error, the full input and output (for dream agents: the session copy, final reply, tool-call count, confirmed names, and the agent's session file), and an outcome (`passed`, `below-threshold`, `create`, `update`, `skip`, `parse-error`, `applied`, `error`). On each session start, lines older than 30 days are dropped and dream agent session files older than 30 days are deleted; `calls.jsonl` also rotates to `calls.1.jsonl` past 20 MB.

## Runtime files

```text
<agent-dir>/memory/--<project>--/
  config.json        { enabled, passive, dreamAuto, lastDreamAt }; missing = all on
  calls.jsonl        model call history
  log.md             passive writes, deletions, dreams
  dreams/            dream agents' own Pi session files (30 days)
  .snapshots/<time>/ copies of notes/ taken before dreams
  .dream-work/       raw session copies while a dream runs
  .dream.lock        held while a dream runs
  notes/             /memories: MEMORY.md and the notes
```

All of it is runtime state: never installed from or committed to this repository.

## Tests

The core modules (`store.ts`, `tool.ts`, `transcript.ts`, `call-log.ts`, `port.ts`, `capture.ts`, `dream.ts`, `prompts.ts`) have no Pi imports; `dream-agent.ts`, `memory-tool.ts`, `panel.ts`, and `index.ts` use Pi:

```bash
node --test extensions/memory/*.test.ts
```

Capture and dream tests use a fake model port and a fake agent runner, so they make no model calls.
