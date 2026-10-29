#!/usr/bin/env bash
# Poll npm registry until pkg@version is visible after publish (eventual consistency).
#
# For brand-new scoped packages, the per-version manifest often appears before the
# package index that `npm view` queries, so we fall back to the registry HTTP API.
# Visibility has taken ~10 minutes (agent 0.18.2), so the default window is 15 minutes.
#
# Env:
#   NPM_REGISTRY_VERIFY_TIMEOUT_SECONDS    total window (default 900)
#   NPM_REGISTRY_VERIFY_SLEEP_SECONDS      first sleep (default 5), doubled each attempt
#   NPM_REGISTRY_VERIFY_MAX_SLEEP_SECONDS  sleep cap (default 30)
set -euo pipefail

PKG="${1:?package name required}"
VERSION="${2:?version required}"
TIMEOUT="${NPM_REGISTRY_VERIFY_TIMEOUT_SECONDS:-900}"
SLEEP_SECONDS="${NPM_REGISTRY_VERIFY_SLEEP_SECONDS:-5}"
MAX_SLEEP="${NPM_REGISTRY_VERIFY_MAX_SLEEP_SECONDS:-30}"

registry_version_url() {
  local pkg="$1"
  local version="$2"
  # @scope/name -> @scope%2fname (npm registry convention)
  local encoded="${pkg/\//%2f}"
  printf 'https://registry.npmjs.org/%s/%s' "$encoded" "$version"
}

registry_version_exists() {
  local url
  url="$(registry_version_url "$PKG" "$VERSION")"
  if curl -sf -H 'Cache-Control: no-cache' --connect-timeout 10 --max-time 30 "$url" -o /dev/null; then
    return 0
  fi
  return 1
}

start=$SECONDS
attempt=0
sleep_for="$SLEEP_SECONDS"
while true; do
  attempt=$((attempt + 1))
  elapsed=$((SECONDS - start))

  published="$(npm view "${PKG}@${VERSION}" version --prefer-online 2>/dev/null || true)"
  if [[ "$published" == "$VERSION" ]]; then
    echo "  verified ${PKG}@${VERSION} on registry via npm view (attempt ${attempt}, ${elapsed}s)"
    exit 0
  fi

  if registry_version_exists; then
    echo "  verified ${PKG}@${VERSION} on registry via HTTP API (attempt ${attempt}, ${elapsed}s)"
    exit 0
  fi

  elapsed=$((SECONDS - start))
  if (( elapsed >= TIMEOUT )); then
    break
  fi
  echo "  waiting for ${PKG}@${VERSION} on registry (attempt ${attempt}, ${elapsed}s of ${TIMEOUT}s)..."
  sleep "$sleep_for"
  sleep_for=$((sleep_for * 2))
  if (( sleep_for > MAX_SLEEP )); then sleep_for=$MAX_SLEEP; fi
done

echo "Not on npm registry after publish: ${PKG}@${VERSION} (after ${attempt} attempts, ${elapsed}s)" >&2
echo "  tried: npm view ${PKG}@${VERSION} version --prefer-online" >&2
echo "  tried: $(registry_version_url "$PKG" "$VERSION")" >&2
exit 1
