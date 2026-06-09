# Release guide — `@voicethere/agent`

How to publish `@voicethere/agent` to npm — same **tag-driven** workflow as [`node-webrtc-rust`](https://github.com/akirilyuk/node-webrtc-rust/blob/main/scripts/RELEASE.md).

## Package published

| Package            | Description                                      |
| ------------------ | ------------------------------------------------ |
| `@voicethere/agent` | Customer agent SDK (IPC, `defineAgent`, types) |

## Branch vs tag naming

| Ref              | Pattern              | Example            | Purpose                          |
| ---------------- | -------------------- | ------------------ | -------------------------------- |
| **Prep branch**  | `release-prep/X.Y.Z` | `release-prep/0.1.0` | PR to `main` with version + CHANGELOG |
| **Publish tag**  | `release/X.Y.Z`      | `release/0.1.0`    | Triggers [`.github/workflows/release.yml`](../.github/workflows/release.yml) |

Push tags with an explicit ref:

```bash
git push origin refs/tags/release/0.1.0
```

## One-time setup

### npm organization

Create or use the **`voicethere`** npm org. Your user needs publish access to `@voicethere/agent`.

### GitHub secret

Add repository secret **`NPM_TOKEN`** (npm Automation or Publish token with org access) on [`voicethere/agent`](https://github.com/voicethere/agent).

```bash
export NPM_TOKEN=npm_...
npm whoami
```

## Version flow (git vs npm)

| Where | When | Committed to git? |
| ----- | ---- | ----------------- |
| **npm registry** | CI publish job on tag push | — |
| **`package.json` on `main`** | Release prep PR **before** tag | **Yes** |
| **`package-lock.json`** | Post-release PR after publish | **Yes** (automated) |

**Rule:** `package.json` version on `main` must match the tag **before** you push `release/X.Y.Z`.

## Release via GitHub Actions (recommended)

### 1. Release prep PR

On branch `release-prep/X.Y.Z`:

```bash
git checkout -b release-prep/0.1.0
# Finalize CHANGELOG.md — move [Unreleased] into [0.1.0]
bash scripts/ci/bump-version.sh 0.1.0
npm run test:ci && npm run verify:local
git add CHANGELOG.md package.json
git commit -m "chore(repo): release prep 0.1.0"
git push -u origin release-prep/0.1.0
# Open PR → main, merge when green
```

### 2. Tag on merged `main`

```bash
git checkout main && git pull
git tag release/0.1.0
git push origin refs/tags/release/0.1.0
```

### 3. CI pipeline (`release.yml`)

1. **quality** — `npm ci`, `test:ci`, `build`, `verify:local:only`
2. **publish** — set version from tag, `npm publish --access public`, verify registry
3. **GitHub Release** — notes from `CHANGELOG.md`
4. **sync-main-package-lock** — bot PR `chore/post-release-package-lock-X.Y.Z` → merge when green

### 4. After release

- [ ] Workflow green (including **Publish**)
- [ ] Merge post-release package-lock PR
- [ ] `npm view @voicethere/agent version` shows new version

## Changelog

Edit [`CHANGELOG.md`](../CHANGELOG.md) during development under `[Unreleased]`. Finalize the version section in the release prep PR.

Preview release notes:

```bash
bash scripts/changelog-release-body.sh 0.1.0
```

## Local publish (emergency only)

Prefer tag-driven CI. For a manual publish:

```bash
npm run test:ci && npm run verify:local
npm publish --access public
```

Requires `NPM_TOKEN` or `npm login` with publish rights.

## Scripts

| Script | Purpose |
| ------ | ------- |
| [`ci/bump-version.sh`](ci/bump-version.sh) | Set `package.json` version |
| [`ci/post-release-sync-main-package-lock.sh`](ci/post-release-sync-main-package-lock.sh) | Post-publish sync (same as CI bot) |
| [`ci/wait-for-npm-package.sh`](ci/wait-for-npm-package.sh) | Registry poll after publish |
| [`changelog-release-body.sh`](changelog-release-body.sh) | GitHub Release body from CHANGELOG |
