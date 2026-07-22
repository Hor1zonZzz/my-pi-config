# Subagent Example

Delegate tasks to specialized subagents with isolated context windows.

## Features

- **Isolated context**: Each subagent runs in a separate `pi` process
- **Streaming output**: See tool calls and progress as they happen
- **Parallel streaming**: All parallel tasks stream updates simultaneously
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

### Single agent

```
Use scout to find all authentication code
```

### Parallel execution

```
Run 2 scouts in parallel: one to find models, one to find providers
```

### Chained workflow

```
Use a chain: first have scout find the read tool, then have planner suggest improvements
```

### Workflow prompts

```
/implement add Redis caching to the session store
/scout-and-plan refactor auth to support OAuth
/implement-and-review add input validation to API endpoints
```

## Tool Modes

| Mode | Parameter | Description |
|------|-----------|-------------|
| Single | `{ agent, task }` | One agent, one task |
| Parallel | `{ tasks: [...] }` | Multiple agents run concurrently (max 8, 4 concurrent) |
| Chain | `{ chain: [...] }` | Sequential with `{previous}` placeholder |

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
- Returns each completed task's final output to the parent model, capped at 50 KB per task
- Returns failure diagnostics from stderr/error messages when a child exits before producing output

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

- **Exit code != 0**: Tool returns error with stderr/output
- **stopReason "error"**: LLM error propagated with error message
- **stopReason "aborted"**: User abort (Ctrl+C) kills subprocess, throws error
- **Chain mode**: Stops at first failing step, reports which step failed

## Limitations

- Output truncated to last 10 items in collapsed view (expand to see all)
- Parallel model-visible output is capped at 50 KB per task; full results remain in tool details
- Agents discovered fresh on each invocation (allows editing mid-session)
- Parallel mode limited to 8 tasks, 4 concurrent
