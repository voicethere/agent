#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/live-test-common.sh"

cd "$AGENT_ROOT"
npm run build

export LIVE_TEST_STARTER_PORT
export LIVE_TEST_SIGNALING_WS_URL
export LIVE_TEST_AGENT_BUNDLE_PATH
exec ./node_modules/.bin/tsx ./scripts/live-test-starter.ts
