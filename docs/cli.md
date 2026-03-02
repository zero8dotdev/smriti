# Smriti CLI Reference

Everything you can do with `smriti`. For the big picture, see the
[README](../README.md).

---

## Global Flags

```bash
smriti --version     # Print version
smriti --help        # Print command overview
smriti help          # Same as --help
```

---

## Global Filters

These flags work across `search`, `recall`, `list`, and `share`:

| Flag | Description |
|------|-------------|
| `--category <id>` | Filter by category (e.g. `decision`, `bug/fix`) |
| `--project <id>` | Filter by project ID |
| `--agent <id>` | Filter by agent (`claude-code`, `codex`, `cursor`, `cline`, `copilot`) |
| `--limit <n>` | Max results returned |
| `--json` | Machine-readable JSON output |

Hierarchical category filtering: `--category decision` matches `decision`,
`decision/technical`, `decision/process`, and `decision/tooling`.

---

## Ingestion

### `smriti ingest <agent>`

Pull conversations from an AI agent into Smriti's memory.

| Agent | Source |
|-------|--------|
| `claude` / `claude-code` | `~/.claude/projects/*/*.jsonl` |
| `codex` | `~/.codex/**/*.jsonl` |
| `cline` | `~/.cline/tasks/**` |
| `copilot` | VS Code `workspaceStorage` (auto-detected per OS) |
| `cursor` | `.cursor/**/*.json` (requires `--project-path`) |
| `file` / `generic` | Any file path |
| `all` | All known agents at once |

```bash
smriti ingest claude
smriti ingest codex
smriti ingest cline
smriti ingest copilot
smriti ingest cursor --project-path /path/to/project
smriti ingest file ~/transcript.txt --title "Planning Session" --format chat
smriti ingest all
```

**Options:**

| Flag | Description |
|------|-------------|
| `--project-path <path>` | Project directory (required for Cursor) |
| `--file <path>` | File path (alternative to positional arg for generic ingest) |
| `--format <chat\|jsonl>` | File format (default: `chat`) |
| `--title <text>` | Session title override |
| `--session <id>` | Custom session ID |
| `--project <id>` | Assign ingested sessions to a specific project |

---

## Search & Recall

### `smriti search <query>`

Hybrid full-text + vector search across all memory. Returns ranked results
with session and message context.

```bash
smriti search "rate limiting"
smriti search "auth" --project myapp --agent claude-code
smriti search "deployment" --category decision --limit 10
smriti search "API design" --json
```

**Options:** All global filters apply.

---

### `smriti recall <query>`

Like search, but deduplicates results by session and optionally synthesizes
them into a single coherent summary via Ollama.

```bash
smriti recall "how did we handle caching"
smriti recall "database setup" --synthesize
smriti recall "auth flow" --synthesize --model qwen3:0.5b --max-tokens 200
smriti recall "deployment" --category decision --project api --json
```

**Options:**

| Flag | Description |
|------|-------------|
| `--synthesize` | Synthesize results into one summary via Ollama (requires Ollama running) |
| `--model <name>` | Ollama model to use (default: `qwen3:8b-tuned`) |
| `--max-tokens <n>` | Max tokens for synthesized output |
| All global filters | `--category`, `--project`, `--agent`, `--limit`, `--json` |

---

## Sessions

### `smriti list`

List recent sessions with filtering.

```bash
smriti list
smriti list --project myapp --agent claude-code
smriti list --category decision --limit 20
smriti list --all
smriti list --json
```

**Options:**

| Flag | Description |
|------|-------------|
| `--all` | Include inactive/archived sessions |
| All global filters | `--category`, `--project`, `--agent`, `--limit`, `--json` |

---

### `smriti show <session-id>`

Display all messages in a session. Supports partial session IDs.

```bash
smriti show abc12345
smriti show abc12345 --limit 10
smriti show abc12345 --json
```

**Options:**

| Flag | Description |
|------|-------------|
| `--limit <n>` | Max messages to display |
| `--json` | JSON output |

---

### `smriti status`

Memory statistics: total sessions, messages, agent breakdown, project
breakdown, category distribution.

```bash
smriti status
smriti status --json
```

---

### `smriti projects`

List all registered projects.

```bash
smriti projects
smriti projects --json
```

---

## Embeddings

### `smriti embed`

Build vector embeddings for all unembedded messages. Required for semantic
(vector) search to work. Runs locally via `node-llama-cpp` — no network
calls.

```bash
smriti embed
```

---

## Categorization

### `smriti categorize`

Auto-categorize uncategorized sessions using rule-based keyword matching with
an optional LLM fallback for ambiguous cases.

```bash
smriti categorize
smriti categorize --session abc12345
smriti categorize --llm
```

**Options:**

| Flag | Description |
|------|-------------|
| `--session <id>` | Categorize a specific session only |
| `--llm` | Enable Ollama LLM fallback for low-confidence classifications |

---

### `smriti tag <session-id> <category>`

Manually assign a category to a session. Stored with confidence `1.0` and
source `"manual"`.

```bash
smriti tag abc12345 decision/technical
smriti tag abc12345 bug/fix
```

---

### `smriti categories`

Display the full category tree.

```bash
smriti categories
```

**Default categories:**

| Category | Subcategories |
|----------|---------------|
| `code` | `code/implementation`, `code/pattern`, `code/review`, `code/snippet` |
| `architecture` | `architecture/design`, `architecture/decision`, `architecture/tradeoff` |
| `bug` | `bug/report`, `bug/fix`, `bug/investigation` |
| `feature` | `feature/requirement`, `feature/design`, `feature/implementation` |
| `project` | `project/setup`, `project/config`, `project/dependency` |
| `decision` | `decision/technical`, `decision/process`, `decision/tooling` |
| `topic` | `topic/learning`, `topic/explanation`, `topic/comparison` |

---

### `smriti categories add <id>`

Add a custom category to the tree.

```bash
smriti categories add ops --name "Operations"
smriti categories add ops/incident --name "Incident Response" --parent ops
smriti categories add ops/runbook --name "Runbooks" --parent ops --description "Operational runbook sessions"
```

**Options:**

| Flag | Description |
|------|-------------|
| `--name <text>` | Display name (required) |
| `--parent <id>` | Parent category ID |
| `--description <text>` | Optional description |

---

## Context & Compare

### `smriti context`

Generate a compact project summary (~200–300 tokens) and write it to
`.smriti/CLAUDE.md`. Claude Code auto-discovers this file at session start.

Runs entirely from SQL — no Ollama, no network, no model loading. Typically
completes in under 100ms.

```bash
smriti context
smriti context --dry-run
smriti context --project myapp
smriti context --days 14
smriti context --json
```

**Options:**

| Flag | Description |
|------|-------------|
| `--project <id>` | Project to generate context for (auto-detected from `cwd` if omitted) |
| `--days <n>` | Lookback window in days (default: `7`) |
| `--dry-run` | Print output to stdout without writing the file |
| `--json` | JSON output |

---

### `smriti compare <session-a> <session-b>`

Compare two sessions across turns, tokens, tool calls, and file reads. Useful
for A/B testing context injection impact.

```bash
smriti compare abc123 def456
smriti compare --last
smriti compare --last --project myapp
smriti compare --last --json
```

**Options:**

| Flag | Description |
|------|-------------|
| `--last` | Compare the two most recent sessions (for current project) |
| `--project <id>` | Project scope for `--last` |
| `--json` | JSON output |

Partial session IDs are supported (first 7+ characters).

---

## Team Sharing

### `smriti share`

Export sessions as clean markdown files to `.smriti/knowledge/` for
git-based team sharing. Generates LLM reflections via Ollama by default.
Also writes `.smriti/CLAUDE.md` so Claude Code auto-discovers shared
knowledge.

```bash
smriti share --project myapp
smriti share --category decision
smriti share --session abc12345
smriti share --output /custom/path
smriti share --no-reflect
smriti share --reflect-model llama3.2
smriti share --segmented --min-relevance 7
```

**Options:**

| Flag | Description |
|------|-------------|
| `--project <id>` | Export sessions for a specific project |
| `--category <id>` | Export only sessions with this category |
| `--session <id>` | Export a single session |
| `--output <dir>` | Custom output directory (default: `.smriti/`) |
| `--no-reflect` | Skip LLM reflections (reflections are on by default) |
| `--reflect-model <name>` | Ollama model for reflections |
| `--segmented` | Use 3-stage segmentation pipeline — beta |
| `--min-relevance <float>` | Relevance threshold for segmented mode (default: `6`) |

---

### `smriti sync`

Import team knowledge from a `.smriti/knowledge/` directory into local
memory. Deduplicates by content hash — same content won't import twice.

```bash
smriti sync
smriti sync --project myapp
smriti sync --input /custom/path
```

**Options:**

| Flag | Description |
|------|-------------|
| `--project <id>` | Scope sync to a specific project |
| `--input <dir>` | Custom input directory (default: `.smriti/`) |

---

### `smriti team`

View team contributions: authors, session counts, and category breakdown.

```bash
smriti team
```

---

## Maintenance

### `smriti upgrade`

Pull the latest version from GitHub and reinstall dependencies. Equivalent to
re-running the install script.

```bash
smriti upgrade
```
