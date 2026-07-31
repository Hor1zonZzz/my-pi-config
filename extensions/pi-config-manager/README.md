# Pi Config Manager

A unified resource-policy extension for Pi 0.83.0.

English | [中文文档](README.zh-CN.md)

Pi remains responsible for discovering, resolving, loading, deduplicating, and
assigning provenance to tools, skills, context files, extensions, and packages.
The manager consumes those public Pi inventories and controls only whether a
resource is enabled.

## Commands

```text
/config-manager  Open the unified overview
/tools           Open Tools
/skills          Open Skills
/contexts        Open Context Files
/extensions      Open Extensions
/sidebar         Alias for the overview
```

Tools, Skills, and Context toggles are current-session overrides and apply
immediately. Global defaults can be changed non-interactively:

```text
/tools global enable|disable <name>
/skills global enable|disable <name>
/contexts global enable|disable <absolute-path>
```

Extension changes are staged. Press `S` in the Extensions tab to save, confirm,
and reload Pi. The manager writes Pi's native settings filters through the
public `SettingsManager`; Pi decides what loads after reload. Pi cannot filter
a local package source that directly names one extension file, so the manager
reports that edge case instead of claiming to save an ineffective toggle.

## Context Monitor Demo

The manager opens as a centered overlay with a resource list on the left and a
bordered Context Monitor on the right. Moving through Tools, Skills, and
Contexts previews the selected resource's model-visible contribution:

- Tools show their description, parameter schema, active `promptSnippet`, and active prompt guidelines.
- Skills show their entry in Pi's system-prompt skill catalog.
- Contexts show their complete `project_context` system-prompt block.

Before an agent run, the monitor shows Pi's current system-prompt preview;
it has not passed through the forthcoming turn's `before_agent_start` handlers.
After an agent run, it shows the complete effective Pi system prompt captured at
`agent_start`. Both views highlight the selected active Skill, Context, or Tool
prompt snippet and prompt guidelines when they are present. An inactive Tool, disabled Skill, or disabled
Context instead keeps its individual description/preview visible, because it
should not appear in the system prompt. For inactive Tools, Pi does not expose
their `promptSnippet`; the monitor labels it unavailable while still showing any
published prompt guidelines as inactive metadata. The cached prompt is refreshed
by the next agent run, so policy changes made while the manager is open are not
reflected until then. Tool descriptions and schemas remain provider-payload data
rather than system-prompt text. Press `Right` to focus the monitor and `Left` to return to the resource list;
while the monitor is focused, `Up`/`Down` scroll it three rows at a time.

## Lifecycle

At `session_start`, the manager restores policy and shows a loading HUD. A
500ms settling refresh avoids publishing partial package-provided inventories.
`before_agent_start` and command contexts provide authoritative Skills and
Context snapshots. Every reconcile is idempotent, so later Pi-discovered
resources can be incorporated without a separate discovery implementation.

Policy precedence is:

```text
runtime constraint > session override > preset > project/global default > Pi default
```

Plan Mode contributes a runtime constraint layer instead of calling
`setActiveTools()` itself. Pi Config Manager is the only local extension that
writes the effective active tool set.

## Bundled Skill

`skills/preset-settings/SKILL.md` is installed as the global
`preset-settings` skill. In default mode it guides the agent to choose the
correct global, project, or source-controlled `presets.json`, preserve unrelated
profiles, validate model/tool/skill fields, and avoid treating a named
`default` preset as Pi's default mode.

Pi discovers the installed skill normally from `~/.pi/agent/skills`; Config
Manager does not implement a parallel skill scanner.

## State

Global defaults live in `~/.pi/agent/resource-settings.json`; trusted projects
may use `.pi/resource-settings.json`. Session overrides are stored as
`pi-config-manager-state` entries and follow session-tree branches.

The first run can import the disabled Skills list from the legacy
`skill-settings.json`. Disabled Skills and Context Files are removed when the
manager can locate Pi's standard prompt sections; a custom prompt that omits or
rewrites those sections is left unchanged with a warning. This is not a
file-access security boundary.
