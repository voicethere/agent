#!/usr/bin/env bash
# Usage: check-changelog-entry.sh <version>
# Exits 0 when CHANGELOG.md (or $CHANGELOG) has "## [<version>]" with at least one bullet
# before the next "## [" heading; exits 1 otherwise.
set -uo pipefail

VERSION="${1:?usage: check-changelog-entry.sh <version>}"
FILE="${CHANGELOG:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/CHANGELOG.md}"

if [[ -f "$FILE" ]] && awk -v v="$VERSION" '
  index($0, "## [" v "]") == 1 { rest = substr($0, length("## [" v "]") + 1); if (rest == "" || rest ~ /^ /) { inside = 1; next } }
  /^## \[/ { inside = 0 }
  inside && /^[[:space:]]*[-*][[:space:]]+[^[:space:]]/ { found = 1 }
  END { exit found ? 0 : 1 }
' "$FILE"; then
  exit 0
fi

echo "CHANGELOG.md has no entry for $VERSION; add \"## [$VERSION] - YYYY-MM-DD\" with at least one bullet before tagging release/$VERSION" >&2
exit 1
