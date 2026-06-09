#!/usr/bin/env bash
# Poll npm registry until pkg@version is visible after publish (eventual consistency).
#
# For brand-new scoped packages, the per-version manifest often appears before the
# package index that `npm view` queries — we fall back to the registry HTTP API.
set -euo pipefail

PKG="${1:?package name required}"
VERSION="${2:?version required}"
MAX_ATTEMPTS="${NPM_REGISTRY_VERIFY_ATTEMPTS:-24}"
SLEEP_SECONDS="${NPM_REGISTRY_VERIFY_SLEEP_SECONDS:-5}"

registry_version_url() {
  local pkg="$1"
  local version="$2"
  # @scope/name → @scope%2fname (npm registry convention)
  local encoded="${pkg/\//%2f}"
  printf 'https://registry.npmjs.org/%s/%s' "$encoded" "$version"
}

registry_version_exists() {
  local url
  url="$(registry_version_url "$PKG" "$VERSION")"
  if curl -sf --connect-timeout 10 --max-time 30 "$url" -o /dev/null; then
    return 0
  fi
  return 1
}

for (( attempt = 1; attempt <= MAX_ATTEMPTS; attempt++ )); do
  published="$(npm view "${PKG}@${VERSION}" version 2>/dev/null || true)"
  if [[ "$published" == "$VERSION" ]]; then
    echo "  verified ${PKG}@${VERSION} on registry via npm view (attempt ${attempt}/${MAX_ATTEMPTS})"
    exit 0
  fi

  if registry_version_exists; then
    echo "  verified ${PKG}@${VERSION} on registry via HTTP API (attempt ${attempt}/${MAX_ATTEMPTS})"
    exit 0
  fi

  if [[ "$attempt" -lt "$MAX_ATTEMPTS" ]]; then
    echo "  waiting for ${PKG}@${VERSION} on registry (attempt ${attempt}/${MAX_ATTEMPTS})..."
    sleep "$SLEEP_SECONDS"
  fi
done

echo "Not on npm registry after publish: ${PKG}@${VERSION} (after ${MAX_ATTEMPTS} attempts)" >&2
echo "  tried: npm view ${PKG}@${VERSION} version" >&2
echo "  tried: $(registry_version_url "$PKG" "$VERSION")" >&2
exit 1
