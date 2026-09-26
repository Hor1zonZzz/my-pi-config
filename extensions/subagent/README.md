# Subagent

English | [中文](README.zh-CN.md)

Delegate scoped tasks to specialized agents. Each subagent is a separate `pi`
process with its own context window. It can run in the foreground (the parent
waits) or in the background (`async: true`). Its full session is saved so you
can read it later, and a panel below the editor lets you watch or stop running
subagents.

```text
  ⠼  subagent  parallel · 1/3 done                                     12s · ↓1.2k
     ├ ● scout   Find the models …                                     8s · ↓900
     ├ ⠼ scout   Find the providers …                read src/providers.ts · 12s
     └ · worker  Update the docs …                                        queued

  ─ ⠼ Running subagent · 12s ──────────────────────────────────────────────────

  ─ gpt-5.6-sol · medium ─────────────────────────────────────── context 42% ──
  ▾ 2 subagents running  ·  ↑↓ select · enter view · x stop · esc back
  › ⠼ scout  Find the providers …                    read src/providers.ts · 12s
    ⠼ worker bg  Update the docs …                              $ npm test · 3s
```

This is this repository's own implementation. Agent discovery (`agents.ts`), the
sample agents, the workflow prompts, and parts of the process runner come from
Pi's official subagent example; the rest was rewritten.

## Structure

```text
subagent/
├── index.ts        # Wiring: tool, commands, panel, overlays, lifecycle
├── tool.ts         # The subagent tool: modes, sync/async, results
├── notices.ts      # One-line state notices for background runs
├── control.ts      # subagent_control: send (steer, interrupt, continue) and stop
├── runner.ts       # Starts a child pi in RPC mode, sends the task, parses events, saves metadata
├── runs.ts         # Run snapshots and the in-memory registry of this process's runs
├── store.ts        # Child session directory, metadata, transcript reading
├── background.ts   # Background jobs and steer delivery
├── panel.ts        # List below the editor and its keyboard handling
├── viewer.ts       # Live transcript view and /subagent-history
├── render.ts       # Tool rows, completion cards, panel rows
├── format.ts       # Pure formatting helpers
├── config.ts       # /subagent model and thinking-level configuration
├── agents.ts       # Agent discovery and frontmatter updates
├── agents/         # scout, planner, reviewer, worker
└── prompts/        # /scout, /implement, /scout-and-plan, /implement-and-review
```

## Calling subagents

The tool takes exactly one mode:

| Mode | Parameters | Behavior |
| --- | --- | --- |
| Single | `{ agent, task }` | One agent, one task |
| Parallel | `{ tasks: [...] }` | Up to 8 tasks, at most 4 running at once |
| Chain | `{ chain: [...] }` | Sequential; `{previous}` is replaced by the prior step's answer |

Each mode runs in the foreground by default. Add `async: true` to run it in the
background:

```json
{ "agent": "scout", "task": "Find authentication entry points.", "async": true }
```

- **Foreground (sync).** The tool row updates live while the parent waits. The
  result is the subagent's answer, or for parallel runs one section per task
  (each capped at 50 KB), followed by a `Transcripts:` line per run with its
  short ID and session file.
- **Background (async).** The call returns at once with one line per task: its
  short run ID, agent, first state (`running`, or `queued` for later chain steps
  and parallel tasks beyond the 4 that start together), and session file. See
  [the main agent's view](#what-the-main-agent-sees) for what follows. At most 4
  background jobs run at once. Async needs a long-lived TUI or RPC session; print and
  JSON modes reject it, and so does a subagent (its session ends when its own
  task settles).

Project-local agents (`.pi/agents/*.md`) run only with `agentScope: "project"` or
`"both"`, and the tool always asks for confirmation first, even in trusted
projects, unless the call sets `confirmProjectAgents: false`.

## Watching and stopping running subagents

While any subagent runs (foreground or background), a list appears below the
editor with each run's current action and elapsed time.

| Key | Where | Action |
| --- | --- | --- |
| `↓` | empty prompt | Move into the list |
| `↑` `↓` | list | Select; `↑` on the first row returns to the prompt |
| `Enter` | list | Open the live transcript |
| `x` `x` | list or transcript | Stop the selected run (press twice within 3 s) |
| `Esc` | list | Return to the prompt without interrupting the main agent |
| any other key | list | Return to the prompt and type normally |

`↓` is taken only when the prompt is empty and has focus, so history navigation
and multi-line editing keep working. Stopping a run affects only that run: other
parallel tasks keep going, a chain stops at that step, and the tool or job
reports the run as stopped. Work the subagent already did is not rolled back.
Stopping sends the child Pi an `abort` and closes its input so it shuts down in
order; a child still running 2 s later gets SIGTERM, and SIGKILL 5 s after that.

The transcript view shows the task, thinking (first lines; `t` shows all), tool
calls, tool results, and the answer as it streams. It follows new output until
you scroll up; `G` or `End` follows again. Keys: `↑↓`, `PgUp`/`PgDn`, `g`/`G`,
`t`, `x x`, `Esc`.

## History

```text
/subagent-history
```

Lists every run of the current session, including runs from before `/reload` or
a restart, newest first. `Enter` opens a transcript, `x x` stops a running one,
`r` refreshes, `Esc` closes.

Each run saves Pi's own session file plus a metadata file:

```text
<agent dir>/subagent-sessions/<parent session id>/
├── <short run id>.jsonl   # the child session, written entry by entry as it runs
└── <run id>.meta.json     # agent, task, mode, status, timing, usage, answer
```

At dispatch the extension picks a run ID whose first 8 characters are unique in
the directory and creates the empty `<short run id>.jsonl`. The child is started
with `--session <that file>`: Pi fills an empty session file with its header at
once and appends every later entry immediately, so the path handed to the main
agent exists from the start. Tasks that never start (a stopped chain, a
cancelled job) leave no file. Runs recorded before this used Pi's own name,
`<timestamp>_<run id>.jsonl`, and are still found. These files are kept permanently; delete the directory to free
space. They contain whatever the subagent read, like any Pi session, and they do
not appear in `/resume`. A run whose Pi process exited before it finished is
shown as interrupted.

`/subagent-jobs` opens the same list in the TUI. `/subagent-jobs cancel <id|all>`
cancels background jobs from any mode.

## What the main agent sees

For background runs the main agent gets three kinds of messages, and nothing
while a run's state stays the same:

```text
tool result   Started background job subagent-37690385. State changes arrive as …
              67380226 scout running /…/subagent-sessions/<parent>/67380226.jsonl
              8edb76e2 scout running /…/subagent-sessions/<parent>/8edb76e2.jsonl

notice        <subagent_notification>
              {"run":"67380226","status":"completed"}
              </subagent_notification>

final         Background job subagent-37690385 completed.
              <subagent_result run="67380226" agent="scout" status="completed">
              ONE
              </subagent_result>
              <subagent_result run="8edb76e2" agent="scout" status="completed">
              …
              </subagent_result>
```

- **Notice**: one per change of a run's state after dispatch: `queued →
  running`, and `running → completed | failed | stopped`. It carries only the
  run and its status (about 20 tokens), is stored in the session like any
  message, and is sent with `triggerTurn: false`: while the main agent works,
  Pi appends it at the end of the current turn; when it is idle, at once. It
  never starts a turn and shows as one line in the chat. Activity (the file
  being read, the tool being called), elapsed time, and usage are not changes.
- **Final message**: the change that ends a job is not noticed separately. The
  job's final message gives every task's status and answer (up to 16 KB each,
  `not started` for chain steps that never ran) and is delivered with
  `deliverAs: "steer"` and `triggerTurn: true`, so an idle main agent starts a
  new response. The whole message is capped at 32 KB and 1,000 lines.
- **Progress**: to see what a subagent did, the main agent reads its session
  file with `read`. There is no separate inspection tool; `subagent_control`
  only acts on runs (below).
- Foreground runs send no notices; the main agent is waiting inside the call.
- [`codex-server-compaction`](../codex-server-compaction/README.md) does not
  retain notices as user input during remote compaction. Because they only
  append to the history, prompt caching and Codex continuation are unaffected.

### Messaging and stopping a run

`subagent_control` gives the main agent two actions on a run of this session:

| Call | Run is running | Run has finished |
|---|---|---|
| `{ action: "send", run, message }` | Pi's `steer`: seen after the current step | Continued in the background on its own session file, with its full context; the answer arrives as a final message |
| `{ action: "send", run, message, interrupt: true }` | `abort`, then the message as a new prompt: the current step (a running command too) stops and the run works on the message | Same as above |
| `{ action: "stop", run }` | Ends it: `abort`, orderly exit, SIGTERM after 2 s, SIGKILL 5 s later; the result waits and says `stopped` | Says it is already finished |

- `run` is the short ID from a result; a unique prefix also works.
- A dispatched task that has not started can be stopped: it never starts and
  leaves no file. `send` waits up to 5 s for a just-dispatched run to start and
  otherwise asks to send again after its `running` notice.
- The main agent's own stops add no notice; the tool result reports them.
  An interrupt keeps the run's stdin open across the abort's `agent_settled`
  until the new prompt starts.
- Continuing a project-local agent asks for confirmation again.

## Configuring agents

```text
/subagent
```

Opens searchable selectors for a user agent, a model available to the session
(within the session's scoped models when configured), and a thinking level the
model supports, then writes `model` and `thinkingLevel` to the agent's
frontmatter. The change applies to the next run without `/reload`. Re-running
this repository's installer replaces installed agent files with the repository
copies, so move durable changes into `agents/` first.

An agent without `model` inherits the parent's model and thinking level. An agent
with `model` keeps its own thinking level.

The tool description lists each user agent's name and description, which is how
the model knows what it can call. It is built when the extension loads, so run
`/reload` after adding or renaming an agent file. Calling an unknown name fails
with the list of agents that do exist.

## Agent definitions

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
model: "provider/model-id"
thinkingLevel: "high"
---

System prompt for the agent.
```

User agents live in `<agent dir>/agents/`, project agents in the nearest
`.pi/agents/`.

## Tool rows and messages

Collapsed rows show one line per run: a status mark (spinner, `●` done, `✕`
failed, `○` stopped, `·` queued), the agent and task, and the current action or
duration and output tokens. `Ctrl+O` expands a row to show each run's task, tool
calls, answer as Markdown, usage, and where its transcript is. Background
completions appear as a card with the same layout. Rows from sessions recorded
by the previous version of this extension still render.

## Compatibility and validation

Verified with Pi 0.87.1. The extension depends on:

- `pi --mode rpc` with `--session` (an empty file gets a header at once and
  every entry as it happens), `--session-dir`, `--name`, `--model`,
  `--thinking`, `--tools`, and `--append-system-prompt`; the task is the first
  `prompt` command on stdin, and a `prompt` response with `success: false` fails
  the run;
- the session events `message_start`, `message_update`, `message_end`,
  `tool_execution_*`, `auto_retry_start`, `compaction_start`, and
  `agent_settled`, after which the runner closes stdin and Pi exits;
- the `abort`, `steer`, and later `prompt` commands (an interrupt is `abort`
  then `prompt`, with stdin held open across the abort's `agent_settled`), and
  orderly shutdown when stdin closes; `--session` on a non-empty file continues
  that session;
- RPC extension UI requests: `select`, `confirm`, `input`, and `editor` block
  until answered, so the runner answers `cancelled: true` (a subagent has no one
  to ask); notifications and status updates are ignored. In RPC mode child
  extensions see `ctx.hasUI === true` and `ctx.mode === "rpc"`. Terminal escape
  sequences an extension writes straight to stdout (such as `notify.ts`'s OSC
  notification) are stripped before parsing. Children get `PI_SUBAGENT_CHILD=1`,
  which makes the `subagent` tool refuse `async: true`;
- `message` entries in the session file, and Pi's own name
  `<timestamp>_<session id>.jsonl` for runs recorded before `--session`;
- `ctx.ui.onTerminalInput()` running before the focused component, the concrete
  TUI's `getFocusedComponent()`, and Pi's main editor carrying `actionHandlers`
  (how the panel tells the prompt apart from dialogs);
- `ctx.ui.setWidget(..., { placement: "belowEditor" })` and overlay
  `ctx.ui.custom()`;
- `pi.sendMessage(..., { triggerTurn: false })` appending at the end of the
  current turn while the agent streams, and at once while it is idle.

Tests run with Node 24 against the installed Pi packages. Use a disposable copy
whose `node_modules/@earendil-works` and `node_modules/typebox` point at the
installed packages:

```sh
node --test subagent/*.test.ts
```

They cover the runner with a fake RPC child (session arguments, the task
prompt, events, metadata, user stop versus parent abort, the abort command,
SIGKILL escalation, cancelled dialogs, ignored notifications, stray escape
sequences, rejected prompts, and the child marker), background jobs, the panel's
key handling, rendering at widths from 1 to 160 columns, legacy details, the
transcript and history views, an end-to-end select → watch → stop → history
flow, background state notices and final answers, reserved session files, a
real-process chain that releases the files of steps that never ran, and
`subagent_control` steer, interrupt, stop, stop-before-start, send right after
dispatch, and continue on the same session file).

For an interactive check, load the entry file directly. Passing the directory
makes Pi treat it as a package because it contains `prompts/`:

```sh
pi --no-extensions -e ./extensions/subagent/index.ts
```
