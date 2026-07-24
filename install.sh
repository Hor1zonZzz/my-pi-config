#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUBAGENT_DIR="$ROOT_DIR/extensions/subagent"
HERDR_SKILL_REPO="https://github.com/ogulcancelik/herdr.git"
HERDR_SKILL_REF="master"
HERDR_SKILL_CACHE_DIR="$ROOT_DIR/skills/herdr"
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

sync_herdr_skill() {
	local checkout_dir candidate downloaded="false"

	if command -v git >/dev/null 2>&1; then
		checkout_dir="$(mktemp -d "${TMPDIR:-/tmp}/pi-herdr-skill.XXXXXX")"
		if GIT_TERMINAL_PROMPT=0 git clone --depth 1 --single-branch --branch "$HERDR_SKILL_REF" "$HERDR_SKILL_REPO" "$checkout_dir/repo"; then
			candidate="$checkout_dir/repo/SKILL.md"
			if [[ -s "$candidate" ]]; then
				mkdir -p "$HERDR_SKILL_CACHE_DIR"
				cp "$candidate" "$HERDR_SKILL_CACHE_DIR/SKILL.md.tmp"
				mv "$HERDR_SKILL_CACHE_DIR/SKILL.md.tmp" "$HERDR_SKILL_CACHE_DIR/SKILL.md"
				downloaded="true"
			else
				printf 'Warning: Herdr repository did not contain a non-empty SKILL.md; using cache if available.\n' >&2
			fi
		else
			printf 'Warning: Could not update the Herdr skill; using cache if available.\n' >&2
		fi
		rm -rf "$checkout_dir"
	else
		printf 'Warning: git is unavailable; using cached Herdr skill if available.\n' >&2
	fi

	if [[ ! -s "$HERDR_SKILL_CACHE_DIR/SKILL.md" ]]; then
		printf 'Error: Herdr skill could not be downloaded and no cached SKILL.md exists.\n' >&2
		return 1
	fi

	if [[ "$downloaded" == "true" ]]; then
		printf 'Synchronized Herdr skill from %s@%s\n' "$HERDR_SKILL_REPO" "$HERDR_SKILL_REF"
	else
		printf 'Using cached Herdr skill from %s\n' "$HERDR_SKILL_CACHE_DIR/SKILL.md"
	fi
}

install_herdr_skill() {
	local staging_dir destination_dir
	destination_dir="$AGENT_DIR/skills/herdr"
	staging_dir="$(mktemp -d "$AGENT_DIR/skills/.herdr.XXXXXX")"
	cp "$HERDR_SKILL_CACHE_DIR/SKILL.md" "$staging_dir/SKILL.md"
	rm -rf "$destination_dir"
	mv "$staging_dir" "$destination_dir"
}

sync_herdr_skill

for path in settings.json presets.json resource-settings.json skill-settings.json models.json codex-fast.json extensions agents prompts skills; do
	backup_path "$path"
done

mkdir -p "$AGENT_DIR/extensions" "$AGENT_DIR/agents" "$AGENT_DIR/prompts" "$AGENT_DIR/skills"
rm -f "$AGENT_DIR/extensions/question.ts" "$AGENT_DIR/extensions/tools.ts"
rm -rf "$AGENT_DIR/extensions/skills-manager" "$AGENT_DIR/extensions/sidebar-tui"
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
node - "$ROOT_DIR/model-overrides.json" "$AGENT_DIR/models.json" <<'NODE'
const fs = require("node:fs");

const [, , sourcePath, targetPath] = process.argv;
const isRecord = (value) =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const managed = JSON.parse(fs.readFileSync(sourcePath, "utf8"));

if (!isRecord(managed.providers)) {
	throw new Error("model-overrides.json must contain a providers object");
}

let current = {};
try {
	current = JSON.parse(fs.readFileSync(targetPath, "utf8"));
} catch (error) {
	if (error.code !== "ENOENT") throw error;
}

if (!isRecord(current)) {
	throw new Error(`${targetPath} must contain a JSON object`);
}
if (current.providers !== undefined && !isRecord(current.providers)) {
	throw new Error(`${targetPath}.providers must be an object`);
}

const providers = { ...(current.providers ?? {}) };
for (const [providerName, managedProvider] of Object.entries(managed.providers)) {
	if (!isRecord(managedProvider?.modelOverrides)) {
		throw new Error(
			`model-overrides.json providers.${providerName}.modelOverrides must be an object`,
		);
	}

	const currentProvider = providers[providerName];
	if (currentProvider !== undefined && !isRecord(currentProvider)) {
		throw new Error(`${targetPath} provider ${providerName} must be an object`);
	}
	if (
		currentProvider?.modelOverrides !== undefined &&
		!isRecord(currentProvider.modelOverrides)
	) {
		throw new Error(
			`${targetPath} provider ${providerName}.modelOverrides must be an object`,
		);
	}

	providers[providerName] = {
		...currentProvider,
		modelOverrides: {
			...(currentProvider?.modelOverrides ?? {}),
			...managedProvider.modelOverrides,
		},
	};
}

const temporaryPath = `${targetPath}.${process.pid}.tmp`;
fs.writeFileSync(
	temporaryPath,
	`${JSON.stringify({ ...current, providers }, null, 2)}\n`,
	"utf8",
);
fs.renameSync(temporaryPath, targetPath);
NODE
cp "$ROOT_DIR/presets.json" "$AGENT_DIR/presets.json"
node - "$ROOT_DIR/resource-settings.json" "$AGENT_DIR/resource-settings.json" "$AGENT_DIR/skill-settings.json" <<'NODE'
const fs = require("node:fs");

const [, , sourcePath, targetPath, legacyPath] = process.argv;
if (!fs.existsSync(targetPath)) {
	const defaults = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
	try {
		const legacy = JSON.parse(fs.readFileSync(legacyPath, "utf8"));
		if (Array.isArray(legacy.disabledSkills)) {
			defaults.disabledSkills = [...new Set(
				legacy.disabledSkills.filter((name) => typeof name === "string"),
			)].sort();
		}
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	const temporaryPath = `${targetPath}.${process.pid}.tmp`;
	fs.writeFileSync(temporaryPath, `${JSON.stringify(defaults, null, 2)}\n`, "utf8");
	fs.renameSync(temporaryPath, targetPath);
}
NODE
cp "$ROOT_DIR/codex-fast.json" "$AGENT_DIR/codex-fast.json"
cp -R "$ROOT_DIR/extensions/." "$AGENT_DIR/extensions/"
cp -R "$SUBAGENT_DIR/agents/." "$AGENT_DIR/agents/"
cp -R "$SUBAGENT_DIR/prompts/." "$AGENT_DIR/prompts/"
install_herdr_skill

printf 'Installed Pi configuration into %s\n' "$AGENT_DIR"
printf 'Backup created at %s\n' "$BACKUP_DIR"
printf 'Restart Pi or run /reload to apply changes.\n'
