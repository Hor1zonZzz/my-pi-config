# Codex Fast Toggle

Local Pi extension derived from `pi-openai-codex-fast` (MIT) with a persistent Fast On/Off control.

## Behavior

- Keeps Pi's built-in `openai-codex` provider and modifies only the outgoing request payload.
- Fast On sends Codex requests with `service_tier: "priority"`.
- Fast Off uses the default service tier.
- Provider and model identity always remain `openai-codex/<model>`.
- Global state is stored in `~/.pi/agent/codex-fast.json` and is shared by Pi processes and subagents.
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
