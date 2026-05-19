# Phase one: the Smriti daemon

## How we ended up here

Some weeks ago I noticed my laptop fan was loud. I ran `ps -ef`. There were forty-two `smriti ingest claude` processes running, the oldest from four days earlier. Collectively they had burned about nine CPU-days of work without anyone asking them to.

That's the story this PRD comes out of. The full postmortem is in `docs/papers/stop-hook-never-stopped.md`, and a reflective companion in `docs/papers/only-by-staying.md`. Short version: the Stop hook on Claude Code ran `smriti ingest claude` after every response, with no locking, and on a long-running development setup the ingests stacked up faster than they finished.

The first fix was six characters: `lockf -t 0`. It shipped within an hour and stopped the pile-up entirely. But it left an obvious next question — *why does the ingest take long enough for this to be a problem in the first place?* — and that question spiralled outward across an evening's design conversation into about four different daemon proposals, each more elaborate than the last.

This PRD is what's left after that conversation. It's deliberately less than what the conversation produced, because most of what the conversation produced was *correct* in the abstract but *misaligned* with what Smriti is actually for.

## What we thought the daemon was for

The first draft of this PRD (now deleted) tried to make the daemon solve four things simultaneously:

1. The hook pile-up problem (lockf already solved it; daemon would replace lockf).
2. Cold-start cost on every ingest (Bun runtime, SQLite open, eventually an in-process embedding model).
3. Routing `smriti search` and `smriti recall` through a warm socket for faster reads.
4. Coordinating with QMD's MCP daemon so the embedding model didn't load twice.

That was a daemon designed to be the centrepiece of Smriti — a long-running process that owned everything important. It was also, in retrospect, the wrong shape for the actual product.

Two arguments killed it. The first was about embedding: most of the cold-start cost lives in the embedding model (~2–5 seconds, ~300–500 MB), and that's not even an in-process concern today — QMD owns the embedding pipeline and runs it via `qmd embed` as a one-shot batch. The daemon would be "amortizing" a cost that didn't yet exist in our process.

The second was about the north star. Smriti is a memory layer for engineering teams. The thing that matters is not how fast my own hook runs; it's whether a teammate's past mistake reaches me before I make the same one. None of the four jobs above touched that.

What did matter was something I had under-valued: **capture across all the agents my team uses, not just Claude.** Today only Claude has hook-driven capture. Codex CLI, Cursor, Cline, Copilot — they all sit on disk, written to by their own log directories, and they only enter Smriti's index if I remember to run `smriti ingest <agent>` manually. That's the actual reliability gap. A teammate using Cursor produces sessions Smriti can't see, because no agent-specific hook tells Smriti about them.

A daemon that watches the filesystem and ingests as files arrive solves this. That's the daemon worth building. Not a faster hook; a universal one.

## What we're actually building

A long-running process called `smriti daemon`, started automatically at user login on macOS and Linux, whose job is to:

- Watch all configured agent log directories (`~/.claude/projects/`, `~/.codex/`, `~/.cline/tasks/`, the VS Code workspaceStorage path for Copilot, and any custom dirs the user adds).
- React to filesystem events by scheduling a per-project ingest after a 30-second debounce window.
- Run the existing ingest pipeline — parser → resolver → store gateway → orchestrator — for the project that just had activity. No new ingest code; the daemon is a trigger, not a re-implementation.
- Accept a poke from the Claude Stop hook (over a Unix socket) as an *additional* signal, not the only one. The Claude hook becomes a hint that wakes the watcher; the watcher itself is authoritative.

Everything else — `smriti search`, `smriti recall`, `smriti share`, `smriti embed` — keeps working exactly as it does today. The daemon writes into the same SQLite database that the CLI reads from. There is no read-side routing. There is no embedding-model handling. There is no backend transport, no auth, no dashboard.

The daemon is one process. It exists per user, per machine. It does one job: keep the local Smriti index continuously up-to-date with whatever agent the user happens to be using.

## What it looks like in daily use

A new user installs Smriti via `brew install` (or whichever shipping mechanism we settle on). The install also writes a `~/Library/LaunchAgents/dev.zero8.smriti.plist` on macOS, or a `~/.config/systemd/user/smriti.service` on Linux, and registers it. From that moment on, every time the user logs in, the daemon starts.

The user opens Cursor and works on a refactor for two hours. They never run a `smriti` command. The daemon is watching `~/Library/Application Support/Cursor/...` (or wherever Cursor writes its session logs); it sees files growing, waits 30 seconds for the writes to settle, then runs the Cursor ingest pipeline for that project. The session is in Smriti's index by the time the user types `smriti recall` for the first time that evening.

If the user is also on Claude Code, the Stop hook still fires after each turn — but instead of spawning a fresh `bun /Users/.../smriti/src/index.ts ingest claude` (the original sin of nine CPU-days), the hook is now:

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

A 5-millisecond socket poke when the daemon is running. The existing `lockf` fallback when it isn't. Either way, no pile-up is possible.

If the user kills the daemon (intentionally or by reboot before login completes), the next time they log in it comes back. If they don't want the daemon at all, they can `smriti daemon uninstall` and the LaunchAgent / systemd unit is removed.

## What survives, and what doesn't

A few specific failure modes worth being honest about, because they shape what the daemon promises:

**Crashes.** If the daemon crashes mid-ingest, the next filesystem event re-triggers the same project's ingest. The existing pipeline is incremental — `session-resolver.ts` tracks how many messages exist in the DB per session and only writes new ones. Duplicate-on-crash is safe.

**Reboot during agent work.** If the machine reboots while Claude is in the middle of writing a session, the daemon comes up at login and the watcher picks up the in-progress files on the next FS event. There's no in-flight state in the daemon worth preserving across reboots.

**Manual ingest still works.** `smriti ingest claude` from the CLI continues to do exactly what it does today. It's a perfectly valid fallback when the daemon isn't running, for users who don't want a daemon, or for testing. The daemon doesn't replace it; it just makes it usually-unnecessary.

**`smriti share` still works, unchanged.** The existing sanitization in `src/team/formatter.ts` continues to handle the basic cleanup. We are explicitly *not* adding a real redaction pipeline in this phase. That comes later, when transport to a backend is on the table.

**Cursor / Copilot capture is best-effort.** We don't control the formats these tools use; if they change layouts, the watcher might miss files until we update the discovery code. This is the same robustness story as today's manual ingest — the daemon doesn't make it worse, it just makes it more visible because there's nothing else to blame.

## What we're explicitly not building

Every item below came up in the design conversation, and every one of them is a separate phase. Enumerating them here so the boundary of phase one is clear:

- **No backend service, no transport, no auth.** The daemon writes to the local SQLite. Nothing leaves the machine in this phase. If you want team sharing, you still use `smriti share` exactly as today: commits curated knowledge to `.smriti/`, pushes via git.
- **No real redaction pipeline.** Sanitization stays at its current level. The day we add transport, redaction becomes the next phase's gating concern. Until then, the existing share behaviour is fine.
- **No read-side routing.** `smriti search` and `smriti recall` continue to be one-shot CLI invocations that open SQLite and run a query. They cold-start in ~150ms; that's not great, but it's not bad enough to justify the lifetime complexity of routing reads through a socket.
- **No coordination with QMD's MCP daemon.** The Smriti daemon doesn't know or care whether `qmd mcp --daemon` is running. They share the same SQLite file via WAL, which handles concurrent writers and readers correctly. If both daemons run at once, each opens its own SQLite handle; nothing breaks.
- **No QMD upstream proposal.** The `searchFTS({ joins })` idea is good and still on my list, but it's orthogonal to the daemon and shouldn't gate this work.
- **No Windows.** Bun on Windows is rough, named pipes have their own quirks, and we don't have a Windows user we care about. macOS and Linux only.
- **No raw-transcript-to-git pipeline (Entire-style).** That belongs to whatever the eventual team-sharing architecture is. Today's curated `smriti share` is sufficient.
- **No embedding model in the daemon.** The daemon does parse-and-write; embeddings are still computed by `qmd embed` (manual or scheduled). When vector staleness becomes the user-visible problem, we'll revisit.

The product of saying "no" to all of the above is that **phase one is implementable in roughly a week**, not a month. That matters more than getting any one of those right pre-emptively.

## How the code lays out

A new directory under `src/`:

```
src/daemon/
├── server.ts        // PID-file single-instance guard, IPC socket, signal handling
├── watcher.ts       // native fs.watch (macOS recursive); walk-and-watch fallback (Linux)
├── queue.ts         // per-project debounce + ingest dispatch
├── client.ts        // smriti daemon stop/status helpers
├── install.ts       // generate + register LaunchAgent / systemd unit
└── handlers.ts      // poke handler (Claude Stop hook)
```

### Three pre-impl smoke-test findings that shaped these choices

Each of these was verified before any production code was written, against Bun 1.3.6 on macOS. They each turned an instinct from the design conversation into a different choice in the implementation.

**Single-instance via PID file, not socket-bind.** The obvious first instinct was to bind a Unix socket and rely on `EADDRINUSE` to detect a second daemon. Under Bun this is silently broken: `net.createServer().listen(path)` succeeds on the second call and *steals* incoming connections from the first server with no error. The first server thinks it's still listening but receives nothing. The test was concrete — start two servers in one Bun process, send three connections, find s1 got 0 and s2 got 3.

So single-instance is enforced via QMD's pattern instead: a PID file at `~/.cache/smriti/daemon.pid` plus a `process.kill(pid, 0)` liveness probe on startup. The Unix socket continues to be used for IPC (the hook poke), but not as the guard. Startup order is: check PID file → exit if a live daemon owns it → write our PID → bind the IPC socket → start watching.

**Native `fs.watch`, not chokidar.** Initial instinct was to lean on `chokidar` for cross-platform watching. Test: chokidar 5.0.0 watching `~/.claude/projects/` under Bun, with two self-touched files inside the window. Events seen: zero. The watcher reaches `ready` but never fires. Replacing chokidar with Node's bare `fs.watch(root, { recursive: true })` produced four events on the same workload — including, satisfyingly, the live JSONL writes from the Claude session that was running the test.

So `src/daemon/watcher.ts` uses native `fs.watch` directly. macOS gets recursive watching for free; Linux needs a walk-and-watch fallback (Linux `fs.watch` doesn't implement `recursive`), which we'll hand-roll rather than pull in a watching library.

**Open the DB connection per ingest cycle, not per daemon lifetime.** The original instinct was that the daemon would open SQLite once at startup and reuse the connection across every ingest flush. The test for that — call `ingest()` five times in a single Bun process — exposed three problems. RSS climbed to 6.8 GB peak. The process retained roughly 20 extra file descriptors. And Bun itself panicked partway through with a segfault at `0xC9AB8`, repeatably.

Whatever lives downstream of `ingest()` is not safe to reuse across iterations under today's Bun + QMD versions. So the daemon does the boring thing: opens a fresh SQLite handle at the start of each per-project debounce flush, runs `ingest()`, closes the handle. The cost is ~20–50ms of cold-open time per cycle, which is invisible inside a 30-second debounce window. The benefit is that we sidestep the leak entirely. The real fix lives upstream (track down the FD/RSS accumulation in QMD's store layer, file the Bun crash with a minimal repro) but neither blocks shipping.

The existing ingest pipeline (`src/ingest/`) is reused as a library — the daemon imports the orchestrator from `src/ingest/index.ts` and runs it in-process. No subprocess spawning, no CLI invocation, no extra Bun cold start per fire.

New CLI subcommands:

- `smriti daemon` — run in foreground (debugging, systemd target)
- `smriti daemon install` — write the LaunchAgent / systemd unit file, register it, start it
- `smriti daemon uninstall` — reverse of install; daemon stops and the unit file is removed
- `smriti daemon status` — PID, uptime, pending queues, last ingest per project
- `smriti daemon stop` — graceful shutdown via socket; fallback to PID-file SIGTERM
- `smriti daemon logs` — tail the rotating log at `~/.cache/smriti/daemon.log`

The CLI keeps working without the daemon. None of the existing commands grow a daemon dependency.

## How we'll know it worked

The smallest set of criteria that distinguishes *shipped correctly* from *shipped but broken*:

1. After `smriti daemon install`, the daemon survives a logout/login cycle and a full reboot without user intervention.
2. Opening Cursor on a new project, doing some work, and *never running a smriti command* — that project's sessions appear in `smriti search` within `30s + ingest_time` of the work being saved.
3. Claude Code's Stop hook completes within 50 milliseconds when the daemon is running.
4. SIGKILLing the daemon leaves no stale socket, no stale PID file, no corrupt SQLite state. Re-running it works cleanly.
5. Running `smriti daemon install` twice produces idempotent results — same plist/service file, same registered job, no duplicates.
6. `smriti share` continues to work, unchanged, with its existing sanitization. No new redaction error paths.
7. Removing the daemon (`smriti daemon uninstall`) leaves the system in exactly the state it was before installation — no orphaned files, no lingering processes.

## What comes after

This is the first phase. The next is a real redaction pipeline — high-entropy detection, credentialed URI scrubbing, vendor secret patterns, typed placeholders — that re-shapes `smriti share` to handle raw transcripts safely alongside the curated knowledge it already produces. That work becomes load-bearing the moment Smriti starts handling transcripts at any kind of scale.

Beyond that, the trajectory tracks what users actually ask for: additional agent integrations, search quality improvements as QMD evolves, ergonomics around the team-sharing flow. Phase one alone produces a meaningfully better Smriti for anyone using more than one coding agent.

## Closing the loop

The daemon we're building is much smaller than the daemon we started designing. That's deliberate — most of what we initially put in it was solving for problems Smriti doesn't yet have, or problems that belong to other parts of the system. The version that ships is the version that does exactly one new thing well: capture across all my agents, automatically, so I never have to think about which one I used yesterday.

Everything else is on the runway, in order. Phase one first.
