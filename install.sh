#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-${PI_AGENT_DIR:-$HOME/.pi/agent}}"
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
rm -f "$AGENT_DIR/extensions/question.ts"
node - "$ROOT_DIR/settings.json" "$AGENT_DIR/settings.json" <<'NODE'
const fs = require("node:fs");

const [, , sourcePath, targetPath] = process.argv;
const nextSettings = JSON.parse(fs.readFileSync(sourcePath, "utf8"));

try {
	const currentSettings = JSON.parse(fs.readFileSync(targetPath, "utf8"));
	if (typeof currentSettings.lastChangelogVersion === "string") {
		nextSettings.lastChangelogVersion = currentSettings.lastChangelogVersion;
	}
} catch (error) {
	if (error.code !== "ENOENT") throw error;
}

const temporaryPath = `${targetPath}.${process.pid}.tmp`;
fs.writeFileSync(temporaryPath, `${JSON.stringify(nextSettings, null, 2)}\n`, "utf8");
fs.renameSync(temporaryPath, targetPath);
NODE
cp "$ROOT_DIR/presets.json" "$AGENT_DIR/presets.json"
cp "$ROOT_DIR/codex-fast.json" "$AGENT_DIR/codex-fast.json"
cp -R "$ROOT_DIR/extensions/." "$AGENT_DIR/extensions/"
cp -R "$ROOT_DIR/agents/." "$AGENT_DIR/agents/"
cp -R "$ROOT_DIR/prompts/." "$AGENT_DIR/prompts/"

printf 'Installed Pi configuration into %s\n' "$AGENT_DIR"
printf 'Backup created at %s\n' "$BACKUP_DIR"
printf 'Restart Pi or run /reload to apply changes.\n'
