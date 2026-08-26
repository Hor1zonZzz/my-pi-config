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

The extension uses input interception rather than `registerCommand()` so slash completion can be hidden for non-Codex models.

## Attribution

The original fast-mode behavior was derived from `pi-openai-codex-fast` by Kaan Ozdokmeci / 2h2d-co under the MIT License. See `LICENSE` and `UPSTREAM-README.md`.
