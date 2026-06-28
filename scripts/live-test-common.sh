#!/usr/bin/env bash
set -euo pipefail

AGENT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIVE_TEST_ENV_FILE="${LIVE_TEST_ENV_FILE:-$AGENT_ROOT/.env.live-test}"

if [[ -f "$LIVE_TEST_ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$LIVE_TEST_ENV_FILE"
  set +a
fi

export LIVE_TEST_PAGE_PORT="${LIVE_TEST_PAGE_PORT:-5198}"
export LIVE_TEST_STARTER_PORT="${LIVE_TEST_STARTER_PORT:-8080}"
export LIVE_TEST_SIGNALING_WS_URL="${LIVE_TEST_SIGNALING_WS_URL:-ws://127.0.0.1:${LIVE_TEST_STARTER_PORT}/ws}"
export LIVE_TEST_AGENT_BUNDLE_PATH="${LIVE_TEST_AGENT_BUNDLE_PATH:-$AGENT_ROOT/dist/agent.js}"
export LIVE_TEST_AGENT_ENTRY="${LIVE_TEST_AGENT_ENTRY:-examples/agent.ts}"
export LIVE_TEST_PAGE_PATH="${LIVE_TEST_PAGE_PATH:-/examples/live-test/index.html}"
export LIVE_TEST_SESSION_MODE="${LIVE_TEST_SESSION_MODE:-voice}"
