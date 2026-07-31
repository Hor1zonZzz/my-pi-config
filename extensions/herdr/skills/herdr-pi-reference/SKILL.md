---
name: herdr-pi-reference
description: Reference for the models and thinking levels installed in this Pi configuration. Use when choosing a model for Herdr work.
---

# Local Pi Model Reference

Run `pi --list-models` to refresh this list. At the time this skill was written, this Mac has:

| Provider | Models |
| --- | --- |
| `deepseek` | `deepseek-v4-flash`, `deepseek-v4-pro` |
| `kimi-coding` | `k3`, `k3-256k`, `kimi-for-coding`, `kimi-for-coding-highspeed` |
| `openai-codex` | `gpt-5.3-codex-spark`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra` |

All listed models report thinking support.

Pi supports these thinking levels:

`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`

A model can hide or clamp individual levels. Use the model selector or `pi --list-models` as the current authority.
