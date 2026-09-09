# Codex Fast Toggle

Local Pi extension derived from `pi-openai-codex-fast` (MIT) with a session-scoped Fast On/Off control.

English | [中文文档](README.zh-CN.md)

## Behavior

- Keeps Pi's built-in `openai-codex` provider and modifies only the outgoing request payload.
- Fast On sends Codex requests with `service_tier: "priority"`.
- Fast Off uses the default service tier.
- Provider and model identity always remain `openai-codex/<model>`.
- Fast is Off by default in sessions without saved state.
- State is stored in the current Pi session. Resuming or reloading that session restores it, and tree navigation follows the active branch.
- Other Pi sessions, processes, and standalone subagents are not affected. Forks and clones inherit the state at the copied branch point, then diverge independently.
- `/fast` autocomplete is shown only while an `openai-codex` model is active.
- The status bar shows `⚡ fast` while Fast is enabled on a Codex model.

## Usage

```text
/fast
/fast on
/fast off
```

`/fast` opens the existing On/Off selector; cancellation leaves state unchanged.
The command uses Pi's official `registerCommand()` and argument completion API.
A small autocomplete filter hides the command and its arguments for non-Codex
models; manually invoking it there reports that it is unavailable. Invalid
arguments are handled locally rather than sent to the model. Command spelling
follows Pi's standard lowercase `/fast` dispatch.

With the repository's `codex-server-compaction` transport installed, ordinary
SSE/WebSocket requests, prewarm, and remote compaction derive
`x-codex-routing-hint` from the final request tier, like Codex CLI: On sends
`model=<model>;tier=priority`, Off sends `model=<model>` without `service_tier`
in the body. No second Fast flag or client identity change is needed. The Fast
extension alone remains a payload-only toggle.

Session-local persistence and provider-based availability remain intentional Pi
behavior; this does not import Codex CLI's global defaults or model-tier catalog.

## Attribution

The original fast-mode behavior was derived from `pi-openai-codex-fast` by Kaan Ozdokmeci / 2h2d-co under the MIT License. See `LICENSE` and `UPSTREAM-README.md`.
