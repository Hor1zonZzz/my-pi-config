# Background Task

Gives every Pi session its own scratchpad directory and adds two tools that run shell commands without blocking the agent loop:

- `background_task` reports a command once, when it exits.
- `monitor` delivers each stdout line of a watch script as an event while it runs, modeled on Claude Code's Monitor tool.

In TUI and RPC sessions it also takes over the built-in `bash` tool, so a `bash` command that is still running after 30 seconds becomes a background task instead of blocking the turn.

## Session scratchpad

- Each session gets `<agent-dir>/scratchpad/<session-id>/`, created on `session_start`. `<agent-dir>` comes from Pi's `getAgentDir()`, so it follows `PI_CODING_AGENT_DIR`.
- A `<scratchpad>` system-prompt section tells the model to put temporary files there (intermediate results, throwaway scripts, downloads) instead of `/tmp` or the project.
- Resuming a session keeps its session ID and therefore its scratchpad; `/fork` and `/new` get a new one.
- On each session start, other sessions' scratchpads whose directory has not been touched for 14 days are deleted. Starting a session or a background task touches its scratchpad.
- The scratchpad is runtime state: it is never installed from or committed to this repository.

## `background_task`

```ts
background_task({ command: string, cwd?: string })
```

- Runs `command` through Pi's own local shell backend (`createLocalBashOperations()`), so it uses the same shell, `PATH` (including `<agent-dir>/bin`), and detached process-group tracking as the built-in `bash` tool.
- Returns immediately with the task ID (`bg-1`, `bg-2`, … per session), the process group ID, and the log path.
- Combined stdout/stderr goes to `<scratchpad>/background/<id>.log`. Escape sequences and control characters are stripped, and carriage-return progress lines keep only their final state. The model reads the log with `read` or `tail`.
- `<id>.json` records the command, working directory, times, process group, line count, and outcome, so the history survives a crash or restart.
- The model stops a task with `kill -- -<pgid>`; the user stops one with `/bg stop <id>`.
- At most 16 tasks run at once per session.

### Exit reports

When a task ends, a `background-task` custom message with the outcome, duration, log path, total line count, and up to the last 30 lines (4 KiB) is sent to the session that started it:

| Outcome | Delivery |
|---|---|
| Normal exit (any code), failure to start, or an expired `bash` timeout | `deliverAs: "steer"`, `triggerTurn: true`: a busy agent sees it after its current step; an idle agent starts a new turn |
| Terminated by `SIGTERM`, `SIGINT`, or `SIGHUP`, or stopped with `/bg stop` | `triggerTurn: false`: recorded for the next turn without waking the model |
| Killed by session shutdown | not reported |

### Lifecycle

- Pressing Esc to abort a turn does not affect background tasks.
- `/new`, `/resume`, `/fork`, `/reload`, and quitting kill the session's running tasks (whole process groups) and mark them `stopped`. Pi also kills tracked process groups when it exits. Tasks never outlive the Pi process; use Herdr or tmux for that.
- Tool-call permission hooks that only inspect `bash` do not see `background_task` commands.

## `bash` takeover

```ts
bash({ command: string, timeout?: number })
```

- The extension registers a `bash` tool built from Pi's own `createBashToolDefinition()`, so the schema, output truncation, live output, `PI_*` environment variables, and rendering stay those of the built-in tool. Only its process backend is replaced.
- A command that finishes within the threshold returns exactly as before. Esc before the threshold aborts it as before.
- A command still running at the threshold becomes background task `bg-N` and the call returns at once with the task ID, process group, log path, and up to the last 30 lines (4 KiB) of output so far. The log at `<scratchpad>/background/<id>.log` holds the complete output from the start; the TUI shows it as `Full output: <log>`.
- From then on it is an ordinary background task: Esc no longer stops it, it appears in `/bg` and the `bg` footer entry, and its exit is reported like any other task's. A `timeout` longer than the threshold still applies to the whole run; when it expires, the task is killed and the report wakes the model.
- A `timeout` no longer than the threshold always ends the command in the foreground. While 16 background tasks are already running, a slow command stays in the foreground.
- `PI_BASH_BACKGROUND_AFTER_MS` sets the threshold in milliseconds (default `30000`); `0` disables the takeover and leaves the built-in `bash` in place.
- The takeover is registered from `session_start`. If `bash` was not active (for example `--tools read`), it stays inactive.
- Before the threshold, output is also written to a hidden `.foreground-*` file under `<scratchpad>/background/`, which is renamed to the task log on promotion and deleted otherwise.
- Codemode scripts that call `bash` receive the promoted result as text, without `structuredContent`.

## Print and JSON modes

`pi -p` and `--mode json` dispose the session as soon as the agent settles, which would kill every background task and monitor without a report. Sessions without a UI (`ctx.hasUI` false) therefore keep the built-in synchronous `bash` and deactivate `background_task` and `monitor`.

## `monitor`

```ts
monitor({ command: string, description: string, timeout_ms?: number, cwd?: string })
```

- Runs `command` through the same shell backend as `background_task` and returns immediately with the monitor ID (`mon-1`, `mon-2`, … per session), the process group ID, the expiry, and the output paths.
- Each stdout line is an event. Lines are cleaned like `background_task` logs and also written to `<scratchpad>/monitor/<id>.log`; stderr is redirected inside the shell to `<id>.stderr.log` and never becomes an event. `<id>.json` records the monitor's metadata and outcome.
- Lines that arrive within 200 ms are delivered together as one `monitor` custom message headed by the description, with at most 40 lines (4 KiB, 500 characters per line); the rest is referenced by log line numbers. Each event is delivered with `deliverAs: "steer"`, `triggerTurn: true`.
- `timeout_ms` defaults to 5 minutes and is clamped to 1 second–30 minutes. At expiry the script is killed and the model is told to start a new monitor if it still needs the watch.
- A monitor that sends 30 events or receives 300 lines within one minute is stopped for flooding, and the model is told to use a tighter filter.
- The model stops a monitor with `kill -- -<pgid>`; the user stops one with `/bg stop <id>`.
- At most 8 monitors run at once per session.
- The tool's prompt guidelines cover choosing `background_task` for a single notification, per-line flushing (`grep --line-buffered`, no `head`), matching failure states as well as success, and keeping event volume low.

### End reports

Each monitor's end is reported once, with its outcome, event and line counts, any lines not yet delivered, and, when the script failed or exited with a nonzero code, the last 20 lines of stderr:

| Outcome | Delivery |
|---|---|
| Normal exit (any code), failure to start, expiry, or flood stop | `deliverAs: "steer"`, `triggerTurn: true` |
| Terminated by `SIGTERM`, `SIGINT`, or `SIGHUP`, or stopped with `/bg stop` | `triggerTurn: false` |
| Killed by session shutdown | not reported |

Monitors follow the same lifecycle as background tasks: they survive Esc and are killed silently on `/new`, `/resume`, `/fork`, `/reload`, and quit. Events and reports are delivered only to the session that started the monitor.

## `/bg`

- `/bg` lists the session's tasks and monitors with their state, duration, and command or description.
- `/bg stop <id>` stops a running task or monitor.

## Footer entries

Accent-colored `bg N` and `mon N` footer entries show the number of running tasks and monitors; an entry is hidden while nothing of its kind is running.

In the interactive TUI the entries can take focus:

| Key | Effect |
|---|---|
| `↓` in an empty editor | Focus the first visible entry (highlighted with the theme's selection background) |
| `←` / `→` | Move between `bg` and `mon` |
| `Enter` | Open the focused entry's list |
| `↑` or `Esc` | Return to the editor |
| Any other key | Return to the editor and type normally |

The list shows running items first, then finished ones, newest first, with ID, state, duration, and command or monitor description. `↑`/`↓` select, `x` stops the selected running item (the same as `/bg stop`, without confirmation), and `Esc` or `Enter` closes the list and keeps the entry focused.

The editor keeps real keyboard focus: a raw terminal input listener (`ctx.ui.onTerminalInput`) sees keys first and consumes only the navigation keys while an entry is focused. The list is a `ctx.ui.custom()` screen.

## Tests

```bash
node --test extensions/background-task/*.test.ts
```

The core modules, including the footer focus transitions in `status-focus.ts`, do not import Pi, so the tests run with plain Node. `status-ui.ts` holds the Pi TUI wiring. `task-manager.test.ts` and `monitor-manager.test.ts` use a minimal stand-in for Pi's shell backend (`test-exec.ts`) and spawn real processes.
