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

### npm organization (required before first publish)

You do **not** pre-create `@voicethere/agent` in the npm UI — the **first** `npm publish --access public` creates the package.

You **do** need the **`voicethere`** scope on npm:

1. Sign in at [npmjs.com](https://www.npmjs.com) as an org admin.
2. Confirm the org exists: [npmjs.com/org/voicethere](https://www.npmjs.com/org/voicethere) (0 packages is fine).
3. **Members** → invite the npm user whose token will power CI (or use an org-owner account for the token).
4. That member needs permission to **publish** packages under `@voicethere` (Developer or Owner).

### npm access token

Create the token while logged in as a user who is a **member of the `voicethere` org**:

| Token type | Settings |
| ---------- | -------- |
| **Automation** (classic) | Recommended for CI — publish without 2FA prompt |
| **Granular** | Packages: **Publish**; select org **`voicethere`** (or all packages in org) |

### GitHub secret

Add repository secret **`NPM_TOKEN`** on [`voicethere/agent`](https://github.com/voicethere/agent) → **Settings → Secrets and variables → Actions → Repository secrets**.

| GitHub secret | Value |
| ------------- | ----- |
| **`NPM_TOKEN`** | The npm token (`npm_...`) from the org member above |

You do **not** add a separate `NODE_AUTH_TOKEN` secret — the workflow maps `NPM_TOKEN` → `NODE_AUTH_TOKEN` for `actions/setup-node`.

Verify locally (same token you put in GitHub):

```bash
export NPM_TOKEN=npm_...
npm whoami
cd agent
npm publish --access public --dry-run
```

Remove `--dry-run` only when you intend a manual publish.

### Publish errors

| Error | Cause | Fix |
| ----- | ----- | --- |
| `ENEEDAUTH` | No token / wrong secret name | Secret must be exactly **`NPM_TOKEN`**; workflow writes `~/.npmrc` |
| `404` on `PUT @voicethere/agent` | Token user is **not** in the `voicethere` npm org, or token lacks **Publish** for that org | Join user to org; recreate token as org member |
| `402` / restricted | Scoped package publish without public access | Workflow uses `npm publish --access public` (required for first scoped publish) |
| Verify step fails after successful publish | New scoped package: `npm view` lags behind version manifest | `wait-for-npm-package.sh` falls back to registry HTTP API; re-run failed jobs from **Verify** onward (do not re-publish same version) |

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
