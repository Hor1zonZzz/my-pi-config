#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEST_FILE="$SCRIPT_DIR/pi-config-manager.test.ts"

command -v bun >/dev/null || {
	echo "bun is required to run Config Manager tests" >&2
	exit 1
}
command -v pi >/dev/null || {
	echo "pi is required to provide the extension runtime dependencies" >&2
	exit 1
}

cd "$REPO_ROOT"
if [[ -e node_modules ]]; then
	bun test "$TEST_FILE"
	exit
fi

PI_REAL="$(realpath "$(command -v pi)")"
GLOBAL_NODE_MODULES="$(cd "$(dirname "$PI_REAL")/../../.." && pwd)"
ln -s "$GLOBAL_NODE_MODULES" node_modules
trap 'rm -f node_modules' EXIT
bun test "$TEST_FILE"
