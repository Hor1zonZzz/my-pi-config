#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERDR_SKILL_REPO="https://github.com/ogulcancelik/herdr.git"
HERDR_SKILL_REF="master"
HERDR_SKILL_CACHE_DIR="$ROOT_DIR/skills/herdr"
HERDR_PI_REFERENCE_SKILL_DIR="$ROOT_DIR/extensions/herdr/skills/herdr-pi-reference"
# Pi checks out git: packages from settings.json under <agent-dir>/git/<host>/<path>.
SUBAGENT_CLI_TARGET="../git/github.com/badlogic/pi-subagent/subagent.ts"
AGENT_DIR="${PI_CODING_AGENT_DIR:-${PI_AGENT_DIR:-$HOME/.pi/agent}}"

if ! command -v node >/dev/null 2>&1; then
	printf 'Error: node is required to run install.sh.\n' >&2
	exit 1
fi

PLAN_FILE="$(mktemp "${TMPDIR:-/tmp}/pi-install-plan.XXXXXX")"
trap 'rm -f "$PLAN_FILE"' EXIT

node "$ROOT_DIR/install-cli.mjs" plan \
	--root "$ROOT_DIR" \
	--agent-dir "$AGENT_DIR" \
	--plan-out "$PLAN_FILE" \
	-- "$@"

PLAN_ACTION=""
PLAN_MODE=""
INSTALL_ITEMS=()
REMOVE_ITEMS=()
REMOVED_INSTALLED_ITEMS=()
UPDATE_PACKAGES=()

while IFS=$'\t' read -r kind value; do
	case "$kind" in
		action) PLAN_ACTION="$value" ;;
		mode) PLAN_MODE="$value" ;;
		install) INSTALL_ITEMS+=("$value") ;;
		remove) REMOVE_ITEMS+=("$value") ;;
		removing_installed) REMOVED_INSTALLED_ITEMS+=("$value") ;;
		update_pkg) UPDATE_PACKAGES+=("$value") ;;
	esac
done < <(node "$ROOT_DIR/install-cli.mjs" dump-plan --plan "$PLAN_FILE")

if [[ "$PLAN_ACTION" != "apply" ]]; then
	exit 0
fi

has_install_item() {
	local target="$1" item
	if [[ ${#INSTALL_ITEMS[@]} -eq 0 ]]; then
		return 1
	fi
	for item in "${INSTALL_ITEMS[@]}"; do
		if [[ "$item" == "$target" ]]; then
			return 0
		fi
	done
	return 1
}

backup_path() {
	local relative="$1"
	local source="$AGENT_DIR/$relative"
	if [[ -e "$source" || -L "$source" ]]; then
		mkdir -p "$BACKUP_DIR/$(dirname "$relative")"
		cp -RP "$source" "$BACKUP_DIR/$relative"
	fi
}

update_selected_packages() {
	local source
	if [[ ${#UPDATE_PACKAGES[@]} -eq 0 ]]; then
		return
	fi
	if ! command -v pi >/dev/null 2>&1; then
		printf 'Warning: pi not found; packages were not updated.\n' >&2
		return
	fi
	for source in "${UPDATE_PACKAGES[@]}"; do
		# pi update installs a missing package and moves an unpinned one to its newest release.
		if ! PI_CODING_AGENT_DIR="$AGENT_DIR" pi update --extension "$source" --no-approve; then
			printf 'Warning: could not update %s; keeping the installed version.\n' "$source" >&2
		fi
	done
}

sync_herdr_skill() {
	local checkout_dir candidate downloaded="false"

	if command -v git >/dev/null 2>&1; then
		checkout_dir="$(mktemp -d "${TMPDIR:-/tmp}/pi-herdr-skill.XXXXXX")"
		if GIT_TERMINAL_PROMPT=0 git clone --depth 1 --single-branch --branch "$HERDR_SKILL_REF" "$HERDR_SKILL_REPO" "$checkout_dir/repo"; then
			candidate="$checkout_dir/repo/skills/herdr/SKILL.md"
			if [[ ! -s "$candidate" ]]; then
				candidate="$checkout_dir/repo/SKILL.md"
			fi
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

install_herdr_pi_reference_skill() {
	local staging_dir destination_dir
	destination_dir="$AGENT_DIR/skills/herdr-pi-reference"
	staging_dir="$(mktemp -d "$AGENT_DIR/skills/.herdr-pi-reference.XXXXXX")"
	cp -R "$HERDR_PI_REFERENCE_SKILL_DIR/." "$staging_dir/"
	rm -rf "$destination_dir"
	mv "$staging_dir" "$destination_dir"
}

install_inline_chart_extension() {
	local src_dir="$ROOT_DIR/extensions/inline-chart"
	local dst_dir="$AGENT_DIR/extensions/inline-chart"
	local src_engine="$src_dir/engine"
	local dst_bin="$dst_dir/bin/inline-chart-engine"
	local entry

	rm -rf "$dst_dir"
	mkdir -p "$dst_dir"
	for entry in "$src_dir"/*; do
		[[ -e "$entry" ]] || continue
		local base
		base="$(basename "$entry")"
		if [[ "$base" == "engine" ]]; then
			mkdir -p "$dst_dir/engine"
			local eng_entry
			for eng_entry in "$src_engine"/*; do
				[[ -e "$eng_entry" ]] || continue
				local eng_base
				eng_base="$(basename "$eng_entry")"
				if [[ "$eng_base" == "target" ]]; then
					continue
				fi
				cp -R "$eng_entry" "$dst_dir/engine/$eng_base"
			done
		elif [[ "$base" == "bin" ]]; then
			continue
		else
			cp -R "$entry" "$dst_dir/$base"
		fi
	done

	if [[ -x "$src_dir/bin/inline-chart-engine" ]]; then
		mkdir -p "$dst_dir/bin"
		cp "$src_dir/bin/inline-chart-engine" "$dst_bin"
		chmod +x "$dst_bin"
		return
	fi
	if command -v cargo >/dev/null 2>&1 && [[ -f "$src_engine/Cargo.toml" ]]; then
		if (cd "$src_engine" && cargo build --release --quiet); then
			mkdir -p "$dst_dir/bin"
			cp "$src_engine/target/release/inline-chart-engine" "$dst_bin"
			chmod +x "$dst_bin"
			printf 'Built inline-chart-engine binary into %s\n' "$dst_bin"
		else
			printf 'Warning: cargo build failed for inline-chart-engine.\n' >&2
		fi
	fi
}

install_component() {
	local id="$1"
	case "$id" in
		background-task|btw|codex-statusline|esc-clear|memory)
			rm -rf "$AGENT_DIR/extensions/$id"
			cp -R "$ROOT_DIR/extensions/$id" "$AGENT_DIR/extensions/$id"
			;;
		herdr)
			rm -rf "$AGENT_DIR/extensions/herdr"
			cp -R "$ROOT_DIR/extensions/herdr" "$AGENT_DIR/extensions/herdr"
			install_herdr_skill
			install_herdr_pi_reference_skill
			;;
		inline-chart)
			rm -rf "$AGENT_DIR/extensions/mpl"
			install_inline_chart_extension
			;;
		notify|questionnaire|tps)
			cp "$ROOT_DIR/extensions/$id.ts" "$AGENT_DIR/extensions/$id.ts"
			;;
		pi-subagent)
			# The pi-subagent skill calls the `subagent` CLI; Pi puts <agent-dir>/bin on the bash PATH.
			ln -sfn "$SUBAGENT_CLI_TARGET" "$AGENT_DIR/bin/subagent"
			;;
		pi-annotate|pi-voice|pi-cliproxyapi-provider|pi-emphasis)
			# Managed via settings.json packages and update_selected_packages.
			;;
		understand|explore-understand)
			cp "$ROOT_DIR/prompts/$id.md" "$AGENT_DIR/prompts/$id.md"
			;;
		*)
			printf 'Error: unsupported component id: %s\n' "$id" >&2
			return 1
			;;
	esac
}

remove_component() {
	local id="$1"
	case "$id" in
		background-task|btw|codex-statusline|esc-clear|inline-chart|memory)
			rm -rf "$AGENT_DIR/extensions/$id"
			;;
		herdr)
			rm -rf "$AGENT_DIR/extensions/herdr" "$AGENT_DIR/skills/herdr" "$AGENT_DIR/skills/herdr-pi-reference"
			;;
		notify|questionnaire|tps)
			rm -f "$AGENT_DIR/extensions/$id.ts"
			;;
		pi-subagent)
			rm -f "$AGENT_DIR/bin/subagent"
			;;
		pi-annotate|pi-voice|pi-cliproxyapi-provider|pi-emphasis)
			# Removed from settings.json packages by apply-settings.
			;;
		understand|explore-understand)
			rm -f "$AGENT_DIR/prompts/$id.md"
			;;
		*)
			printf 'Error: unsupported component id: %s\n' "$id" >&2
			return 1
			;;
	esac
}

# Refresh Herdr skill cache before mutating the target directory when herdr is selected.
if has_install_item "herdr"; then
	sync_herdr_skill
fi

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$AGENT_DIR/backups/my-pi-config-$TIMESTAMP"
mkdir -p "$AGENT_DIR" "$BACKUP_DIR"

for path in settings.json subagent-settings.json codex-fast.json extensions agents prompts skills; do
	backup_path "$path"
done
backup_path "git/github.com/algal/pi-openai-server-compaction"
backup_path "bin/subagent"

mkdir -p "$AGENT_DIR/extensions" "$AGENT_DIR/prompts" "$AGENT_DIR/skills" "$AGENT_DIR/bin"

if [[ "$PLAN_MODE" == "sync" ]]; then
	# Clean up retired extensions, agents, prompts, and state files left by older versions.
	for name in planner reviewer scout worker; do
		rm -f "$AGENT_DIR/agents/$name.md"
	done
	for name in implement implement-and-review scout scout-and-plan; do
		rm -f "$AGENT_DIR/prompts/$name.md"
	done
	rm -f "$AGENT_DIR/extensions/question.ts" "$AGENT_DIR/extensions/preset.ts" "$AGENT_DIR/extensions/tools.ts" "$AGENT_DIR/extensions/herdr-integration-check.ts" "$AGENT_DIR/prompts/explore-and-gather.md" "$AGENT_DIR/subagent-settings.json" "$AGENT_DIR/codex-fast.json"
	rm -rf "$AGENT_DIR/extensions/mpl" "$AGENT_DIR/extensions/rex-chart" "$AGENT_DIR/extensions/skills-manager" "$AGENT_DIR/extensions/sidebar-tui" "$AGENT_DIR/extensions/pi-config-manager" "$AGENT_DIR/extensions/herdr-background-monitor" "$AGENT_DIR/extensions/subagent" "$AGENT_DIR/extensions/preset" "$AGENT_DIR/extensions/plan-mode" "$AGENT_DIR/extensions/code-mode" "$AGENT_DIR/extensions/hairline" "$AGENT_DIR/extensions/codex-fast-toggle" "$AGENT_DIR/extensions/codex-server-compaction" "$AGENT_DIR/extensions/codex-accounts" "$AGENT_DIR/skills/preset-settings" "$AGENT_DIR/git/github.com/algal/pi-openai-server-compaction"
fi

if [[ ${#REMOVE_ITEMS[@]} -gt 0 ]]; then
	for id in "${REMOVE_ITEMS[@]}"; do
		remove_component "$id"
	done
fi

node "$ROOT_DIR/install-cli.mjs" apply-settings \
	--root "$ROOT_DIR" \
	--agent-dir "$AGENT_DIR" \
	--plan "$PLAN_FILE"

if [[ ${#INSTALL_ITEMS[@]} -gt 0 ]]; then
	for id in "${INSTALL_ITEMS[@]}"; do
		install_component "$id"
	done
fi

update_selected_packages

printf 'Installed Pi configuration into %s (mode: %s)\n' "$AGENT_DIR" "$PLAN_MODE"
if [[ ${#INSTALL_ITEMS[@]} -gt 0 ]]; then
	printf 'Installed/updated (%d): %s\n' "${#INSTALL_ITEMS[@]}" "${INSTALL_ITEMS[*]}"
fi
if [[ ${#REMOVED_INSTALLED_ITEMS[@]} -gt 0 ]]; then
	printf 'Removed (%d): %s\n' "${#REMOVED_INSTALLED_ITEMS[@]}" "${REMOVED_INSTALLED_ITEMS[*]}"
fi
printf 'Backup created at %s\n' "$BACKUP_DIR"
printf 'Restart Pi or run /reload to apply changes.\n'
