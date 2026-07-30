# Repository Configuration

This document describes all branch protection settings for `main` and provides a restore script
in case the settings are accidentally deleted.

## Branch protection — `main`

| Setting | Value |
|---------|-------|
| Require a pull request before merging | ✅ |
| Required approving reviews | 1 |
| Dismiss stale reviews on new commit | No |
| Require status checks to pass | ✅ |
| Require branches to be up to date | ✅ (strict) |
| Require conversation resolution | ✅ |
| Enforce on administrators | ✅ |
| Allow force pushes | No |
| Allow deletions | No |

### Required status checks

These workflow jobs must pass before a PR can merge:

| Check | Workflow file | Job name |
|-------|--------------|----------|
| `CI / test` | `.github/workflows/ci.yml` | `test` |
| `CI / typecheck` | `.github/workflows/ci.yml` | `typecheck` |
| `CI / lint` | `.github/workflows/ci.yml` | `lint` |
| `CI / audit` | `.github/workflows/ci.yml` | `audit` |
| `API Integration Tests / api-integration` | `.github/workflows/api-integration.yml` | `api-integration` |
| `CodeQL / analyze` | `.github/workflows/codeql.yml` | `analyze` |
| `Vercel Preview / deploy` | `.github/workflows/preview-deploy.yml` | `deploy` |

## Restoring branch protection via `gh` CLI

The full protection payload is version-controlled at `.github/protection.json`. To restore:

```bash
gh api repos/vjuliaife/TariffShield/branches/main/protection \
  --method PUT \
  --input .github/protection.json
```

Verify the settings were applied:

```bash
gh api repos/vjuliaife/TariffShield/branches/main/protection
```

## Applying via GitHub UI

1. Go to **Settings → Branches → Add rule**
2. Branch name pattern: `main`
3. Enable **Require a pull request before merging** → set Approving reviews to **1**
4. Enable **Require status checks to pass before merging**
   - Search and add each check listed in the table above
   - Enable **Require branches to be up to date before merging**
5. Enable **Require conversation resolution before merging**
6. Enable **Do not allow bypassing the above settings**
7. Save changes

## Dependabot auto-merge

`.github/workflows/dependabot-automerge.yml` enables auto-merge on Dependabot PRs so patch bumps land without manual review. Branch protection still applies — auto-merge only completes once every required status check above passes.

| Setting | Value | Why |
|---------|-------|-----|
| Actor condition | `github.actor == 'dependabot[bot]'` | Only Dependabot PRs are eligible. |
| Update-type condition | `version-update:semver-patch` | Minor and major bumps stay manual. |
| `timeout-minutes` | `5` | The job only reads Dependabot metadata and makes one `gh pr merge --auto` call, so it normally finishes in seconds. The bound caps a stuck or hanging API call instead of letting the job occupy a runner until the 6-hour default limit. |

The timeout bounds the *workflow job*, not the merge itself: `gh pr merge --auto` queues the merge and returns, so a PR waiting on a slow required check is unaffected by this bound. Raise the value only if the job itself starts doing more work.
