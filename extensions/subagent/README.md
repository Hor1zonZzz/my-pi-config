# Subagent Example

Delegate tasks to specialized subagents with isolated context windows.

## Features

- **Isolated context**: Each subagent runs in a separate `pi` process
- **Blocking or background execution**: `action: "block"` waits; `action: "background"` returns a task ID immediately
- **Session task management**: `list`, `status`, and `cancel` actions manage tasks created by the current Pi session
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
├── index.ts             # The extension (entry point)
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

`action` is required; the legacy action-less shape is intentionally unsupported.

| Action | Parameters | Description |
|--------|------------|-------------|
| `block` | Exactly one of `{ agent, task }`, `{ tasks }`, or `{ chain }` | Persist the task and wait for completion |
| `background` | Exactly one execution mode | Persist the task, start/queue it, and return its ID immediately |
| `list` | none | List tasks for the current Pi session |
| `status` | `taskId` | Show persisted status JSON |
| `cancel` | `taskId` | Cancel a queued or running task |

Parallel mode accepts at most 8 subagents. A global FIFO scheduler shared by
blocking and background calls limits actual child Pi processes.

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
later task.

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

## Sample Agents

| Agent | Purpose | Model | Tools | Extensions |
|-------|---------|-------|-------|------------|
| `scout` | Fast codebase recon | Luna | read, grep, find, ls, bash | automatic discovery |
| `planner` | Implementation plans | Sol | read, grep, find, ls | automatic discovery |
| `reviewer` | Code review | Sol | read, grep, find, ls, bash | automatic discovery |
| `worker` | General-purpose implementation | Sol | read, bash, edit, write, lsp_diagnostics | `npm:pi-lens` only |

## Workflow Prompts

| Prompt | Flow |
|--------|------|
| `/implement <query>` | scout → planner → worker |
| `/scout-and-plan <query>` | scout → planner |
| `/implement-and-review <query>` | worker → reviewer → worker |

## Error Handling

- **Exit code != 0**: Task fails with stderr/output recorded in its result files
- **stopReason "error"**: LLM error is propagated and persisted
- **stopReason "aborted"**: Cancellation sends `SIGTERM`, then `SIGKILL` after 5 seconds if needed
- **Chain mode**: Stops at the first failing step
- **Session shutdown**: Queued/running tasks are cancelled; stale running states are marked `interrupted` on the next session start
- **Tree navigation**: `/tree` is blocked while the current session has queued or running subagent tasks

## Limitations

- Output truncated to last 10 items in collapsed view (expand to see all)
- Model-visible output is capped at 50 KB or 2,000 lines per subagent, whichever comes first; complete results remain in task files
- Chain `{previous}` transfer is intentionally unbounded and can exceed a later agent's context window
- Agents are discovered fresh on each invocation (allows editing mid-session)
- Parallel mode is limited to 8 subagents
- Scheduler limits apply only within one parent Pi process; separate Pi processes do not coordinate slots
