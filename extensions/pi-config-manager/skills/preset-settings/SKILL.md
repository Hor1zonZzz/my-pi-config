---
name: preset-settings
description: Safely edit Pi preset profile configuration in presets.json. Use in default mode when the user asks to add, remove, rename, or change a preset's model, thinking level, tools, skills, or instructions.
---

# Pi Preset Settings

Use this workflow only for Pi preset profiles. It is intended for the unrestricted
`default` mode; if a restrictive preset is active and prevents the requested
work, ask the user to return to default mode through `/preset`.

## Choose the Configuration File

1. If the current repository manages Pi configuration and contains a root
   `presets.json`, treat that file as the source of truth. Do not primarily edit
   the installed copy under `~/.pi/agent`.
2. Otherwise edit the global file at
   `${PI_CODING_AGENT_DIR:-${PI_AGENT_DIR:-~/.pi/agent}}/presets.json`.
3. A trusted project may instead use `.pi/presets.json` when the user explicitly
   requests a project-local preset.
4. Read the existing file before editing and preserve unrelated profiles and
   unknown fields.

Do not create a profile named `default` merely to change default mode. In this
configuration, `default` means that no named preset is active. Ask for
clarification if the request concerns global defaults rather than a named
preset.

## Preset Shape

`presets.json` is an object keyed by preset name. Each value may contain:

```json
{
  "provider": "openai-codex",
  "model": "gpt-5.6-sol",
  "thinkingLevel": "medium",
  "tools": ["read", "bash", "edit", "write"],
  "skills": ["preset-settings"],
  "instructions": "Profile-specific system instructions."
}
```

Rules:

- Keep `provider` and `model` together. Verify available identifiers with
  `pi --list-models` before introducing a new model.
- Valid thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`,
  and `max`.
- `tools` is a replacement list. An explicit empty list disables all tools;
  omitting the field preserves the tool policy active when the preset is
  applied.
- `skills` is a model-visible allowlist for that preset. An explicit empty list
  hides all model-invocable skills; omitting the field uses Config Manager's
  normal global/project policy.
- `instructions` is appended to the system prompt while the preset is active.
  Keep it focused on behavior rather than duplicating the base system prompt.
- Use only discovered tool and skill names. Do not guess names or add filesystem
  paths to these arrays.
- Never place credentials, API keys, tokens, or machine-local authentication
  data in a preset.

## Coupled Configuration

When working in the source-controlled Pi configuration repository:

- Inspect `settings.json`, `model-overrides.json`, and
  `extensions/subagent/agents/*.md` before renaming or removing a model.
- Preserve the event contract between `extensions/preset.ts` and
  `extensions/pi-config-manager/`; editing a profile normally requires no
  TypeScript change.
- Do not run the installer or overwrite the live agent directory unless the
  user asks to install the repository changes.

## Validate

After editing:

```bash
node -e 'JSON.parse(require("node:fs").readFileSync("presets.json", "utf8"))'
git diff --check
```

For project-local or installed files, run the JSON parse against the actual
path. When changing model or resource choices, also smoke-test the relevant
extensions from the source repository:

```bash
pi --no-extensions \
  -e ./extensions/pi-config-manager \
  -e ./extensions/preset.ts \
  --list-models
```

Report the profile changed, validation performed, and whether the source change
was installed into the live Pi agent directory.
