# Release flow

How a Smriti version goes from "code on a feature branch" to "tagged release that downstream users pick up via `smriti upgrade`." Written after the v0.8.0 work; intended to be reused for every future release.

## Versioning

Standard semver. The general rule: features bump minor (0.7.0 → 0.8.0), bug fixes and polish bump patch (0.8.0 → 0.8.1), and we will reach 1.0.0 once the daemon has been running on real teams for a month without anyone hitting a "this is broken in a load-bearing way" issue.

A note about local drift: `package.json` has occasionally lagged the git tag (v0.7.0 was tagged without a corresponding `"version"` bump). Try to keep them in sync; if they drift, fix it during the next release rather than rewriting history.

## The four phases

### Phase 1 — Feature branch development

All work for a release lives on one feature branch, named `feat/<headline-shape>` (e.g. `feat/daemon-core` for v0.8.0). One feature branch per release, even if the release contains several modules.

The branch accumulates commits as we go. We don't try to keep the branch always-rebased-to-main during development — that creates more friction than it solves for a solo developer. Instead we squash-or-merge when we're ready to ship.

Each commit on the branch should be independently testable: `bun test` passes after each commit. This makes bisecting later much cheaper.

### Phase 2 — Staging on real hardware

When the branch is feature-complete and unit-tested, we install it on real hardware and exercise it. There's no separate "build artifact" — the source IS the build, and switching to staging is `git checkout <feature-branch> && bun install`.

For the developer (running from `/Users/zero8/zero8.dev/smriti/`):
```bash
cd /Users/zero8/zero8.dev/smriti
git fetch origin
git checkout feat/<branch-name>
bun install --frozen-lockfile
bun test                          # sanity
```

For downstream users (running from `~/.smriti` as a git clone):
```bash
cd ~/.smriti
git fetch origin
git checkout feat/<branch-name>
bun install --frozen-lockfile
```

If the release adds a long-running process or service-file install, the staging step includes those too — e.g. for v0.8.0:
```bash
bun src/index.ts daemon install
bun src/index.ts daemon status     # verify it's running
```

To leave staging, `git checkout main && bun install --frozen-lockfile` (and remove any service-file installs).

### Phase 3 — Release-readiness checklist

Every release has a tracking issue with a checklist of real-hardware verifications. The checklist is release-specific (a daemon release tests reboot + soak; a search-quality release tests recall against a fixture set; etc.) but the shape is consistent:

- Per-OS verification rows that have to be done on actual machines
- Soak / endurance rows where time itself is the test
- Idempotency rows (running install twice, etc.) that catch state-corruption bugs
- A "previous CLI still works" row to catch regressions

When all rows are ✅, we tag. When a row fails, we fix it on the feature branch with a small commit and re-run the row — same branch, just more commits.

The tracking issue for v0.8.0 is #75. Future releases should clone its structure.

### Phase 4 — Promotion to release

```bash
# 1. Final sanity check
cd /Users/zero8/zero8.dev/smriti
git checkout feat/<branch-name>
bun test                                        # all green
bun src/index.ts <whatever-needs-spot-check>    # smoke-test the headline feature

# 2. Merge the PR
gh pr merge <PR-#> --squash --delete-branch    # squash if many commits and you don't need the history
                                                # --merge if you want the commit-by-commit story preserved

# 3. Tag
git checkout main && git pull
git tag -a v<x.y.z> -m "v<x.y.z> — <one-line headline>"
git push origin v<x.y.z>

# 4. GitHub release with notes
gh release create v<x.y.z> \
  --title "v<x.y.z> — <one-line headline>" \
  --notes-file docs/internal/release-notes-v<x.y.z>.md \
  --latest
```

The release notes file lives in the repo (`docs/internal/release-notes-v<x.y.z>.md`) as a draft from Phase 1, gets polished during Phase 3, and is the canonical source for the GitHub release body in Phase 4. After tagging, the file can stay in the repo as historical record — it's small and useful when someone asks "what landed in 0.8?"

### Optional Phase 5 — Daemon / long-running-process restart

For releases that ship changes to a long-running process (the daemon, future MCP server, etc.), users who upgrade need to restart that process to pick up the new code. Today this is manual:

```bash
smriti upgrade                                   # git pull + bun install
smriti daemon stop
launchctl kickstart -k gui/$UID/dev.zero8.smriti # macOS; KeepAlive=true will respawn it
# or: systemctl --user restart smriti           # Linux
```

A v0.8.1 polish release should teach `smriti upgrade` to detect a running daemon and restart it automatically. Tracked separately — not load-bearing for v0.8.0 itself.

## What lives where

| Artifact | Location | When updated |
|---|---|---|
| Release-tracking issue | GitHub issue (one per release) | Created at start of Phase 3; closed when tagged |
| Release notes | `docs/internal/release-notes-v<x.y.z>.md` | Drafted Phase 1, polished Phase 3, used in Phase 4 |
| Version | `package.json` `"version"` | Bumped in the same commit as the release notes finalisation |
| CHANGELOG | We don't maintain one. The set of GitHub Releases is the changelog. | — |
| Reference doc per major change | `docs/internal/*-prd.md` | Drafted alongside the feature; stays in the repo as historical record |
| Postmortems / reflections | `docs/papers/` | When something is worth telling as a story |

## What we deliberately don't do

- **No CI release pipeline.** Releases are small enough and rare enough that automating them past `gh release create` adds more failure modes than it removes. If we ever release multiple times a week, revisit.
- **No release candidates or beta channels.** Staging on the feature branch IS the RC. If a release needs longer soak time before tagging, just leave it in Phase 3 longer.
- **No release branches.** `main` is always the latest stable; feature branches are everything else. Branching off a tag for a hotfix is fine, but we don't keep a `release/0.8.x` branch alive after tagging.
- **No version-skipping for ceremony.** If v0.7.0 was tagged without a `package.json` bump, the next release just skips ahead in `package.json` — we don't go back and re-tag 0.7.1 to fix the drift.

## When something goes wrong post-release

If a release ships with a regression bad enough to revert:

1. `git revert <merge-commit>` on main (creates a clean revert commit)
2. Tag v<x.y.z+1> from the revert
3. Push tag, create release marked as a regression revert
4. Users on `smriti upgrade` pick up the revert via the normal flow

For less severe issues, a regular patch release (v<x.y.z+1> with the fix) is preferred over a revert.

## Source of truth for the current release

Always the GitHub release for the highest tag. If `package.json` disagrees with the tag, the tag wins. If a doc disagrees with the code, the code wins. We are explicit about this so future-us doesn't get confused by stale documentation that says we shipped something we didn't.
