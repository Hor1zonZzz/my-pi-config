# Background Task

Gives every Pi session its own scratchpad directory and adds two tools that run shell commands without blocking the agent loop:

- `background_task` reports a command once, when it exits.
- `monitor` delivers each stdout line of a watch script as an event while it runs, modeled on Claude Code's Monitor tool.

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
| Normal exit (any code), or failure to start | `deliverAs: "steer"`, `triggerTurn: true`: a busy agent sees it after its current step; an idle agent starts a new turn |
| Terminated by `SIGTERM`, `SIGINT`, or `SIGHUP`, or stopped with `/bg stop` | `triggerTurn: false`: recorded for the next turn without waking the model |
| Killed by session shutdown | not reported |

### Lifecycle

- Pressing Esc to abort a turn does not affect background tasks.
- `/new`, `/resume`, `/fork`, `/reload`, and quitting kill the session's running tasks (whole process groups) and mark them `stopped`. Pi also kills tracked process groups when it exits. Tasks never outlive the Pi process; use Herdr or tmux for that.
- In print mode (`pi -p`), Pi exits once the agent settles, which kills any running task.
- Tool-call permission hooks that only inspect `bash` do not see `background_task` commands.

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

Accent-colored `bg N` and `mon N` footer statuses show the number of running tasks and monitors.

## Tests

```bash
node --test extensions/background-task/*.test.ts
```

The core modules do not import Pi, so the tests run with plain Node. `task-manager.test.ts` and `monitor-manager.test.ts` use a minimal stand-in for Pi's shell backend (`test-exec.ts`) and spawn real processes.
