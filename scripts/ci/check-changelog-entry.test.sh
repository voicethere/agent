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

for v in 0.1.0 0.1.1 0.1.2 0.1.3 0.1.4 0.1.5 0.1.6 0.1.7 0.1.8 0.1.9 0.1.10 0.1.11 0.1.12 0.1.13 0.1.14 0.2.0 0.2.1 0.2.2 0.2.3 0.2.4 0.2.5 0.2.6 0.2.7 0.2.8 0.2.9 0.2.10 0.2.11 0.2.12 0.2.13 0.2.14 0.2.15 0.2.16 0.2.17 0.3.0 0.4.0 0.5.0 0.5.1 0.5.2 0.5.3 0.5.4 0.5.5 0.5.6 0.6.0 0.7.0 0.7.1 0.7.2 0.7.3 0.7.4 0.7.5 0.7.6 0.7.7 0.7.8 0.7.9 0.7.10 0.7.11 0.7.12 0.7.13 0.8.0 0.8.1 0.8.2 0.8.3 0.9.0 0.9.1 0.9.2 0.9.3 0.9.4 0.9.5 0.9.6 0.9.7 0.9.8 0.10.0 0.10.1 0.11.0 0.12.0 0.12.1 0.13.0 0.14.0 0.14.1 0.15.0 0.16.0 0.17.0 0.18.0 0.18.1 0.18.2 0.19.0 0.20.0; do
  run "real CHANGELOG.md has $v" 0 "" "$v" "$HERE/../../CHANGELOG.md"
done

exit "$FAILS"
