# Codex Fast Toggle

Local Pi extension derived from `pi-openai-codex-fast` (MIT) with a persistent Fast On/Off control.

## Behavior

- Overrides the built-in `openai-codex` streaming handler without registering a second provider.
- Fast On sends Codex requests with `serviceTier: "priority"`.
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

The Codex streaming approach is derived from `pi-openai-codex-fast` by Kaan Ozdokmeci / 2h2d-co under the MIT License. See `LICENSE` and `UPSTREAM-README.md`.
