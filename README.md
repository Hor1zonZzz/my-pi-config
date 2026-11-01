# my-pi-config

My public, reproducible configuration for [Pi Coding Agent](https://github.com/earendil-works/pi).

English | [中文文档](README.zh-CN.md)

## Included

- `settings.json` — the default thinking level, theme, and installable Pi packages (no default model: the installer keeps the one already chosen locally), including the Herdr tool integration, Pi Voice (local speech-to-text with a recording shortcut and the `transcribe_file` tool), [`pi-subagent`](https://github.com/badlogic/pi-subagent) (observable subagents in tmux, driven by a `subagent` CLI and its bundled skill), and [`pi-cliproxyapi-provider`](https://www.npmjs.com/package/@router-for-me/pi-cliproxyapi-provider) (registers CLIProxyAPI models; configure it with `/login cliproxyapi`). MCP support is built into Pi 0.99.0 and later; the separate MCP adapter is no longer included.
- `extensions/` — local extensions
- `prompts/` — local general-purpose prompt templates, including `/understand` and `/explore-understand` for manually controlled requirement alignment
- `skills/` — remote-managed skill caches; Herdr is refreshed from its upstream
  Git repository during installation
- `install.sh` — backup and install into `~/.pi/agent`

## Local extensions

- `questionnaire.ts` — Pi's official interactive multi-question tool example
- `notify.ts` — terminal notification after the full run settles (`agent_settled`)
- `herdr/` — owns the local Herdr integration checker, asynchronous `herdr_agent prompt` monitor, and `herdr-pi-reference` skill source; it keeps explicit `wait: false` calls non-blocking and injects session-scoped completion follow-ups
- `background-task/` — gives each session a scratchpad under `~/.pi/agent/scratchpad/<session-id>/` and adds the `background_task` tool, which runs long shell commands without blocking the agent and steers their exit code and log tail back into the session, plus the `monitor` tool, which delivers each stdout line of a watch script as an event; `/bg` lists or stops tasks and monitors ([details](extensions/background-task/README.md))
- `codex-statusline/` — automatically shows the current Codex account and weekly quota remaining in the TUI, and for the `openai` ChatGPT login its account, the matching Codex login's weekly quota, and a reached usage limit; sessions sharing an agent directory reuse a five-minute per-account/user quota cache ([details](extensions/codex-statusline/README.md))

## Pi compatibility

The local extensions target Pi 0.87.0. Every provider, including `openai-codex`, uses Pi's built-in compaction.

## Install

Review the repository before running the installer. Extensions execute with the same permissions as Pi.

```bash
git clone https://github.com/Hor1zonZzz/my-pi-config.git
cd my-pi-config
./install.sh
```

The installer creates a timestamped backup under `~/.pi/agent/backups/` before
replacing managed files. It preserves Pi's runtime `deviceId` for ChatGPT login and the locally chosen
default provider and model, which this repository does not set,
and leaves the credential vaults of the retired `/codex-accounts` extension untouched. It sets no model overrides and
never modifies the local `models.json`. It also refreshes the Herdr skill from upstream `master`, installs it
to `~/.pi/agent/skills/herdr/`, and installs the Herdr-owned `herdr-pi-reference`
skill to `~/.pi/agent/skills/herdr-pi-reference/`; an existing Herdr cache is
used when the remote is temporarily unavailable. When Pi starts inside Herdr,
the local integration checker warns if Herdr's Pi integration is missing or
outdated; it never installs or updates the Herdr-managed integration
automatically. During migration the installer also backs up and removes the
retired `extensions/plan-mode/`, `extensions/code-mode/`, `extensions/hairline/`,
`extensions/codex-fast-toggle/`, `extensions/codex-server-compaction/`, and
`extensions/codex-accounts/`, the former global `codex-fast.json` state file, and the retired external
`pi-openai-server-compaction` Git package checkout. It removes the former local
subagent extension with its installed agents (`planner`, `reviewer`, `scout`,
`worker`) and workflow prompts, and links `~/.pi/agent/bin/subagent` to the
`pi-subagent` package checkout so the `subagent` CLI is on Pi's bash `PATH`;
the link resolves once Pi has installed the package. Every install then runs
`pi update --extension` for Pi Voice, `pi-subagent`, and `pi-cliproxyapi-provider`,
which installs each one if it is missing and otherwise moves it to its newest
release; a failed update only prints a warning. `pi-subagent` needs tmux
and Node.js 22.19 or newer. Restart Pi or run:

```text
/reload
```

Package dependencies declared in `settings.json` are installed by Pi on startup. Authenticate separately; credentials are intentionally not included.

## Useful commands

```text
/understand [requirement]
/explore-understand [requirement]
```

`/subagent` (from `pi-subagent`) selects an active subagent and attaches to its tmux session.

`/understand` clarifies the requirement directly. `/explore-understand` explicitly begins with focused, read-only repository exploration. Both wait for confirmation before implementation.

## Security

This repository intentionally excludes credentials, sessions, MCP configuration,
trust decisions, caches, history, `node_modules`, and Herdr-managed integration
files. Never commit `~/.pi/agent/auth.json` or the raw local `models.json`.

## Attribution and licenses

Several extensions are adapted from Pi's official examples. Pi's license is included at `licenses/pi-LICENSE`.
