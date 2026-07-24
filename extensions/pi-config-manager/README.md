# Pi Config Manager

A unified resource-policy extension for Pi 0.82.0.

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
public `SettingsManager`; Pi decides what loads after reload. Pi 0.82 cannot
filter a local package source that directly names one extension file, so the
manager reports that edge case instead of claiming to save an ineffective
toggle.

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

## State

Global defaults live in `~/.pi/agent/resource-settings.json`; trusted projects
may use `.pi/resource-settings.json`. Session overrides are stored as
`pi-config-manager-state` entries and follow session-tree branches.

The first run can import the disabled Skills list from the legacy
`skill-settings.json`. Disabled Skills and Context Files are removed from the
next system prompt, but this is not a file-access security boundary.
