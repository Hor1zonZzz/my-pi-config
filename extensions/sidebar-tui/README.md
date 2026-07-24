# Sidebar TUI

A read-only session resource monitor for Pi 0.82.0.

The extension keeps a persistent, read-only resource HUD in Pi's normal layout
above the editor, following Oh My Pi's Todo/Subagent HUD pattern. It registers
`/sidebar` for a searchable, tabbed detail view:

- all configured tools and their active/inactive state;
- skills loaded into Pi's base system-prompt resources, including the
  `skills-manager` active/inactive state;
- configured extensions, with runtime-observed extensions distinguished from
  extensions found by scanning enabled user/project locations;
- user and trusted-project subagent definitions, including whether the
  `subagent` tool is active;
- context files loaded into the current system prompt.

The HUD never captures input and does not cover the transcript. Run `/sidebar`
to open the detail view, then use Left/Right or Tab to change tabs, type to
search, use Up/Down to navigate, and press Escape to return to the editor.

## Accuracy boundaries

Pi exposes exact public APIs for tools, commands, skills, and context files, but
it does not expose a list of every loaded extension. The Extensions tab marks an
extension as `observed` when it registered a command or tool. Event-only
extensions are marked `configured` when found in auto-discovered extension
directories or explicit `settings.json` extension paths; that status cannot
prove that the extension loaded successfully.

Skills and context appear in the HUD after the first agent turn. Running
`/sidebar` refreshes them immediately through the command context API. When the
local `skills-manager` extension is loaded, the HUD displays skills as
`active/loaded` and refreshes after `/skills` or preset changes.
