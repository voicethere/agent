#!/usr/bin/env bash
# Tests for check-changelog-entry.sh.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FAILS=0

cat > "$TMP/CHANGELOG.md" <<'MD'
# Changelog

## [Unreleased]

## [0.18.30] - 2026-11-01

### Fixed

- Something.

## [0.18.3] - 2026-10-30

### Changed

- A change.

## [0.18.4] - 2026-10-31

### Changed

## [0.18.5] - 2026-10-31

### Changed

- Last one.
MD

run() { # name expected_exit expected_output_substring version [changelog]
  local name="$1" want="$2" substr="$3" version="$4" file="${5:-$TMP/CHANGELOG.md}" out rc
  out="$(CHANGELOG="$file" bash "$HERE/check-changelog-entry.sh" "$version" 2>&1)"
  rc=$?
  if [[ "$rc" -ne "$want" ]] || { [[ -n "$substr" ]] && [[ "$out" != *"$substr"* ]]; }; then
    echo "FAIL: $name (exit $rc, want $want)"; echo "$out"; FAILS=$((FAILS + 1))
  else
    echo "ok: $name"
  fi
}

run "present with bullet" 0 "" 0.18.3
run "last section with bullet" 0 "" 0.18.5
run "missing" 1 'CHANGELOG.md has no entry for 0.19.0; add "## [0.19.0] - YYYY-MM-DD" with at least one bullet before tagging release/0.19.0' 0.19.0
run "heading present, empty section" 1 "no entry for 0.18.4" 0.18.4
run "prefix 0.18 does not match 0.18.3 or 0.18.30" 1 "no entry for 0.18" 0.18
printf '# Changelog\n\n## [0.18.30] - 2026-11-01\n\n### Fixed\n\n- Something.\n' > "$TMP/only-30.md"
run "0.18.3 does not match 0.18.30" 1 "no entry for 0.18.3" 0.18.3 "$TMP/only-30.md"
run "0.1803 does not match 0.18.3" 1 "no entry for 0.1803" 0.1803
run "dots are literal" 1 "no entry for 0x18x3" 0x18x3
run "missing file" 1 "no entry for 0.18.3" 0.18.3 "$TMP/nope.md"

TOP="$(sed -n 's/^## \[\([0-9][0-9.]*\)\].*/\1/p' "$HERE/../../CHANGELOG.md" | head -1)"
run "real CHANGELOG.md has its top version $TOP" 0 "" "$TOP" "$HERE/../../CHANGELOG.md"

exit "$FAILS"
