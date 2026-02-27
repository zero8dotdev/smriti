# Workflow Automation: Current State and North Star

Last updated: 2026-02-27

## Goals
- Keep `dev` as the stabilization branch.
- Automatically produce an **unreleased draft prerelease** from `dev` after tests pass.
- Promote `dev -> main` with standardized release PR metadata.
- Prevent bad releases by gating release on cross-platform tests and security checks.

## Current Workflow Map

### 1) CI (`.github/workflows/ci.yml`)
- Triggers:
  - `push` on `main`, `dev`, `feature/**`
  - `pull_request` on `main`, `dev`
- Jobs:
  - `test-pr`: PRs run fast Linux-only tests (`bun test test/`).
  - `test-merge`: pushes to `main`/`dev` run full matrix (`ubuntu`, `macos`, `windows`).
  - `dev-draft-release`: runs **only on push to `dev`**, after `test-merge` succeeds.
- Dev draft release behavior:
  - Creates tag `v<package.version>-dev.<github.run_number>`
  - Deletes previous draft prerelease/tag matching `-dev.*`
  - Creates new GitHub draft prerelease with generated notes.

### 2) Dev->Main PR Autofill (`.github/workflows/dev-main-pr-template.yml`)
- Trigger: `pull_request` events targeting `main`.
- Condition: applies only when `head=dev` and `base=main`.
- Actions:
  - Sets PR title to `release: v<version> (dev -> main)`
  - Fills PR body from `.github/PULL_REQUEST_TEMPLATE/dev-to-main.md`
  - Injects auto-generated commit list.

### 3) Perf Bench (`.github/workflows/perf-bench.yml`)
- Triggers on relevant code/path changes (PR and push).
- Runs QMD benchmark + repeat runs.
- Produces scorecard markdown.
- Publishes:
  - GitHub job summary
  - Sticky PR comment (updated in place)
  - Artifacts (`ci-small.json`, `repeat-summary.json`, `scorecard.md`)
- Non-blocking regression compare currently.

### 4) Release (`.github/workflows/release.yml`)
- Trigger: push tag matching `v*.*.*`
- Runs tests, generates changelog notes, creates GitHub Release.
- Final release is published when semver tag is pushed (e.g. `v0.4.0`).

### 5) Secret Scan (`.github/workflows/secret-scan.yml`)
- Runs on PR/push for `main`, `dev`, `feature/**`, `staging`.
- Uses `gitleaks` + `detect-secrets`.

### 6) Install Test (`.github/workflows/install-test.yml`)
- Runs on push to `main`, tags, or manual dispatch.
- Validates installer/uninstaller and smoke CLI checks on all three OSes.

### 7) Design Contracts (`.github/workflows/validate-design.yml`)
- Present but currently disabled (`if: ${{ false }}`) pending rule/code alignment.

## Current Release Flow (As Implemented)

1. Feature PR -> `dev`
2. Merge to `dev`
3. `CI` full matrix passes on `dev`
4. `CI` creates/updates draft prerelease tag `vX.Y.Z-dev.N`
5. Open PR `dev -> main` (autofilled title/body)
6. Merge `dev -> main`
7. Push final release tag `vX.Y.Z`
8. `Release` workflow publishes stable release

## What Is Automated vs Manual

Automated now:
- Dev draft prerelease creation/update after successful `dev` matrix tests.
- Dev->Main PR title/body normalization and commit summary.
- Bench reporting in PR summary/comment.

Manual now:
- Final semver tag push on `main` (`vX.Y.Z`).
- Deciding when `dev` is release-ready.

## North Star: Fully Autonomous and Safe Release

North star definition:
- Every merge to `dev` produces a validated draft candidate.
- Promotion from `dev` to `main` is policy-gated and reproducible.
- Stable release publication is automated only when all release gates are green.
- No single human step can bypass required quality/safety checks.

### Required Guardrails (Recommended)
1. Branch protection on `dev` and `main`
- Require status checks: `CI`, `Secret Scanning`, `Perf Bench`.
- Require up-to-date branch before merge.
- Disable direct pushes to `main`.

2. Re-enable Design Contracts as blocking
- Fix current validator false positives/real violations.
- Make workflow required before merge.

3. Make performance policy explicit
- Option A: keep non-blocking but require manual ack.
- Option B (north star): block on regression threshold for key metrics.

4. Automate final release from `main` merge/tag policy
- Add a controlled release gate job:
  - verifies `main` commit came from merged `dev -> main` PR
  - verifies all required checks passed on merge commit
  - creates semver tag automatically (or via manual approval environment)

5. Version governance
- Enforce version bump policy in `dev -> main` PR (e.g., `package.json` bump required).
- Validate tag/version consistency.

6. Release provenance
- Attach SBOM/attestations and immutable artifacts to release.
- Keep release notes generated from merged PRs + machine-readable manifest.

## Immediate Next Steps to Reach North Star

1. Re-enable `validate-design.yml` after fixing 7 reported violations.
2. Turn perf regressions into a protected check (with agreed threshold).
3. Add branch protection rules for `dev` and `main`.
4. Add `main-release-gate` workflow that auto-tags after `dev -> main` merge when all checks pass.
5. Add rollback playbook doc + hotfix workflow path.
