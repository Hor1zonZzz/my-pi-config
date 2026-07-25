# Subagent Example

Delegate tasks to specialized subagents with isolated context windows.

## Features

- **Isolated context**: Each subagent runs in a separate `pi` process
- **Blocking or background execution**: `action: "block"` waits; `action: "background"` returns a task ID immediately
- **Session task management**: `list`, `status`, and `cancel` actions manage tasks created by the current Pi session
- **Persistent RPC jobs**: `persistent: true` starts reusable `pi --mode rpc --no-session` children for single or parallel work
- **Persistent control**: `subagent_control` can `list`, `read`, `send`, `wait`, or `stop` RPC jobs
- **Streaming output**: Blocking calls show tool calls and progress as they happen
- **Parallel streaming**: All blocking parallel tasks stream updates simultaneously
- **Markdown rendering**: Final output rendered with proper formatting (expanded view)
- **Usage tracking**: Shows turns, tokens, cost, and context usage per agent
- **Abort support**: Ctrl+C propagates to kill subagent processes
- **Extension isolation**: Agent definitions can disable automatic extension discovery and explicitly allow selected extensions

## Structure

```
subagent/
├── README.md            # This file
├── index.ts             # Extension entry point and existing task workflow
├── rpc-client.ts        # Strict JSONL RPC transport and process-tree cleanup
├── persistent-jobs.ts   # Persistent job lifecycle, generations, control, and completion delivery
├── hud.ts               # Width-safe TUI persistent-job HUD
├── tests/               # Fake-RPC deterministic lifecycle smoke harness
├── agents.ts            # Agent discovery logic
├── agents/              # Sample agent definitions
│   ├── scout.md         # Fast recon, returns compressed context
│   ├── planner.md       # Creates implementation plans
│   ├── reviewer.md      # Code review
│   └── worker.md        # Controlled implementation tools
└── prompts/             # Workflow presets (prompt templates)
    ├── implement.md     # scout -> planner -> worker
    ├── scout-and-plan.md    # scout -> planner (no implementation)
    └── implement-and-review.md  # worker -> reviewer -> worker
```

## Installation

From this repository root, run:

```bash
./install.sh
```

The installer copies `extensions/subagent/` into the target extension directory,
then copies its nested resources to Pi's discovery locations:

- `extensions/subagent/agents/*.md` → `~/.pi/agent/agents/`
- `extensions/subagent/prompts/*.md` → `~/.pi/agent/prompts/`

The source paths are relative to the repository root, so the resource layout has a
single source of truth and no root-level `agents/` or `prompts/` mirror.

## Security Model

This tool executes a separate `pi` subprocess with a delegated system prompt and tool/model configuration.

**Project-local agents** (`.pi/agents/*.md`) are repo-controlled prompts that can instruct the model to read files, run bash commands, etc.

**Default behavior:** Only loads **user-level agents** from `~/.pi/agent/agents`.

To enable project-local agents, pass `agentScope: "both"` (or `"project"`). Only do this for repositories you trust.

When running interactively, the tool prompts for confirmation before running project-local agents. Set `confirmProjectAgents: false` to disable.

## Usage

### Blocking single agent

```json
{
  "action": "block",
  "agent": "scout",
  "task": "Find all authentication code"
}
```

### Background parallel execution

```json
{
  "action": "background",
  "tasks": [
    { "agent": "scout", "task": "Find models" },
    { "agent": "scout", "task": "Find providers" }
  ]
}
```

### Persistent RPC single or parallel execution

Omit `action` and set `persistent: true`. Single returns one job ID; parallel
returns one independently managed ID per item. Each child proactively sends a
bounded completion for every settled generation and remains idle with its
conversation context available for reuse.

```json
{
  "persistent": true,
  "agent": "worker",
  "task": "Implement the first increment"
}
```

```json
{
  "persistent": true,
  "tasks": [
    { "agent": "scout", "task": "Inspect models" },
    { "agent": "reviewer", "task": "Review the API boundary" }
  ]
}
```

Persistent mode deliberately rejects task-management fields such as `action`
and `taskId`, and does not support `chain`; use the existing `action: "block"`
or `action: "background"` flow instead.

### Persistent job control

```json
{ "action": "list" }
{ "action": "read", "jobId": "job_..." }
{ "action": "send", "jobId": "job_...", "message": "Focus on tests", "delivery": "steer" }
{ "action": "send", "jobId": "job_...", "message": "Then review the diff", "delivery": "followUp" }
{ "action": "wait", "jobId": "job_...", "timeoutMs": 120000 }
{ "action": "stop", "jobId": "job_..." }
```

These are `subagent_control` calls, not `subagent` task-management actions.
`wait` joins the current generation. A wait registered before settlement
suppresses that generation's automatic push; if the wait times out or is
aborted first, a later settlement is still pushed exactly once. `send` is
serialized with `stop`. The RPC transport tracks `agent_start` and
`agent_settled` generations rather than trusting the HUD status: idle jobs use
`prompt` to start a new generation, while active jobs use `steer` or
`follow_up`. If settlement wins the command race, a definitive idle rejection
is retried as `prompt`; if Pi already accepted the queued instruction while
idle, a neutral `prompt` starts a generation that drains it without duplicating
the instruction. Ambiguous transport failures fail and terminate the job
instead of returning a false acceptance. After every successful prompt ACK, the
transport waits briefly for `agent_start`/`agent_settled`. A prompt consumed by
an extension command or `input` handler (for example `/fast on`) is explicitly
settled as handled-without-agent: it produces no synthetic model output or
automatic completion, `wait` returns, and the job no longer counts as busy.
The same activity check is applied around `steer`/`follow_up` acceptance.

### Blocking chained workflow

```json
{
  "action": "block",
  "chain": [
    { "agent": "scout", "task": "Find the read tool" },
    { "agent": "planner", "task": "Suggest improvements from:\n{previous}" }
  ]
}
```

Chain steps receive the previous step's complete final text without truncation.
Only the final chain step is returned to the parent, capped at 50 KB.

### Task management

```json
{ "action": "list" }
{ "action": "status", "taskId": "task_..." }
{ "action": "cancel", "taskId": "task_..." }
```

### Workflow prompts

```
/implement add Redis caching to the session store
/scout-and-plan refactor auth to support OAuth
/implement-and-review add input validation to API endpoints
```

## Tool Modes

`action` is optional. When omitted, a request containing exactly one valid
single/parallel/chain mode defaults to blocking execution. If action is omitted
without exactly one mode, the tool returns the currently discoverable Agents
(the legacy empty-call behavior).

| Action | Parameters | Description |
| -------- | ------------ | ------------- |
| `block` (or omitted) | Exactly one of `{ agent, task }`, `{ tasks }`, or `{ chain }` | Persist the task and wait for completion |
| `background` | Exactly one execution mode | Persist the task, start/queue it, and return its ID immediately |
| `list` | none | List tasks for the current Pi session |
| `status` | `taskId` | Show persisted status JSON |
| `cancel` | `taskId` | Cancel a queued or running task |
| omitted + `persistent: true` | Exactly one single or parallel mode | Start reusable RPC job(s); `action` conflicts and chain is rejected |

Parallel mode accepts at most 8 subagents. A global FIFO scheduler shared by
blocking and background calls limits actual child Pi processes. Persistent
children use the same `maxConcurrentProcesses` accounting and retain a running
slot while idle. They use an atomic immediate-only reservation: persistent jobs
are never queued and cannot bypass an existing ordinary FIFO queue, because
queued launches can deadlock behind idle children that hold their slots. When
persistent running jobs plus their immediate reservations occupy every process
slot, an ordinary blocking/background reservation (including actionless block)
fails immediately with guidance to stop a persistent job instead of entering a
queue that cannot drain. Releasing or stopping one persistent child makes that
slot available to ordinary FIFO work again. Startup accepts the parent tool's
`AbortSignal`; interruption
cancels prompt ACK waits, terminates any children already created, and releases
all reservations. Parallel startup has one ACK/activity barrier: automatic
reports are disabled until every child is acknowledged and classified, and any
partial failure stops and
awaits every launched lifetime before returning. Stop a persistent job or wait
for regular work to finish when capacity is unavailable. Agent system prompts
are passed by path through per-job temporary files/directories (directory mode
`0700`, file mode `0600` on POSIX), never as full argv text. Preparation is
abort-aware, and every pre-spawn, startup-failure, stop, and shutdown path
removes the temporary material.

## Output Display

**Collapsed view** (default):

- Status icon (✓/✗/⏳) and agent name
- Last 5-10 items (tool calls and text)
- Usage stats: `3 turns ↑input ↓output RcacheRead WcacheWrite $cost ctx:contextTokens model`
- Extension policy: automatic discovery, none, or an explicit allowlist (full sources in expanded view)

**Expanded view** (Ctrl+O):

- Full task text
- All tool calls with formatted arguments
- Final output rendered as Markdown
- Per-task usage (for chain/parallel)

**Parallel mode streaming**:

- Shows all tasks with live status (⏳ running, ✓ done, ✗ failed)
- Updates as each task makes progress
- Shows "2/3 done, 1 running" status
- Returns each completed subagent's final output to the parent model, capped at 50 KB per subagent
- Returns failure diagnostics from stderr/error messages when a child exits before producing output

**Background completion:**

- Completed tasks are injected with `followUp` and automatically trigger the parent agent.
- A completion arriving while the parent is busy waits for `agent_settled`; all completions accumulated during that run are combined into one follow-up.
- Single returns at most 50 KB/2,000 lines; parallel applies that limit per subagent; chain returns only its final step with the same limit.
- Persistent jobs apply one 50 KiB/2,000-line boundary to the complete proactive completion message (headers, task metadata, and output), and the same boundary to `read` and successful `wait` output. The initial generation cannot push before the parallel ACK/activity barrier, and each settled generation is deduplicated.

## Task Files

Every blocking and background invocation writes complete output under:

```text
<cwd>/.pi/subagent-tasks/<sessionId>/<taskId>/
├── status.json
├── result.md
└── details.json
```

`result.md` contains complete final text for every subagent. `details.json`
contains structured messages, stderr, usage, model, and exit information.
Files are not automatically deleted.

## Scheduler Settings

Global settings live in `~/.pi/agent/subagent-settings.json`:

```json
{
  "version": 1,
  "maxConcurrentProcesses": 4,
  "maxQueuedProcesses": 16
}
```

Settings are read at session start. There is no task timeout. The queue is FIFO
by child-process request; a large parallel task may occupy the queue before a
later task. Persistent jobs share `maxConcurrentProcesses` but not
`maxQueuedProcesses`; an idle RPC process continues to consume its slot until
`subagent_control stop`, reload, session replacement, or shutdown. If all
concurrent slots are persistent, new ordinary reservations fail fast rather than
consume `maxQueuedProcesses` and wait indefinitely.

**Tool call formatting** (mimics built-in tools):

- `$ command` for bash
- `read ~/path:1-10` for read
- `grep /pattern/ in ~/path` for grep
- etc.

## Agent Definitions

Agents are markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
model: claude-haiku-4-5
# Omit extensions to preserve normal extension discovery.
# Use `extensions: none` to load no discovered extensions, or a YAML array
# to load only explicit Pi extension sources.
extensions:
  - npm:pi-lens
  - ../extensions/my-extension.ts
---

System prompt for the agent goes here.
```

**Locations:**

- `~/.pi/agent/agents/*.md` - User-level (always loaded)
- `.pi/agents/*.md` - Project-level (only with `agentScope: "project"` or `"both"`)

Project agents override user agents with the same name when `agentScope: "both"`.

### Extension isolation

The optional `extensions` frontmatter controls extension discovery for the child Pi process:

```markdown
# Omitted: preserve normal automatic extension discovery.

extensions: none # Passes --no-extensions.

extensions:
  - npm:pi-lens # Passes --no-extensions -e npm:pi-lens.
  - ../extensions/my-extension.ts
```

An explicit array first disables automatic extension discovery, then loads only the listed Pi extension sources. Local `./` and `../` paths are resolved relative to the agent definition file; package sources such as `npm:` and `git:` are passed through to Pi. An invalid configured value fails the agent invocation instead of silently loading all extensions.

`tools` is a separate allowlist: it controls which tools the model may call, but it does not stop a loaded extension's commands or lifecycle handlers. Extension sources execute code at child-Pi startup, so only use project-local agents and sources from repositories you trust. This setting does not disable skills, prompt templates, or context files.

Persistent RPC children are non-interactive. Under Pi 0.82's documented
Extension UI protocol, the transport automatically sends
`extension_ui_response { cancelled: true }` for `select`, `confirm`, `input`,
and `editor`; fire-and-forget UI requests are ignored. This preserves normal
extension discovery without allowing an unexpected dialog to hang the child.
Malformed JSONL and invalid event envelopes (including response, assistant
`message_end`, activity, and Extension UI shapes) are recorded as protocol
errors and terminate the job. Exceptions from event callbacks are contained and
converted into the same per-child protocol failure instead of escaping a stdout
handler.

## Sample Agents

| Agent | Purpose | Model | Tools | Extensions |
| ------- | --------- | ------- | ------- | ------------ |
| `scout` | Fast codebase recon | Luna | read, grep, find, ls, bash | automatic discovery |
| `planner` | Implementation plans | Sol | read, grep, find, ls | automatic discovery |
| `reviewer` | Code review | Sol | read, grep, find, ls, bash | automatic discovery |
| `worker` | General-purpose implementation | Sol | read, bash, edit, write, lsp_diagnostics | `npm:pi-lens` only |

## Workflow Prompts

| Prompt | Flow |
| -------- | ------ |
| `/implement <query>` | scout → planner → worker |
| `/scout-and-plan <query>` | scout → planner |
| `/implement-and-review <query>` | worker → reviewer → worker |

## Error Handling

- **Exit code != 0**: Task fails with stderr/output recorded in its result files
- **stopReason "error"**: LLM error is propagated and persisted
- **stopReason "aborted"**: Cancellation sends `SIGTERM`, then `SIGKILL` after 5 seconds if needed
- **Chain mode**: Stops at the first failing step
- **Session shutdown**: Queued/running tasks are cancelled and persistent process trees are awaited; stale running states are marked `interrupted` on the next session start
- **Process cleanup**: Unix children run in process groups and receive TERM, then KILL after 5 seconds; Windows uses `taskkill /T /F`; cleanup waits for process exit instead of trusting `ChildProcess.killed`
- **Tree navigation**: `/tree` is blocked only while ordinary tasks or persistent generations are busy (`starting`/`running`/`stopping`). A handled-without-agent or normally settled idle job does not leave the tree guard stuck. An unexpected idle-process exit transitions to one failed generation, wakes waiters, releases the process slot, and pushes one failure.
- **Bounded memory/history**: Persistent jobs retain cumulative usage/counts, bounded stderr (64 KiB/2,000 lines), bounded current/final output (50 KiB/2,000 lines), and only the three most recent generation results. The manager/HUD/`list` retain at most 100 terminal (`stopped`/`failed`) jobs; active and idle reusable jobs are never evicted, and the oldest terminal row is removed first with its generation maps, waiters, client references, and large strings cleared. Full message histories and unbounded streaming events are not retained; `read`, `wait`, completion delivery, and usage totals remain available.

## Deterministic smoke tests

The persistent lifecycle harness uses a fake JSONL child and never contacts a
model or API:

```bash
node --experimental-strip-types extensions/subagent/tests/persistent-smoke.ts
node --experimental-strip-types extensions/subagent/tests/scheduler-smoke.ts
node --experimental-strip-types extensions/subagent/tests/rpc-client-smoke.ts
```

The scheduler harness covers all-persistent fail-fast behavior, recovery after a
persistent child releases its slot, reservation/error accounting, ordinary FIFO
ordering, and the no-bypass rule. The invocation harness verifies missing and
Bun-virtual `argv[1]` values use standalone/generic runtime fallbacks instead of
being mistaken for executable script entries.

The persistent harness's 19 deterministic cases cover barrier-proven
stop/shutdown-before-client cancellation, parallel startup abort,
settled-to-send routing (including
accepted steer/settlement races), extension-handled prompts with no agent run,
idle/running process exit, ACK/activity/settlement ordering, atomic parallel
partial failure, wait timeout/abort deduplication, headless Extension UI
cancellation, malformed JSONL and malformed event shapes, callback-failure
containment, `0600` system-prompt temp-file use and cleanup, terminal-history
retention, agent-failure deduplication, and whole-message truncation.

## Limitations

- Output truncated to last 10 items in collapsed view (expand to see all)
- Model-visible output is capped at 50 KB or 2,000 lines per subagent, whichever comes first; complete results remain in task files
- Chain `{previous}` transfer is intentionally unbounded and can exceed a later agent's context window
- Agents are discovered fresh on each invocation (allows editing mid-session)
- Parallel mode is limited to 8 subagents
- Scheduler limits apply only within one parent Pi process; separate Pi processes do not coordinate slots
- Persistent job state and the HUD are session-memory state and are not restored after a process restart; terminal rows are capped at the 100 newest items, while active and idle reusable jobs remain visible
