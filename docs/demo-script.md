# Smriti Demo: From Deep Dive to Team Knowledge

## The Problem

Priya is a senior engineer at a startup. She just spent 2 hours in a Claude
Code session doing a deep review of their payment service — a critical codebase
she inherited when the original author left.

During the session, she and Claude:

- Traced a race condition in the webhook handler that causes duplicate charges
- Discovered the retry logic uses `setTimeout` instead of exponential backoff
- Decided to replace the hand-rolled queue with BullMQ
- Found that the Stripe SDK is 3 major versions behind and the API they use is deprecated
- Mapped out the full payment flow across 14 files
- Identified 3 missing error boundaries that silently swallow failures

That's a **goldmine** of institutional knowledge. But the Claude session is
just a 400-message transcript buried in `~/.claude/projects/`. Tomorrow, when
her teammate Arjun picks up the webhook fix, he'll start from scratch. When the
intern asks "why BullMQ?", nobody will remember the tradeoff analysis.

**This is the problem Smriti solves.**

---

## Act 1: The Session Ends

Priya's Claude Code session just finished. Here's what her terminal looks like:

```
$ # Session over. 2 hours of deep review — bugs, decisions, architecture notes.
$ # All sitting in a Claude transcript she'll never look at again.
```

She has two paths to preserve this knowledge:

| Path | Command | What it does |
|------|---------|--------------|
| **Ingest** | `smriti ingest claude` | Import into searchable memory (personal) |
| **Share** | `smriti share --segmented` | Export as team documentation (git-committed) |

She'll do both.

---

## Act 2: Ingest — Building Personal Memory

```
$ smriti ingest claude --project payments
```

```
  Discovering sessions...
  Found 1 new session in payments

Agent: claude-code
Sessions found: 1
Sessions ingested: 1
Messages ingested: 412
Skipped: 0
```

That's it. 412 messages are now indexed — full-text searchable with BM25,
ready for vector embedding, tagged with project and agent metadata.

**What just happened under the hood:**

1. Smriti found the JSONL transcript in `~/.claude/projects/-Users-priya-src-payments/`
2. Parsed every message, tool call, file edit, and error
3. Stored messages in QMD's content-addressable store (SHA256 dedup)
4. Registered the session with project = `payments`, agent = `claude-code`
5. Auto-indexed into FTS5 for instant search

Now Priya can search her memory:

```
$ smriti search "race condition webhook" --project payments
```

```
[0.891] Payment Service Deep Review
  assistant: The race condition occurs in src/webhooks/stripe.ts at line 47.
  The handler processes the event, then checks idempotency — but between
  those two operations, a duplicate webhook can slip through...

[0.823] Payment Service Deep Review
  user: What's the fix? Can we just add a mutex?

[0.756] Payment Service Deep Review
  assistant: A mutex won't work in a multi-instance deployment. The proper
  fix is to check idempotency BEFORE processing, using a database-level
  unique constraint on the event ID...
```

Three weeks later, she barely remembers the session. But she can recall it:

```
$ smriti recall "why did we decide on BullMQ for payments" --synthesize
```

```
[0.834] Payment Service Deep Review
  assistant: After comparing the options, BullMQ is the clear winner...

--- Synthesis ---

The decision to adopt BullMQ for the payment queue was made during a deep
review of the payment service. The existing implementation used a hand-rolled
queue with setTimeout-based retries, which had several issues:

1. No exponential backoff — failed jobs retry immediately, hammering Stripe
2. No dead-letter queue — permanently failed jobs disappear silently
3. No persistence — server restart loses the entire queue
4. No visibility — no way to inspect pending/failed jobs

BullMQ was chosen over alternatives:
- **pg-boss**: Good, but adds Postgres load to an already-strained DB
- **Custom Redis queue**: Reinventing the wheel; BullMQ is battle-tested
- **SQS/Cloud queue**: Adds AWS dependency the team wants to avoid

BullMQ provides exponential backoff, dead-letter queues, Redis persistence,
and a dashboard (Bull Board) — solving all four issues.
```

That synthesis didn't come from a new LLM call about BullMQ. It came from
**Priya's actual reasoning during the review**, reconstructed from her
session memory.

---

## Act 3: Share — Exporting Team Knowledge

Ingesting is personal. Sharing is for the team.

```
$ smriti share --project payments --segmented
```

```
  Segmenting session: Payment Service Deep Review...
  Found 5 knowledge units (3 above relevance threshold)
  Generating documentation...

Output: /Users/priya/src/payments/.smriti
Files created: 3
Files skipped: 0
```

Smriti's 3-stage pipeline just:

**Stage 1 — Segment**: Analyzed the 412-message session and identified 5
distinct knowledge units:

| Unit | Category | Relevance | Action |
|------|----------|-----------|--------|
| Webhook race condition | bug/investigation | 9 | Shared |
| BullMQ decision | architecture/decision | 8 | Shared |
| Stripe SDK deprecation | project/dependency | 7 | Shared |
| General code navigation | uncategorized | 3 | Filtered out |
| Test setup discussion | uncategorized | 2 | Filtered out |

**Stage 2 — Document**: Generated structured markdown using category-specific
templates. A bug gets Symptoms → Root Cause → Fix → Prevention. A decision
gets Context → Options → Decision → Consequences.

**Stage 3 — Persist**: Wrote files, deduplicated via content hash, updated the
manifest.

Here's what landed on disk:

```
payments/
└── .smriti/
    ├── CLAUDE.md                    # Auto-discovered by Claude Code
    ├── index.json
    ├── config.json
    └── knowledge/
        ├── bug-investigation/
        │   └── 2026-02-28_webhook-race-condition-duplicate-charges.md
        ├── architecture-decision/
        │   └── 2026-02-28_bullmq-for-payment-queue.md
        └── project-dependency/
            └── 2026-02-28_stripe-sdk-v3-deprecation.md
```

Let's look at the bug document:

```markdown
---
id: unit-a1b2c3
session_id: 6de3c493-60fa
category: bug/investigation
pipeline: segmented
relevance_score: 9
entities: ["Stripe webhooks", "idempotency", "race condition", "PostgreSQL"]
files: ["src/webhooks/stripe.ts", "src/db/events.ts"]
project: payments
author: priya
shared_at: 2026-02-28T17:45:00Z
---

# Webhook Race Condition Causing Duplicate Charges

## Symptoms

Customers occasionally receive duplicate charges for a single purchase.
The issue occurs under high webhook volume — Stripe sends the same event
twice within milliseconds, and both get processed.

## Root Cause

In `src/webhooks/stripe.ts`, the handler processes the event first, then
checks the idempotency table. Between processing and the idempotency check,
a duplicate webhook slips through.

The vulnerable window is ~15ms (database round-trip time), which is enough
for Stripe's retry mechanism to deliver a duplicate.

## Investigation

Traced the flow: `handleWebhook()` → `processEvent()` → `markProcessed()`.
The idempotency check happens inside `markProcessed()`, AFTER the charge
is executed. Should be BEFORE.

## Fix

Move the idempotency check to the entry point of `handleWebhook()`:

1. Add a `UNIQUE` constraint on `webhook_events.stripe_event_id`
2. `INSERT OR IGNORE` before processing — if the insert fails, the event
   was already handled
3. Wrap the entire handler in a database transaction

## Prevention

- Add integration test that fires duplicate webhooks concurrently
- Add monitoring alert on duplicate event IDs in the events table
- Consider adding Stripe's recommended `idempotency-key` header to all
  API calls
```

That's not a raw transcript. It's a **structured incident document** that any
engineer can read, understand, and act on — without ever having been in the
original session.

---

## Act 4: The Payoff

### Monday morning — Arjun picks up the webhook fix

He opens the payments repo. Claude Code automatically reads
`.smriti/CLAUDE.md` and sees the shared knowledge index.

```
$ smriti search "webhook duplicate" --project payments
```

He finds the full investigation, root cause, and fix — before writing a
single line of code.

### Two weeks later — the intern asks "why BullMQ?"

```
$ smriti recall "why BullMQ instead of pg-boss" --synthesize --project payments
```

The original tradeoff analysis surfaces instantly, with Priya's reasoning
preserved verbatim.

### A month later — Priya reviews a different service

She notices the same setTimeout retry pattern:

```
$ smriti search "setTimeout retry" --category bug
```

Her earlier finding surfaces. She already knows the fix.

---

## The Commands

```bash
# After a deep session — capture everything
smriti ingest claude

# Share structured knowledge with the team
smriti share --project payments --segmented

# Commit shared knowledge to git
cd /path/to/payments
git add .smriti/
git commit -m "docs: share payment service review findings"

# Teammates sync the knowledge
smriti sync --project payments

# Search across all your sessions
smriti search "race condition" --project payments

# Get synthesized answers from memory
smriti recall "how should we handle retries" --synthesize

# Check what you've captured
smriti status
```

---

## What Makes This Different

| Without Smriti | With Smriti |
|---|---|
| Session transcript sits in `~/.claude/` forever | Searchable, indexed, synthesizable memory |
| Knowledge dies when the session closes | Knowledge persists across sessions and engineers |
| Teammates start from scratch | Teammates find existing analysis instantly |
| "Why did we decide X?" — nobody remembers | `smriti recall "why X" --synthesize` |
| Deep dives produce code changes only | Deep dives produce code changes + documentation |

The session is ephemeral. The knowledge doesn't have to be.
