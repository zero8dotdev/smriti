<p align="center">
  <img src="assets/banner.png" alt="Smriti — Shared memory for AI-powered engineering teams" width="600" />
</p>

<p align="center">
  <em>An exploration of memory in the agentic world</em>
</p>

---

The agentic world is moving fast. Every team is shipping with AI — Claude Code,
Cursor, Codex, Cline. The agents are getting better. The tooling is maturing.

But there's a gap nobody has fully closed:

> **Agents don't remember.**

Not from yesterday. Not from each other. Not from your teammates. Every session
starts from zero, no matter how much your team has already figured out.

This isn't just a developer experience problem. It's a foundational gap in how
agents work. As they get more capable and longer-running, memory becomes a
prerequisite — not a feature. Without it, knowledge stays buried in chat
histories. Teams re-discover what they've already figured out. Decisions get
made twice.

The answer, I think, mirrors how our own memory works:

> **Ingest → Categorize → Recall → Search**

That's the brain. That's what **Smriti** (Sanskrit: _memory_) is building
toward.

---

## The Problem, Up Close

Here's what the gap looks like in practice:

| Monday                                                        | Tuesday                                             |
| ------------------------------------------------------------- | --------------------------------------------------- |
| Your teammate spends 3 hours with Claude on an auth migration | You open a fresh session and ask the same questions |
| Claude figures out the right approach, makes key decisions    | Your Claude has no idea any of that happened        |
| Architectural insights, debugging breakthroughs, trade-offs   | All of it — gone                                    |

The result:

- **Duplicated work** — same questions asked across the team, different answers
  every time
- **Lost decisions** — "why did we do it this way?" lives in someone's closed
  chat window
- **Zero continuity** — each session starts from scratch, no matter how much
  your team has already figured out

The agents are brilliant. But they're amnesic. **This is the biggest unsolved
gap in agentic AI today.**

---

## What Smriti Does

Smriti is a shared memory layer that sits underneath your AI agents.

Every conversation → automatically captured → indexed → searchable. One command
to recall what matters.

```bash
# What did we figure out about the auth migration?
smriti recall "auth migration approach"

# What has the team been working on?
smriti list --project myapp

# Search across every conversation, every agent, every teammate
smriti search "rate limiting strategy" --project api-service
```

> **20,000 tokens** of past conversations → **500 tokens** of relevant context.
> Your agents get what they need without blowing up your token budget.

Built on top of [QMD](https://github.com/tobi/qmd) by Tobi Lütke. Everything
runs locally — no cloud, no accounts, no telemetry.

---

## Install

**macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/zero8dotdev/smriti/main/install.sh | bash
```

**Windows** (PowerShell):

```powershell
irm https://raw.githubusercontent.com/zero8dotdev/smriti/main/install.ps1 | iex
```

Both installers will:

- Install [Bun](https://bun.sh) if you don't have it
- Clone Smriti to `~/.smriti`
- Set up the `smriti` CLI on your PATH
- Configure the Claude Code auto-save hook

**Requirements:** macOS, Linux, or Windows 10+ · Git · Bun ≥ 1.1
(auto-installed) · Ollama (optional, for synthesis)

```bash
smriti upgrade   # update to latest
```

---

## Quick Start

```bash
# 1. Ingest your recent Claude Code sessions
smriti ingest claude

# 2. Search what your team has discussed
smriti search "database connection pooling"

# 3. Recall with synthesis into one coherent summary (requires Ollama)
smriti recall "how did we handle rate limiting" --synthesize

# 4. Share knowledge with your team through git
smriti share --project myapp
git add .smriti && git commit -m "chore: share session knowledge"

# 5. Teammates pull it in
smriti sync --project myapp
```

---

## The Workflow

**1. Conversations are captured automatically**

A lightweight hook saves every Claude Code session in the background. No manual
step, no copy-pasting. Your team's collective knowledge accumulates silently as
everyone works.

**2. Context flows between sessions**

Starting a new coding session? Pull in what's relevant:

```bash
smriti recall "how did we handle database connection pooling" --synthesize
```

Smriti searches across full-text and semantic indexes, deduplicates by session,
and optionally synthesizes the results into a single coherent summary via a
local LLM. Your new session starts with the full picture, not a blank slate.

**3. Knowledge stays organized**

Sessions are automatically tagged by project, agent, and category. Search by
what matters:

```bash
# Everything about deployment across all agents
smriti search "deployment" --category decision

# What has Cursor been used for on this project?
smriti list --agent cursor --project frontend

# All architectural decisions, team-wide
smriti search "architecture" --category decision
```

**4. Teams share context through git**

Export knowledge to a `.smriti/` directory in your project repo. Commit it. Your
teammates pull it and import it into their local memory. No cloud service, no
account, no sync infrastructure — just git.

```bash
smriti share --project myapp --category decision
smriti sync --project myapp
```

---

## Commands

```bash
# Ingest conversations from your AI agents
smriti ingest claude          # Claude Code sessions
smriti ingest codex           # Codex CLI sessions
smriti ingest cline           # Cline CLI sessions
smriti ingest copilot         # GitHub Copilot (VS Code) sessions
smriti ingest cursor --project-path ./myapp
smriti ingest file transcript.txt --title "Planning Session"
smriti ingest all             # All known agents at once

# Search and recall
smriti search "query"         # Full-text + vector hybrid search
smriti recall "query"         # Smart recall with session deduplication
smriti recall "query" --synthesize  # Synthesize into one coherent summary

# Filter anything by project, agent, or category
smriti search "auth" --project myapp --agent claude-code
smriti list --category decision --project api

# Manage your memory
smriti status                 # Statistics across all agents
smriti list                   # Recent sessions
smriti show <session-id>      # Read a full session
smriti embed                  # Build vector embeddings for semantic search
smriti categorize             # Auto-categorize sessions
smriti projects               # List all tracked projects
smriti upgrade                # Update smriti to the latest version

# Context injection
smriti context                # Generate project context → .smriti/CLAUDE.md
smriti context --dry-run      # Preview without writing
smriti compare --last         # Compare last 2 sessions (tokens, tools, files)
smriti compare <id-a> <id-b>  # Compare specific sessions

# Team sharing
smriti share --project myapp  # Export to .smriti/ for git
smriti sync                   # Import teammates' shared knowledge
smriti team                   # View team contributions
```

---

## How It Works

```
Claude Code    Cursor    Codex    Other Agents
     |           |         |          |
     v           v         v          v
┌──────────────────────────────────────────┐
│          Smriti Ingestion Layer           │
│   (auto-hook + manual ingest commands)   │
└──────────────────┬───────────────────────┘
                   │
                   v
┌──────────────────────────────────────────┐
│         Local SQLite Database             │
│                                          │
│  memory_sessions    memory_messages      │
│  memory_fts (BM25)  content_vectors      │
│  project metadata   category tags        │
└──────────────────┬───────────────────────┘
                   │
          ┌────────┴────────┐
          v                 v
   Full-Text Search    Vector Search
   (BM25 + porter)     (embeddings + RRF)
          │                 │
          └────────┬────────┘
                   v
         Recall + Synthesis
         (optional, via Ollama)
```

Everything runs locally. Your conversations never leave your machine. The SQLite
database, the embeddings, the search indexes — all on disk, all yours.

---

## Privacy

Smriti is local-first by design. No cloud, no telemetry, no accounts.

- All data stored in `~/.cache/qmd/index.sqlite`
- Embeddings computed locally via
  [node-llama-cpp](https://github.com/withcatai/node-llama-cpp)
- Synthesis via local [Ollama](https://ollama.ai) (optional)
- Team sharing happens through git — you control what gets committed

---

## FAQ

**When does knowledge get captured?** Automatically. Smriti hooks into Claude
Code and captures every session without any manual step. For other agents, run
`smriti ingest all` to pull in conversations on demand.

**Who has access to my data?** Only you. Everything lives in a local SQLite
database. There's no cloud, no accounts, no telemetry. Team sharing is
explicit — you run `smriti share`, commit the `.smriti/` folder, and teammates
run `smriti sync`.

**Can AI agents query the knowledge base?** Yes. `smriti recall "query"` returns
relevant past context. `smriti share` generates a `.smriti/CLAUDE.md` so Claude
Code automatically discovers shared knowledge at the start of every session.

**How do multiple projects stay separate?** Each project gets its own `.smriti/`
folder. Sessions are tagged with project IDs in the central database. Search
works cross-project by default, scoped with `--project <id>`.

**Does this work with Jira or other issue trackers?** Not yet — Smriti is
git-native today. Issue tracker integrations are on the roadmap.

**Further reading:** See [docs/cli.md](./docs/cli.md) for the full command
reference, [docs/internal/ingest-architecture.md](./docs/internal/ingest-architecture.md) for the ingestion
pipeline, and [CLAUDE.md](./CLAUDE.md) for the database schema and
architecture.

---

## About

I've been coding with AI agents for about 8 months. At some point the
frustration became impossible to ignore — every new session, you start from
zero. Explaining the same context, the same decisions, the same constraints.
That's not a great developer experience.

I started small: custom prompts to export Claude sessions. That grew old fast. I
needed categorization. Found QMD. Started building on top of it. Dogfooded it.
Hit walls. Solved one piece at a time.

At some point it worked well enough that I shared it with some friends. Some
used it, some ignored it — fair, the AI tooling space is noisy. But I kept
exploring, and found others building toward the same problem: Claude-mem, Letta,
a growing community of people who believe memory is the next foundational layer
for AI.

That's what Smriti is, really. An exploration. The developer tool is one layer.
But the deeper question is: what does memory for autonomous agents actually need
to look like? The answer probably mirrors how our own brain works — **Ingest →
Categorize → Recall → Search**. We're figuring that out, one piece at a time.

I come from the developer tooling space. Bad tooling bothers me. There's always
a better way. This is that project.

---

## Special Thanks

Smriti is built on top of [QMD](https://github.com/tobi/qmd) — a beautifully
designed local search engine for markdown files created by
[Tobi Lütke](https://github.com/tobi), CEO of Shopify. QMD gave us fast,
local-first SQLite with full-text search, vector embeddings, and
content-addressable hashing — all on your machine, zero cloud dependencies.
Instead of rebuilding that infrastructure from scratch, we focused entirely on
the memory layer, multi-agent ingestion, and team sharing.

Thank you, Tobi, for open-sourcing it.

---

## Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/zero8dotdev/smriti/main/uninstall.sh | bash
```

To also remove hook state, prepend `SMRITI_PURGE=1` to the command.

---

## License

MIT

---

**Smriti** — Your team's AI agents finally remember.
