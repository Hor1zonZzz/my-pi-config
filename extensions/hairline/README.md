# Hairline skin

English | [中文](README.zh-CN.md)

A quiet TUI skin for Pi: grey hairlines with one mint → sky accent. It replaces
the startup header, the editor rules, the footer, and the tool rows, and adds a
one-line speed HUD above the editor. It paints its own truecolor palette and is
designed for dark terminals such as Ghostty; without truecolor it falls back to
the nearest 256-color values.

```text
  ████████   pi 0.87.1                                       gpt-5.6-sol · medium
   ██  ██    ~/workspace/my-pi-config  main
  ▄█▀  ██▄   escape interrupt   / commands   ! bash   ctrl+o more

  ●  read  AGENTS.md:1-5                                           5 of 180 lines

  ⠼  bash  bash -n install.sh && git diff --check              running · 1.5s
     ╰ checking install.sh

  speed    ▁▁▁▁▁▁▁▁▁▁▁▁▂▅█▆  51 tok/s  ·  peak 63  ·  turn 3  ·  38s
─ ⠼ Thinking · 12s ───────────────────────────────────────────────────────────

─ gpt-5.6-sol · medium ───────────────────────── context ▰▰▰▰▱▱▱▱▱▱ 42% ─
  ~/workspace/my-pi-config  main       ↑12k ↓3.1k  ·  $0.000 sub  ·  <statuses>
```

User messages and assistant text are still rendered by Pi and keep the active
theme; extensions can restyle them only through a theme.

## What changes

| Area | Pi API | Result |
| --- | --- | --- |
| Header | `ctx.ui.setHeader()` | Three-row gradient π, version, model · thinking level, cwd and branch, key hints. |
| Editor | `CustomEditor` subclass | Only the top and bottom rules are restyled; there are no side borders or corners. The bottom rule shows model · thinking level and a context gauge. Rules turn mint in `!` bash mode. |
| Working status | `embedWorkingStatus` | The top rule shows `Thinking`, `Writing`, or `Running <tool>`, elapsed run time, and the run's tool-error count, with a light sweep across the label. Retry, compaction, and branch-summary indicators keep Pi's own wording. |
| HUD | `ctx.ui.setWidget()` above the editor | Speed of the last 16 assistant messages, the latest tok/s, the peak, the turn count, and run time. |
| Footer | `ctx.ui.setFooter()` | Cwd and branch, `↑input ↓output`, cost (`sub` for subscription models), and every other extension's status text. Statuses move to a second line when one line is too narrow. |
| Tool rows | re-registered `read`, `bash`, `edit`, `write` | One-line cards; `ctrl+o` shows Pi's own full output. |

## Commands

```text
/hairline            show the current state
/hairline on|off     switch the skin
/hairline hud on|off hide or show the speed line (a pure skin without the HUD)
```

The state lasts for the running Pi process. Restarting Pi or `/reload` turns the
skin and the HUD back on. After `/hairline off`, new tool rows use Pi's
renderers and existing rows change when they redraw; the tool overrides stay
registered until the extension is removed and Pi reloads.

## Speed

Speed is one assistant message's output tokens divided by the time from its
`message_start` to its `message_end`, so it includes time to first token.
Aborted, failed, and messages shorter than 0.25 s are skipped. Up to 64 values
are kept and the last 16 are drawn, scaled to the largest value in view. The
history starts empty for each session and after `/reload`; resumed messages
carry no timing.

## Tool rows

- **Execution is Pi's.** Each call runs the built-in definition for the call's
  cwd, created with the same settings Pi applies to its own tools:
  `images.autoResize` for `read`, `shellPath` and `shellCommandPrefix` for
  `bash`. Project settings are read only when `ctx.isProjectTrusted()` is true.
  Definitions are cached per cwd and trust state and dropped at session start,
  so a settings change applies after `/reload`, as with Pi's own tools.
- **The model sees no change.** Name, description, schema, prompt snippet,
  guidelines, constrained sampling, and argument preparation are copied from
  Pi's definitions; `tools.test.ts` compares them.
- **Collapsed rows** show a status mark, the tool, its argument (paths relative
  to cwd, read ranges as `file:120-159`, commands on one line), and a
  right-aligned summary: `N lines` or `N of M lines` for read, `+added −removed`
  with five squares for edit, written lines for write, and elapsed time or exit
  code with duration for bash. A running command shows its last output line; a
  failure shows the relevant error line.
- **Expanded rows** (`ctrl+o`) use Pi's own renderers with their own state, so
  syntax highlighting, diffs, and truncation notes are unchanged.
- Only the four tools Pi activates by default are overridden. `grep`, `find`,
  and `ls` are left alone because registering them would activate them on
  `/reload`. For the same reason, if you deactivate `read`, `bash`, `edit`, or
  `write`, `/reload` activates them again.

## Compatibility

Verified with Pi 0.87.1. Recheck these on Pi upgrades:

- `CustomEditor`'s protected `renderTopBorder()` and `Editor.renderBottomBorder()`
  hooks, `embedWorkingStatus`, and the indicator's `kind` and `renderInBorder()`,
  which are used through duck typing because the indicator type is not exported.
- The tool-renderer contract: `renderShell: "self"`, the shared `context.state`,
  and `lastComponent` reuse. Pi's bash renderer keeps a one-second refresh timer
  on its state while a command is partial and clears it on a final result; after
  a row collapses, Hairline passes that final result to it once.
- The options Pi's `AgentSession` passes to `createReadToolDefinition()` and
  `createBashToolDefinition()`. If Pi adds another settings-derived option, add
  it to `createBaseTool()` in `tools.ts`.
- `SettingsManager.create()` takes a file lock while reading, which is why tool
  definitions are cached instead of rebuilt for each call.

## Validation

Tests import Pi's host packages, so run them from a disposable copy whose
`node_modules/@earendil-works` points at the installed Pi packages (do not add
dependencies to this repository):

```sh
node --test hairline/*.test.ts
tsc -p tsconfig.json   # strict, NodeNext, allowImportingTsExtensions, noEmit
```

The tests cover width safety from 1 to 200 columns, the editor rules, working
status, footer wrapping, HUD speed tracking, one-line tool cards, the model-facing
tool contract, settings and project-trust handling for `bash`, the expanded and
disabled paths through Pi's renderers, and the bash refresh timer.

Interactive checks: start `pi --no-extensions -e ./extensions/hairline`, run a
prompt that uses `read` and `bash`, toggle `ctrl+o`, resize to a narrow width,
and try `/hairline hud off`, `/hairline off`, and `/hairline on`.
