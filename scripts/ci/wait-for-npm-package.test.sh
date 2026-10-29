#!/usr/bin/env bash
# Tests for wait-for-npm-package.sh and npm-version-exists.sh with stubbed npm/curl.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"
FAILS=0

# npm stub: prints the version once the call counter reaches STUB_VISIBLE_AT (0 = never).
cat > "$TMP/bin/npm" <<'STUB'
#!/usr/bin/env bash
n=$(( $(cat "$STUB_COUNTER" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$STUB_COUNTER"
if [[ "${STUB_VISIBLE_AT:-0}" -gt 0 && "$n" -ge "$STUB_VISIBLE_AT" ]]; then
  echo "${STUB_VERSION:-1.2.3}"
fi
exit 0
STUB
# curl stub: always 404.
cat > "$TMP/bin/curl" <<'STUB'
#!/usr/bin/env bash
echo "$@" >> "$TMP_CURL_ARGS"
exit 22
STUB
# sleep stub: records the requested duration.
cat > "$TMP/bin/sleep" <<'STUB'
#!/usr/bin/env bash
echo "$1" >> "$STUB_SLEEPS"
exit 0
STUB
chmod +x "$TMP/bin/npm" "$TMP/bin/curl" "$TMP/bin/sleep"

run() { # name expected_exit expected_stderr_substring -- cmd...
  local name="$1" want="$2" substr="$3"
  shift 4
  : > "$TMP/counter"
  local out rc
  out="$(PATH="$TMP/bin:$PATH" STUB_COUNTER="$TMP/counter" "$@" 2>&1)"
  rc=$?
  if [[ "$rc" -ne "$want" ]] || { [[ -n "$substr" ]] && [[ "$out" != *"$substr"* ]]; }; then
    echo "FAIL: $name (exit $rc, want $want)"; echo "$out"; FAILS=$((FAILS + 1))
  else
    echo "ok: $name"
  fi
}

export TMP_CURL_ARGS="$TMP/curl-args"
export NPM_REGISTRY_VERIFY_SLEEP_SECONDS=0 NPM_REGISTRY_VERIFY_MAX_SLEEP_SECONDS=0

STUB_VISIBLE_AT=3 run "wait: visible on attempt 3" 0 "attempt 3" -- \
  bash "$HERE/wait-for-npm-package.sh" @x/pkg 1.2.3

# Backoff: sleeps grow 5 10 20 30 30 (first sleep 5, cap 30).
: > "$TMP/sleeps"
STUB_VISIBLE_AT=6 NPM_REGISTRY_VERIFY_SLEEP_SECONDS=5 NPM_REGISTRY_VERIFY_MAX_SLEEP_SECONDS=30 STUB_SLEEPS="$TMP/sleeps" \
  run "wait: backoff 5 10 20 30 30" 0 "attempt 6" -- bash "${WAIT_SCRIPT:-$HERE/wait-for-npm-package.sh}" @x/pkg 1.2.3
if [[ "$(tr '\n' ' ' < "$TMP/sleeps")" != "5 10 20 30 30 " ]]; then
  echo "FAIL: backoff sleeps were: $(tr '\n' ' ' < "$TMP/sleeps")"; FAILS=$((FAILS + 1))
fi

STUB_VISIBLE_AT=0 NPM_REGISTRY_VERIFY_TIMEOUT_SECONDS=1 run "wait: never visible" 1 "Not on npm registry" -- \
  bash "$HERE/wait-for-npm-package.sh" @x/pkg 1.2.3

STUB_VISIBLE_AT=1 run "exists: yes" 0 "" -- bash "$HERE/npm-version-exists.sh" @x/pkg 1.2.3
STUB_VISIBLE_AT=0 run "exists: no" 1 "" -- bash "$HERE/npm-version-exists.sh" @x/pkg 1.2.3

# curl gets the bare registry URL (no query parameter).
: > "$TMP/curl-args"
STUB_VISIBLE_AT=0 run "curl gets the bare registry URL" 1 "" -- bash "$HERE/npm-version-exists.sh" @x/pkg 1.2.3
if grep -q 'https://registry.npmjs.org/@x%2fpkg/1.2.3' "$TMP/curl-args" && ! grep -q '?' "$TMP/curl-args"; then
  echo "ok: curl args bare URL"
else
  echo "FAIL: curl args: $(cat "$TMP/curl-args")"; FAILS=$((FAILS + 1))
fi

# Guard: default window >= 15 min, and the verify job's timeout-minutes exceeds it.
default_s="$(sed -n 's/^TIMEOUT="${NPM_REGISTRY_VERIFY_TIMEOUT_SECONDS:-\([0-9]*\)}"$/\1/p' "$HERE/wait-for-npm-package.sh")"
job_min="$(awk '/^  verify-and-release:/{f=1} f&&/timeout-minutes:/{print $2; exit}' "$HERE/../../.github/workflows/release.yml")"
if [[ -n "$default_s" && "$default_s" -ge 900 && -n "$job_min" && $((job_min * 60)) -gt "$default_s" ]]; then
  echo "ok: default window ${default_s}s < verify job ${job_min} min"
else
  echo "FAIL: default window '${default_s}' / verify job timeout-minutes '${job_min}'"; FAILS=$((FAILS + 1))
fi

exit "$FAILS"
