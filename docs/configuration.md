# Configuration

Smriti uses environment variables for configuration. Bun auto-loads `.env`
files, so you can put these in `~/.smriti/.env` and they'll be picked up
automatically — no need to set them in your shell profile.

Most people never need to touch these. The defaults work. The ones you're
most likely to change are `SMRITI_PROJECTS_ROOT` (to match where your
projects actually live) and `QMD_MEMORY_MODEL` (if you want a lighter Ollama
model).

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `QMD_DB_PATH` | `~/.cache/qmd/index.sqlite` | SQLite database path |
| `CLAUDE_LOGS_DIR` | `~/.claude/projects` | Claude Code session logs |
| `CODEX_LOGS_DIR` | `~/.codex` | Codex CLI session logs |
| `CLINE_LOGS_DIR` | `~/.cline/tasks` | Cline CLI tasks |
| `COPILOT_STORAGE_DIR` | auto-detected per OS | VS Code workspaceStorage root |
| `SMRITI_PROJECTS_ROOT` | `~/zero8.dev` | Root for project ID derivation |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama API endpoint |
| `QMD_MEMORY_MODEL` | `qwen3:8b-tuned` | Ollama model for synthesis |
| `SMRITI_CLASSIFY_THRESHOLD` | `0.5` | LLM classification trigger threshold |
| `SMRITI_AUTHOR` | `$USER` | Author name for team sharing |
| `SMRITI_DAEMON_DEBOUNCE_MS` | `30000` | File-stability wait before auto-ingest |

---

## Projects Root

`SMRITI_PROJECTS_ROOT` is the most commonly changed setting. It controls how
Smriti derives clean project IDs from Claude Code session paths.

Claude Code encodes project paths into directory names like
`-Users-zero8-zero8.dev-openfga`. Smriti reconstructs the real filesystem
path and strips the projects root prefix to produce a readable ID:

| Claude dir name | Projects root | Derived ID |
|-----------------|---------------|------------|
| `-Users-zero8-zero8.dev-openfga` | `~/zero8.dev` | `openfga` |
| `-Users-zero8-zero8.dev-avkash-regulation-hub` | `~/zero8.dev` | `avkash/regulation-hub` |
| `-Users-alice-code-myapp` | `~/code` | `myapp` |

If your projects live under `~/code` instead of `~/zero8.dev`:

```bash
export SMRITI_PROJECTS_ROOT="$HOME/code"
```

---

## Database Location

By default, Smriti shares QMD's database at `~/.cache/qmd/index.sqlite`.
This means QMD document search and Smriti memory search share the same vector
index — one embedding store, no duplication.

To keep them separate:

```bash
export QMD_DB_PATH="$HOME/.cache/smriti/memory.sqlite"
```

---

## Ollama Setup

Ollama is optional. Everything core — ingestion, search, recall, sharing —
works without it. Ollama only powers the features that require a language
model:

- `smriti recall --synthesize` — Compress recalled context into a summary
- `smriti share` — Generate session reflections (skip with `--no-reflect`)
- `smriti categorize --llm` — LLM fallback for ambiguous categorization

Install and start:

```bash
# macOS
brew install ollama
ollama serve

# Pull the default model
ollama pull qwen3:8b-tuned
```

The default model (`qwen3:8b-tuned`) is good but large (~4.7GB). For a
lighter option:

```bash
export QMD_MEMORY_MODEL="qwen3:0.5b"
ollama pull qwen3:0.5b
```

To point at a remote Ollama instance:

```bash
export OLLAMA_HOST="http://192.168.1.100:11434"
```

---

## Claude Code Hook

The install script creates `~/.claude/hooks/save-memory.sh` and registers it
in `~/.claude/settings.json`. This is what captures sessions automatically
when you end a Claude Code conversation.

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "/Users/you/.claude/hooks/save-memory.sh",
            "timeout": 30,
            "async": true
          }
        ]
      }
    ]
  }
}
```

**Requires `jq`** — the hook parses JSON input from Claude Code. Install with
`brew install jq` or `apt install jq`.

To disable: remove the entry from `settings.json`. To skip hook setup during
install, set `SMRITI_NO_HOOK=1` before running the installer.
