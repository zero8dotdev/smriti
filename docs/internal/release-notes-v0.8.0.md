# Smriti v0.8.0 — Cross-agent capture, finally

The headline: a long-running `smriti daemon` that captures your sessions across every coding agent in the background. Open Cursor, Codex, or Claude — the daemon watches the filesystem, debounces, and ingests automatically. You stop having to remember which agent you used yesterday, or whether you remembered to `smriti ingest`.

This is the release the postmortem [`docs/papers/stop-hook-never-stopped.md`](../papers/stop-hook-never-stopped.md) gestured at — the daemon shape the lockf mitigation pointed toward. It also reuses everything Smriti was already doing for Claude (the Stop hook continues to work, just as a 5ms socket poke now instead of a full ingest).

Before tagging, we dogfooded the whole pipeline: pointed Smriti at a year of our own sessions across all four agents and had a fleet of analysis agents mine what the developer actually learned. The result is the [Builder Retrospective: May 2025 → June 2026](https://zero8.dev/blog/builder-retrospective-may-2025-june-2026) — and the exercise itself found and fixed real bugs in every non-Claude connector, all included below.

## What you get

- **Cross-agent capture.** Sessions from Claude, Codex, Cline, Copilot, and Cursor are picked up automatically as they're written. No `smriti ingest <agent>` to remember.
- **Auto-start at login.** `smriti daemon install` writes a LaunchAgent on macOS or a systemd-user unit on Linux. Daemon comes back after every reboot; restarts itself on crash.
- **Per-project debouncing.** A busy session in project A doesn't delay project B. Each project gets its own 30s settle window.
- **Six new commands** (`smriti daemon install / uninstall / status / stop / logs`, plus the bare `smriti daemon` for foreground debugging).
- **`smriti share` continues to work** with its existing sanitization — unchanged.

## Recommended Claude Stop-hook update

When the daemon is running, the Stop hook becomes a 5ms poke. Update your `~/.claude/hooks/save-memory.sh` to:

```bash
#!/bin/bash
SOCK="$HOME/.cache/smriti/daemon.sock"
if [ -S "$SOCK" ]; then
  : | nc -U "$SOCK" 2>/dev/null
else
  /usr/bin/lockf -t 0 /tmp/smriti-ingest.lock smriti ingest claude 2>/dev/null
fi
exit 0
```

The `lockf` fallback keeps capture working if the daemon isn't running. No flag day; the old hook continues to work too.

## Quick start

```bash
smriti upgrade                       # pull the new code
smriti daemon install                # register the LaunchAgent / systemd unit
smriti daemon status                 # PID, uptime, watched agents
```

That's it. Open your agent of choice, work for a while, then `smriti search` for whatever you did. The session will be there.

## What's in the box

- 6 daemon modules (~1500 LOC of code, ~1200 LOC of tests)
- 57 daemon tests passing (full suite: 1174+ tests)
- 9 commits on `feat/daemon-core`, all individually testable
- 1 dedicated PRD (`docs/internal/daemon-prd.md`) documenting both the design and the three pre-impl smoke-test findings that shaped it

## Design discipline (the boring details that matter)

Three constraints came out of pre-impl smoke tests against Bun 1.3.6, and each one shaped a design decision that would have silently bitten us in production:

- **Single-instance enforcement uses a PID file + `kill(pid, 0)` liveness probe, not Unix-socket bind contention.** Bun's `net.createServer().listen(path)` silently succeeds on duplicate binds and steals connections from the original server. We use the PID-file pattern QMD already uses for `qmd mcp --daemon`.
- **FS watching uses native `fs.watch({ recursive: true })`, not chokidar.** Chokidar 5.0.0 under Bun fires zero events; native `fs.watch` works correctly on macOS (recursive native) and Linux (walk-and-watch).
- **DB connections are per-flush, not per-daemon-lifetime.** Repeatedly calling `ingest()` against a single long-lived SQLite handle inside one Bun process climbed to 6.8 GB peak RSS and segfaulted Bun. Opening a fresh connection per flush sidesteps this entirely; the ~30ms cost is invisible inside the 30s debounce window.

All three findings are documented in [`docs/internal/daemon-prd.md`](daemon-prd.md).

## Ingest correctness — found by dogfooding

Every non-Claude agent connector had silently drifted from the current on-disk formats. All "Sessions found: N, ingested: 0" failure modes, all fixed:

- **Codex** — modern rollouts wrap messages in `{type:"response_item", payload:{...}}` envelopes; the parser now unwraps them and filters injected context (AGENTS.md, environment blocks).
- **Copilot (VS Code)** — chatSessions moved to `.jsonl` with `{kind:0, v:{...}}` snapshot lines, and text moved to `message.text` / response `value` fields. Discovery and parsing updated.
- **Cursor** — the big one. Real chat history lives in `globalStorage/state.vscdb` (`composerData:` + `bubbleId:` keys), not project `.cursor/` dirs. New read-only SQLite discovery with composer→workspace project mapping; `smriti ingest cursor` now works with no flags. Recovered 482 sessions / 22k messages on the dev machine.
- **Backfill correctness** — `addMessage()` honors original message timestamps (history no longer collapses to ingest day); `--force` re-ingest deletes prior messages instead of appending duplicates; `SMRITI_INGEST_NO_ENRICH=1` skips per-session LLM query expansion during bulk backfills (482 queued local-LLM inferences previously pegged the CPU for 20+ minutes).

## Platforms

- ✅ macOS 14+ (Apple Silicon and Intel)
- ✅ Linux (systemd-user supported)
- ⏸️ Windows — deferred to a later release. Bun's Windows daemon support is rough and named-pipe semantics differ enough from Unix sockets that we want to ship them separately rather than half-build them now.

## Upgrading

If you're coming from v0.6.0 / v0.7.0:

1. `cd ~/.smriti && smriti upgrade` (or your equivalent — wherever your smriti install lives)
2. `smriti daemon install` if you want the daemon. Optional — if you skip this, Smriti continues to work exactly as it did before via the existing Claude Stop hook.

If you do install the daemon and later decide to roll back, `smriti daemon uninstall` removes the service file and stops the daemon. The PID file and IPC socket are cleaned up automatically. There is no other state to migrate.

## What's not in this release

A few things explicitly deferred to keep this release tight:

- **No real redaction pipeline.** `smriti share` still does the basic sanitization it always has. Real redaction comes in v0.8.1 / v0.9.0.
- **No read-side routing through the daemon.** `smriti search` and `smriti recall` are still one-shot CLI invocations. The daemon doesn't speed them up.
- **No auto-restart on `smriti upgrade`.** After upgrading, you'll want to `smriti daemon stop` followed by `launchctl kickstart -k gui/$UID/dev.zero8.smriti` (or `systemctl --user restart smriti` on Linux) so the daemon picks up the new code. v0.8.1 will teach `smriti upgrade` to do this automatically.

## Thanks

This release came out of a debugging session that found 42 stuck `smriti ingest` processes consuming 9 CPU-days. The lockf mitigation that stopped the pile-up is still in place as the fallback path; the daemon makes it usually-unnecessary. Both stories live in `docs/papers/`.

Refs: #71, #72, #73, #74, #75. PR #76.
