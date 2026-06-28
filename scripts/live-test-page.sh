#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/live-test-common.sh"

cd "$AGENT_ROOT"
exec ./node_modules/.bin/http-server . -p "$LIVE_TEST_PAGE_PORT" -c-1 --silent
