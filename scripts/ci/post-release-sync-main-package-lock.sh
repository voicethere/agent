#!/usr/bin/env bash
# Align main package.json + package-lock.json after npm publish.
#
# Usage: bash scripts/ci/post-release-sync-main-package-lock.sh <version>
# Docs: scripts/RELEASE.md
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VERSION="${1:?usage: post-release-sync-main-package-lock.sh <version>}"

cd "$ROOT"

echo "==> Post-release sync on main @ ${VERSION}"
bash "$ROOT/scripts/ci/bump-version.sh" "$VERSION"
npm install

if git diff --quiet package.json package-lock.json 2>/dev/null; then
  echo "==> No package.json / lockfile changes — PR step will be skipped"
else
  echo "==> Changes:"
  git diff --stat package.json package-lock.json || true
fi
