#!/usr/bin/env bash
# Exit 0 if PKG@VERSION is already on the npm registry, else 1.
set -euo pipefail

PKG="${1:?package name required}"
VERSION="${2:?version required}"

published="$(npm view "${PKG}@${VERSION}" version --prefer-online 2>/dev/null || true)"
if [[ "$published" == "$VERSION" ]]; then
  exit 0
fi

# @scope/name -> @scope%2fname (npm registry convention)
encoded="${PKG/\//%2f}"
url="https://registry.npmjs.org/${encoded}/${VERSION}"
if curl -sf -H 'Cache-Control: no-cache' --connect-timeout 10 --max-time 30 "${url}?cb=$(date +%s)" -o /dev/null; then
  exit 0
fi
exit 1
