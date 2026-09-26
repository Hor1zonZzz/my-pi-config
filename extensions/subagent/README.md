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
├── control.ts      # The subagent_control tool: list, inspect, read, wait
├── status.ts       # Request-local <system_status> block for the main agent
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
  (each capped at 50 KB).
- **Background (async).** The call returns a job ID immediately. When the job
  finishes, the result arrives as a completion message delivered with
  `deliverAs: "steer"` and `triggerTurn: true`: a busy parent receives it before
  its next model call, an idle parent starts a new response. The parent should
  not repeat or poll the delegated work. At most 4 background jobs run at once;
  completion text is capped at 32 KB and 1,000 lines, and the full result is in
  the message details. Async needs a long-lived TUI or RPC session; print and
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
├── <timestamp>_<run id>.jsonl   # the child session (written as it runs)
└── <run id>.meta.json           # agent, task, mode, status, timing, usage, answer
```

The child is started with `--session-dir` and `--session-id` instead of
`--no-session`. These files are kept permanently; delete the directory to free
space. They contain whatever the subagent read, like any Pi session, and they do
not appear in `/resume`. A run whose Pi process exited before it finished is
shown as interrupted.

`/subagent-jobs` opens the same list in the TUI. `/subagent-jobs cancel <id|all>`
cancels background jobs from any mode.

## Checking on subagents from the main agent

The `subagent_control` tool lets the main agent look at the runs it started in
this session, including finished runs from before `/reload` or a restart:

```text
subagent_control { action: "list" }
2 runs · 1 running
a3f9c2e1  scout  running · bg subagent-1b2c3d4e · 1m12s · ↓3.1k · now: read src/auth.ts
          task: Find where tokens are refreshed
c02e9f17  reviewer  completed · 2m40s · ↓5.4k
          task: Review the runner changes
```

| Action | What it returns |
|---|---|
| `list` | Every run with its short ID, agent, status, job, elapsed time, output tokens, and current activity |
| `inspect` | One run: task, usage, current activity, the last 8 tool calls, the text being written, the answer, and the transcript file |
| `read` | A page of the transcript, messages numbered from 1; `from` and `limit` (default: the last 20). Long texts and tool results are shortened, and the page stays within Pi's 50KB / 2000-line limit |
| `wait` | Blocks until the named run or background job finishes, or, with no `run`, until any running run finishes; `timeout` defaults to 60 s (max 600). Esc cancels the wait |

`run` accepts a full run ID, a unique prefix, or a background job ID (`inspect`
and `read` need a job with one run). Background results still arrive on their
own; `wait` is for when the main agent has nothing else to do and needs the
result now. A foreground run keeps the main agent inside its `subagent` call, so
these actions matter mostly for background runs.

### Live status in every request

While subagents are active, every model request of the main agent ends with a
`<system_status>` block, so the model knows their state without calling a tool:

```text
<system_status>
Subagents: 1 running, 1 just finished. This status is current for this request only and is not kept in the conversation.
- a3f9c2e1 scout: running 1m 12s, background job subagent-1b2c3d4e, now: read src/auth.ts. Task: Find where tokens are refreshed
- c02e9f17 reviewer: completed in 2m 40s. Task: Review the runner changes
Use subagent_control to inspect, read, or wait for a run.
</system_status>
```

- It lists running runs, background jobs dispatched but not started yet
  (`starting`), and runs that finished since the last status the model saw;
  each finished run appears once. With nothing to report there is no block.
- It is appended through Pi's `context` event as a separate last user message
  of that request only. It is never written to the session, and the next request
  replaces it, so earlier requests' statuses do not accumulate. Placing it after
  every stable message keeps the prompt-cache prefix intact: on gpt-5.6-sol over
  the Codex WebSocket transport, 18 requests with the block cached 69.6% of input
  tokens against 70.1% without it.
- [`codex-server-compaction`](../codex-server-compaction/README.md) recognizes
  the tag: after a request that carried it, the next request sends full input
  instead of continuing with `previous_response_id` (a continued response keeps
  its request's input, stale status included), and remote compaction never
  retains it.

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

- `pi --mode rpc` with `--session-dir`, `--session-id`, `--name`, `--model`,
  `--thinking`, `--tools`, and `--append-system-prompt`; the task is the first
  `prompt` command on stdin, and a `prompt` response with `success: false` fails
  the run;
- the session events `message_start`, `message_update`, `message_end`,
  `tool_execution_*`, `auto_retry_start`, `compaction_start`, and
  `agent_settled`, after which the runner closes stdin and Pi exits;
- the `abort` command, and orderly shutdown when stdin closes;
- RPC extension UI requests: `select`, `confirm`, `input`, and `editor` block
  until answered, so the runner answers `cancelled: true` (a subagent has no one
  to ask); notifications and status updates are ignored. In RPC mode child
  extensions see `ctx.hasUI === true` and `ctx.mode === "rpc"`. Terminal escape
  sequences an extension writes straight to stdout (such as `notify.ts`'s OSC
  notification) are stripped before parsing. Children get `PI_SUBAGENT_CHILD=1`,
  which makes the `subagent` tool refuse `async: true`;
- the session file name `<timestamp>_<session id>.jsonl` and `message` entries;
- `ctx.ui.onTerminalInput()` running before the focused component, the concrete
  TUI's `getFocusedComponent()`, and Pi's main editor carrying `actionHandlers`
  (how the panel tells the prompt apart from dialogs);
- `ctx.ui.setWidget(..., { placement: "belowEditor" })` and overlay
  `ctx.ui.custom()`;
- the `context` event, whose returned messages apply to one model request and
  are not persisted.

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
flow, and `subagent_control` (listing, ID/prefix/job resolution, inspection,
transcript paging, waiting and its cancellation, finished runs read from disk
after a reload, and isolation between parent sessions).

For an interactive check, load the entry file directly. Passing the directory
makes Pi treat it as a package because it contains `prompts/`:

```sh
pi --no-extensions -e ./extensions/subagent/index.ts
```
