# Getting Started

You're about to give your AI agents memory.

By the end of this guide, your Claude Code sessions will be automatically
saved, searchable, and shareable — across sessions, across days, across your
team.

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

The installer: checks for Bun (installs it if missing) → clones Smriti to
`~/.smriti` → creates the `smriti` CLI → sets up the Claude Code auto-save
hook.

### Verify

```bash
smriti help
```

If `smriti` is not found, add `~/.local/bin` to your PATH:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
```

---

## First Run

### 1. Pull in your Claude Code sessions

```bash
smriti ingest claude
```

Scans `~/.claude/projects/` and imports every conversation. On first run this
might take a moment if you've been coding with Claude for a while.

### 2. See what you have

```bash
smriti status
```

Session counts, message counts, breakdown by project and agent. This is your
memory — everything Smriti knows about your past work.

### 3. Search it

```bash
smriti search "authentication"
```

Keyword search across every session. Try something you remember working
through in a past conversation.

### 4. Recall with context

```bash
smriti recall "how did we set up the database"
```

Like search, but smarter — deduplicates by session and surfaces the most
relevant snippets. Add `--synthesize` to compress results into a single
coherent summary (requires Ollama).

### 5. Turn on semantic search

```bash
smriti embed
```

Builds vector embeddings locally. After this, searches find semantically
similar content — not just keyword matches. "auth flow" starts surfacing
results that talk about "login mechanism."

---

## Auto-Save

If the install completed cleanly, you're done — every Claude Code session is
saved automatically when you end it. No manual step, no copy-pasting.

Verify the hook is active:

```bash
cat ~/.claude/settings.json | grep save-memory
```

If the hook isn't there, re-run the installer or set it up manually — see
[Configuration](./configuration.md#claude-code-hook).

---

## Share with Your Team

Once you've built up memory, share the useful parts through git:

```bash
smriti share --project myapp --category decision
cd ~/projects/myapp
git add .smriti/ && git commit -m "Share auth migration decisions"
git push
```

A teammate imports it:

```bash
git pull && smriti sync --project myapp
smriti recall "auth migration" --project myapp
```

Their agent now has your context. See [Team Sharing](./team-sharing.md) for
the full guide.

---

## Next Steps

- [CLI Reference](./cli.md) — Every command and option
- [Team Sharing](./team-sharing.md) — Share knowledge through git
- [Configuration](./configuration.md) — Customize paths, models, and behavior
- [Architecture](./architecture.md) — How Smriti works under the hood
