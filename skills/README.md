# Managed skills

## Herdr

`install.sh` synchronizes `skills/herdr/SKILL.md` from
<https://github.com/ogulcancelik/herdr> on its `master` branch every time it
runs, then installs it to `~/.pi/agent/skills/herdr/SKILL.md` (or the directory
set by `PI_CODING_AGENT_DIR`).

The downloaded `SKILL.md` is an ignored cache, not a repository-maintained
copy. The remote version replaces local cache and installed copies when it is
available. If the remote is unavailable, the installer uses an existing cache;
a first installation without a cache fails.

The skill is third-party content that can instruct agents to run commands.
Review its upstream source and license before installing it.
