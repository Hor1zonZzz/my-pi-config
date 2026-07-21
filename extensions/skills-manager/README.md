# Skills Manager

`skills-manager` controls which discovered Pi skills are exposed to the model in each session.

## Commands

```text
/skills                              # TUI: edit the current-session override
/skills list                         # List each loaded skill's effective state
/skills enable <name>
/skills disable <name>
/skills reset                        # Remove the current-session override
/skills global                       # TUI: edit global defaults
/skills global list
/skills global enable <name>
/skills global disable <name>
```

The TUI selectors default to the `All` tab and provide `Enabled` and `Disabled`
tabs. Search always matches against every loaded skill before the current tab
filters the results. Press `↓` to move from search to the tabs, use `←`/`→` to
switch tabs, then press `↓` to enter the list; `↑` reverses those transitions.
Changing a skill updates its state immediately. The selected skill's canonical Pi
source scope and `SKILL.md` path appear below the list. `/skills list` includes
the same provenance for non-TUI use.

Source labels use Pi's resource metadata rather than path inference:

- `user` — a user-level skill
- `project` — a trusted project-level skill
- `temporary` — typically an explicit CLI or SDK skill
- `<scope>/package · <source>` — a skill supplied by an installed package

Non-TUI modes can use the explicit command variants.

## Precedence

The effective state is resolved in this order:

1. Current-session override
2. Active preset's `skills` allowlist
3. Global defaults in `~/.pi/agent/skill-settings.json`

Applying or clearing a preset resets the current-session override. Restoring a preset from an existing session preserves that branch's stored override. A preset without `skills` inherits the global defaults.

```json
{
  "focused-review": {
    "skills": ["pi-lens-lsp-navigation", "pi-lens-ast-grep"]
  }
}
```

Global defaults use a disabled list so newly discovered skills remain enabled by default:

```json
{
  "version": 1,
  "disabledSkills": ["browser-tools"]
}
```

## Scope of the gate

Disabled skills are removed from the system prompt's available-skill list, and `/skill:<name>` is blocked before Pi expands the skill's `SKILL.md` content.

This is a context-management feature, not a file-access security boundary: direct `read` calls to a known skill path remain allowed. Re-enable a skill before using `/skill:<name>`.
