#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$AGENT_DIR/backups/my-pi-config-$TIMESTAMP"

mkdir -p "$AGENT_DIR" "$BACKUP_DIR"

backup_path() {
  local relative="$1"
  local source="$AGENT_DIR/$relative"
  if [[ -e "$source" ]]; then
    mkdir -p "$BACKUP_DIR/$(dirname "$relative")"
    cp -R "$source" "$BACKUP_DIR/$relative"
  fi
}

for path in settings.json presets.json codex-fast.json extensions agents prompts; do
  backup_path "$path"
done

mkdir -p "$AGENT_DIR/extensions" "$AGENT_DIR/agents" "$AGENT_DIR/prompts"
cp "$ROOT_DIR/settings.json" "$AGENT_DIR/settings.json"
cp "$ROOT_DIR/presets.json" "$AGENT_DIR/presets.json"
cp "$ROOT_DIR/codex-fast.json" "$AGENT_DIR/codex-fast.json"
cp -R "$ROOT_DIR/extensions/." "$AGENT_DIR/extensions/"
cp -R "$ROOT_DIR/agents/." "$AGENT_DIR/agents/"
cp -R "$ROOT_DIR/prompts/." "$AGENT_DIR/prompts/"

printf 'Installed Pi configuration into %s\n' "$AGENT_DIR"
printf 'Backup created at %s\n' "$BACKUP_DIR"
printf 'Restart Pi or run /reload to apply changes.\n'
