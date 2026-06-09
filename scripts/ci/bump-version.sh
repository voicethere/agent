#!/usr/bin/env bash
# Set package.json version (release prep or post-release sync).
# Usage: bash scripts/ci/bump-version.sh <version>
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VERSION="${1:?usage: bump-version.sh <version>}"

cd "$ROOT"
npm version "$VERSION" --no-git-tag-version --allow-same-version
echo "==> package.json version set to ${VERSION}"
