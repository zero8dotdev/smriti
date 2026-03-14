## [0.6.0] - 2026-03-14

### 🎯 Release Overview
Promotes validated changes from `dev` to `main`. Significant release spanning multiple feature areas and infrastructure improvements across v0.3.0→v0.6.0.

### ✨ Major Features

#### Sidecar Content Search
- Make artifacts, thinking blocks, attachments, and voice notes searchable via unified FTS
- Extended `memory_fts` with new columns via `migrateFTSToV2()`
- Privacy-first design: thinking blocks opt-in only, others enabled by default
- Weighted BM25 scoring per content type
- New CLI flags: `--include-thinking`, `--no-artifacts`, `--no-attachments`, `--no-voice-notes`
- Applied to both search and recall commands

#### Cost Estimation & Analytics
- Model-aware cost estimation in database
- New `smriti insights` module with CLI commands for usage analytics
- Track costs per session

#### Ingest Force Mode
- `--force` flag to re-ingest already-processed sessions
- Allows session refresh without deduplication blocking

### 🔧 Infrastructure & Fixes

#### Database
- New tables: `smriti_artifacts`, `smriti_thinking`, `smriti_attachments`, `smriti_voice_notes`
- FTS migration to v2 includes sidecar content
- Initialize QMD store tables on database creation
- Fixed Windows `mkdir` edge case for current directory

#### Install & Path Resolution
- Fixed PATH issues in CI environments
- QMD submodule initialization improvements
- Graceful fallback to direct bun execution

#### CI/Release Pipeline
- Auto-generate CHANGELOG.md from merged PRs
- Added commit lint and semver validation
- Deterministic release notes generation
- Draft release creation in dev workflow
- Auto-release on main branch merges
- Improved workflow and check naming for PR readability
- Skip PR test job for dev-to-main release PRs

#### Core Features
- Add `--version` command handler
- Add missing cline and copilot to default agents seed

#### Performance
- Optimize Bun install with caching for faster CI workflows

### 📚 Documentation
- Overhauled documentation structure and improved narrative
- Updated CLAUDE.md with segmented sharing, benchmarks, and project structure
- CI/release workflow architecture documentation
- Release notes for v0.3.0→v0.6.0

### 📊 Release Progression
This v0.6.0 consolidates multiple point releases:
- **v0.3.0→v0.3.2**: Windows installer, Copilot ingestion, CI foundations, database initialization fixes
- **v0.4.0→v0.4.1**: Release workflow improvements, deterministic versioning, auto-release
- **v0.5.0→v0.5.1**: Share pipeline v2, cost estimation, docs overhaul, bug fixes
- **v0.6.0**: Sidecar search, ingest force mode, insights module, final infrastructure hardening

---

## [0.5.1] - 2026-03-09

### Fixed

- fix: add missing cline and copilot to default agents seed
- fix(install): remove temp HOME isolation breaking PATH dependencies

### Performance

- perf: add caching and optimize Bun install for faster CI workflows

---

## [0.5.0] - 2026-03-09

### Added

- feat(team): harden share pipeline — Ollama client, helper extraction, segmented sync
- feat(db): model-aware cost estimation and sidecar cleanup (#48)

### Fixed

- fix(share): harden 3-stage pipeline and add demo script

### Documentation

- docs: reorganize documentation structure and improve narrative (#46)
- docs: overhaul documentation structure and tone (#43)
- chore: clean up project root (#45)

---

## [0.4.0] - 2026-02-27

### Fixed

- fix: add missing cline and copilot to default agents seed ([#31](https://github.com/zero8dotdev/smriti/pull/31))

### Changed

- chore: e2e dev release flow smoke test ([#36](https://github.com/zero8dotdev/smriti/pull/36))

### Other

- release: v0.3.2 (dev -> main) ([#37](https://github.com/zero8dotdev/smriti/pull/37))
- release: v0.3.2 (dev -> main) ([#35](https://github.com/zero8dotdev/smriti/pull/35))
- Feature/bench scorecard ci windows fixes ([#34](https://github.com/zero8dotdev/smriti/pull/34))
- New branch ([#33](https://github.com/zero8dotdev/smriti/pull/33))


# Changelog

All notable changes to smriti are documented here. Format:
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/) · Versioning:
[SemVer](https://semver.org/)

---

## [Unreleased]

## [0.3.2] - 2026-02-27

### Fixed

- **Copilot/Cline FK constraint** — `smriti ingest copilot` and `smriti ingest cline`
  failed with `FOREIGN KEY constraint failed` on clean databases because `copilot` and
  `cline` were missing from the default agents seed data. (#30)

## [0.3.1] - 2026-02-25

### Fixed

- **Critical: QMD store table initialization** — Fresh database creation now properly
  initializes QMD's store tables (`content`, `documents`, `content_vectors`) and
  loads the sqlite-vec extension. Fixes "no such table: content_vectors" errors on
  first run in CI and fresh systems.
- **Database directory creation** — Ensure `~/.cache/qmd` parent directory exists
  before opening database file (fixes Windows mkdir edge case)
- **Install script PATH resolution** — Fixed PATH issues in CI environments
- **Claude Code submodule initialization** — Proper QMD submodule checkout
- **Graceful ingest failure handling** — Workflows no longer fail when no sessions exist

### Added

- `--version` command handler

---

### 📖 The Monitoring Loop: A CI Debugging Story

**The Problem (2026-02-25, 20:32 IST):**
Fresh CI runners were crashing with cryptic database errors. The PR was green locally
but red everywhere else. We needed fast feedback on each fix attempt.

**The Solution: A Bash Monitoring Loop**

We built a real-time GitHub Actions watcher:

```bash
for i in {1..60}; do
  echo "[$i/60] Checking status..."
  gh run view 22402879433 --log 2>&1 | grep -i "error"

  if [[ failure ]]; then
    echo "❌ Found error, let's fix it"
    break
  fi

  sleep 10
done
```

**The Cycle (Compressed Timeline — IST):**

1. **20:32** — PR merged, Install Test triggered
2. **20:40** — Monitor script: "Error: unable to open database file" ❌
   - Fix: Add `mkdirSync()` to create `~/.cache/qmd`
   - Commit & push
3. **20:42** — New run starts, monitor script watching...
4. **20:43** — Monitor script: "Error: no such table: content_vectors" ❌
   - Root cause hunt: "What tables exist? Why not content_vectors?"
   - Discovery: QMD's `initializeDatabase()` was never called
   - Fix: Add `initializeQmdStore()` with all required tables
   - Commit & push
5. **20:50** — Another run, monitor script: "Error: ENOENT...ingest claude" ❌
   - Root cause: Workflow has `continue-on-error: false` on optional step
   - Fix: Change to `continue-on-error: true`
   - Commit & push
6. **21:07** — **MONITOR SHOWS: ✅ ALL PLATFORMS PASS** 🎉
   - Ubuntu: ✅ (20 seconds)
   - macOS: ✅ (21 seconds)
   - Windows: ✅ (82 seconds)

**Why This Worked:**

- **Immediate feedback:** No waiting for Slack or email. See the error within 10 seconds
  of the run starting.
- **Pattern recognition:** "unable to open database file" → directory issue, while
  "no such table" → initialization order issue. Two different root causes hidden in
  one PR.
- **Tight loop:** Fix locally → test locally → push → watch CI → see result → next
  iteration. Average cycle time: ~5 minutes per fix.
- **No guessing:** Read actual error messages from actual CI runners, not trying to
  reproduce in local dev environment.

**The Key Insight:**

The monitoring script transformed debugging from "wait for CI to finish, read logs
later" to "watch it fail in real-time, understand why immediately, fix in next
iteration." By 21:07 IST, three separate bugs were identified and fixed in under
40 minutes.

**Lessons Learned:**

1. **Real-time monitoring beats batch feedback** — The 10-second polling loop is more
   valuable than waiting for the run to complete
2. **GitHub CLI is your friend** — `gh run view` + `--log` gives instant access to
   runner output without leaving the terminal
3. **Multiple platforms expose different bugs** — Windows mkdir edge case wasn't
   obvious until we saw it fail. The monitoring loop caught it immediately.
4. **The loop is the feature** — Not the individual fixes, but the ability to iterate
   rapidly on live CI feedback.

**Final Stats:**
- Iterations: 3
- Total time: ~40 minutes
- Bugs fixed: 3 (mkdir, table init, workflow config)
- Platforms now passing: 3/3 ✅

---

## [0.3.0] - 2026-02-24

### Added

- GitHub Copilot chat ingestion (`smriti ingest copilot`) — VS Code on macOS,
  Linux, Windows
- Windows installer (`install.ps1`) and uninstaller (`uninstall.ps1`)
- GitHub Actions: `ci.yml`, `install-test.yml`, `release.yml`
- `smriti upgrade` command support
- Cross-platform path resolution fixes for Windows (rules and templates)

---

## [0.2.0] - 2026-02-24

### Added

- **Cline ingestion** — parser for Cline CLI tasks (`~/.cline/tasks/`)
- **Structured block extraction** — tool calls, file ops, commands, errors, git
  ops in sidecar tables
- **Category tree** — 7 top-level / 21 subcategory hierarchy with hierarchical
  filtering on all commands
- **Auto-categorisation** — rule-based classifier + optional Ollama LLM fallback
  (`smriti categorize`)
- **Manual tagging** — `smriti tag <session-id> <category>`
- **Custom categories** — `smriti categories add <id> --name <name>`
- **`smriti context`** — compact project summary injected into
  `.smriti/CLAUDE.md`
- **`smriti compare`** — A/B token comparison between sessions (`--last` for two
  most recent)
- **`smriti team`** — view team contribution breakdown
- **LLM reflection** — Ollama-powered session summaries during `smriti share`
  (skip with `--no-reflect`)
- **Sanitisation pipeline** — strips XML noise, interrupt markers, narration
  filler before sharing

### Changed

- Category metadata survives the `share` → `sync` roundtrip exactly via YAML
  frontmatter

---

## [0.1.0] - 2026-02-10

### Added

- Initial release
- Claude Code, Codex CLI, and Cursor IDE ingestion
- Hybrid search: BM25 full-text + vector semantic recall
- `smriti recall` with optional Ollama synthesis (`--synthesize`)
- `smriti list`, `smriti show`, `smriti status`, `smriti projects`,
  `smriti embed`
- Team sharing via git: `smriti share` / `smriti sync`
- Local SQLite store — no cloud, no accounts
- Content-addressable deduplication (SHA256)
- Auto-save hook for Claude Code sessions
- One-command install (`install.sh`) and uninstall (`uninstall.sh`)

[Unreleased]: https://github.com/zero8dotdev/smriti/compare/v0.3.2...HEAD
[0.3.2]: https://github.com/zero8dotdev/smriti/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/zero8dotdev/smriti/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/zero8dotdev/smriti/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/zero8dotdev/smriti/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/zero8dotdev/smriti/releases/tag/v0.1.0
