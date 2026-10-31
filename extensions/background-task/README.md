# Background Task

Gives every Pi session its own scratchpad directory and adds the `background_task` tool, which runs a shell command without blocking the agent loop and reports its exit automatically.

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

## `/bg`

- `/bg` lists the session's tasks with their state, duration, and command.
- `/bg stop <id>` stops a running task.

A `bg N` footer status shows the number of running tasks.

## Tests

```bash
node --test extensions/background-task/*.test.ts
```

The core modules do not import Pi, so the tests run with plain Node. `task-manager.test.ts` uses a minimal stand-in for Pi's shell backend and spawns real processes.
