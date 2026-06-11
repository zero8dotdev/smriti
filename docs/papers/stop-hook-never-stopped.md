# The Stop hook that never stopped

I asked Claude Code to grep `ps -ef` for something unrelated. The output came back with 42 lines of:

```
bun /Users/zero8/zero8.dev/smriti/src/index.ts ingest claude
```

Oldest had been running since Wednesday. It was Sunday.

Total CPU time across all 42: **13,449 minutes**. Nine CPU-days, burned silently in the background while I worked on other things.

## What was supposed to happen

Smriti is my cross-session memory layer for Claude Code. The mechanism is simple:

1. Claude Code finishes a turn.
2. A `Stop` hook fires.
3. The hook runs `smriti ingest claude`, which scans `~/.claude/projects/` for new session content and writes it into a local SQLite DB.

The hook looked like this:

```bash
#!/bin/bash
smriti ingest claude 2>/dev/null
exit 0
```

Async, 30-second timeout, fire-and-forget. Works fine if ingestion finishes inside one Claude turn.

## What actually happened

Ingestion does not finish inside one Claude turn — not when the DB has months of sessions, not when the embedding phase has to read every new chunk, not when SQLite contention is in play. A single run can take many minutes.

The hook fires after **every** response, in **every** session. I had several concurrent Claude Code sessions running. Each Stop fired another ingest. None of them held a lock. So:

- Turn ends → ingest A starts
- 30 seconds later, A is still scanning → next turn ends → ingest B starts on top of A
- B and A both grind on the same DB, contending on writes
- C joins. Then D. Then E.

Each new process slows down the ones already running, which makes them take even longer to finish, which gives more new ones a chance to spawn before any complete. The pile-up is self-reinforcing.

By the time I noticed, 42 processes were consuming roughly a full CPU core between them, fighting over the same SQLite file.

## The fix

macOS doesn't ship `flock`, but `/usr/bin/lockf` is right there and does the right thing:

```bash
#!/bin/bash
/usr/bin/lockf -t 0 /tmp/smriti-ingest.lock smriti ingest claude 2>/dev/null
exit 0
```

`-t 0` means: try to acquire the lock with a zero-second timeout. If something else already holds it, exit immediately (status 75) instead of waiting. The final `exit 0` swallows that status so Claude Code never sees a failure.

The behavioural change: at most one ingest is ever running. If a new Stop event fires while one is in flight, the hook no-ops in 8ms. The in-flight ingest is incremental — it tracks its position in `session-resolver.ts` state — so the next un-blocked Stop picks up everything that was missed.

Verifying:

```
$ /usr/bin/lockf -t 0 /tmp/lock sleep 5 &
$ /usr/bin/lockf -t 0 /tmp/lock echo "got it"
lockf: /tmp/lock: already locked
$ echo $?
75
```

`lockf` on macOS uses `fcntl()` advisory locks, which the kernel releases automatically when the holding process exits — crash, kill, normal exit, doesn't matter. No stale-lock cleanup needed.

## What I should have seen earlier

What bothers me is that the symptom — runaway processes — is loud, but the design flaw is quiet. The hook's comment said:

> Fires on Stop hook (after each Claude response).

That described **the trigger**, not **the contract**. The trigger fires unconditionally, but the operation behind it isn't unconditional-safe. Any hook that kicks off work longer than the interval between fires needs one of:

- Mutual exclusion (a lock).
- Debouncing (wait N seconds of quiet before starting).
- A queue (collapse pending fires into one).

Defaulting to none of the above is how you end up with 9 CPU-days of duplicate work and a laptop that's been quietly running hot for four days.

## The heuristic

If you write a background hook that calls into a process touching shared state — a database, a network, a file — assume two will run concurrently and decide what should happen. The answer is almost never "let them both proceed."

For one-at-a-time work, `lockf -t 0` on macOS / `flock -n` on Linux is six characters of insurance against an entire class of pile-ups.
