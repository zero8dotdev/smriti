# Changelog

All notable changes to smriti are documented here. Format:
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/) · Versioning:
[SemVer](https://semver.org/)

---

## [Unreleased]

### Added

- GitHub Copilot chat ingestion (`smriti ingest copilot`) — VS Code on macOS,
  Linux, Windows
- Windows installer (`install.ps1`) and uninstaller (`uninstall.ps1`)
- GitHub Actions: `ci.yml`, `install-test.yml`, `release.yml`

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

[Unreleased]: https://github.com/zero8dotdev/smriti/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/zero8dotdev/smriti/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/zero8dotdev/smriti/releases/tag/v0.1.0
