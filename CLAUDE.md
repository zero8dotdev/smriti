# Smriti

Shared memory layer for AI-powered engineering teams. Built on [QMD](https://github.com/tobi/qmd).

## Quick Reference

```bash
smriti ingest claude             # Ingest Claude Code sessions
smriti ingest all                # Ingest from all known agents
smriti search "query"            # Hybrid search (BM25 + vector)
smriti recall "query"            # Smart recall with dedup
smriti recall "query" --synthesize  # Synthesize via Ollama
smriti list                      # Recent sessions
smriti show <session-id>         # View a session
smriti status                    # Memory statistics
smriti embed                     # Build vector embeddings
smriti categorize                # Auto-categorize sessions
smriti share --project myapp     # Export to .smriti/ for git
smriti sync                      # Import team knowledge
```

## Project Structure

```
src/
├── index.ts              # CLI entry point
├── config.ts             # Paths, env vars, defaults
├── db.ts                 # SQLite schema + Smriti metadata tables
├── qmd.ts                # Centralized re-exports from QMD package
├── format.ts             # Output formatting (JSON, CSV, CLI)
├── ingest/
│   ├── index.ts          # Ingest orchestrator + types
│   ├── claude.ts         # Claude Code JSONL parser + project detection
│   ├── codex.ts          # Codex CLI parser
│   ├── cursor.ts         # Cursor IDE parser
│   └── generic.ts        # File import (chat/jsonl formats)
├── search/
│   ├── index.ts          # Filtered FTS search + session listing
│   └── recall.ts         # Recall with synthesis
├── categorize/
│   ├── schema.ts         # Category tree definitions
│   └── classifier.ts     # Auto-categorization (rule-based + LLM)
└── team/
    ├── share.ts          # Export knowledge to .smriti/ directory
    ├── sync.ts           # Import team knowledge from .smriti/
    ├── formatter.ts      # Sanitization + doc formatting pipeline
    ├── reflect.ts        # LLM-powered session reflection via Ollama
    └── prompts/
        └── share-reflect.md  # Customizable reflection prompt template
test/
├── ingest.test.ts        # Parser + project detection tests
├── search.test.ts        # Search + recall tests
├── db.test.ts            # Schema + metadata tests
├── categorize.test.ts    # Categorization tests
├── team.test.ts          # Share + sync tests
├── formatter.test.ts     # Formatter + sanitization tests
└── reflect.test.ts       # Reflection parsing tests
```

## Architecture

All QMD imports go through `src/qmd.ts` — a single re-export hub:

```ts
import { addMessage, searchMemoryFTS, recallMemories } from "./qmd";
import { hashContent } from "./qmd";
import { ollamaRecall } from "./qmd";
```

Never import from QMD directly in other files. Always go through `src/qmd.ts`.

## Key Concepts

### Project Detection

Claude Code stores sessions in `~/.claude/projects/<dir-name>/`. The dir name encodes the filesystem path with `-` replacing `/` (e.g. `-Users-zero8-zero8.dev-openfga`).

`deriveProjectPath()` reconstructs the real path using greedy `existsSync()` matching. `deriveProjectId()` strips `PROJECTS_ROOT` (default `~/zero8.dev`) to get a clean name like `openfga`.

### Ingestion Pipeline

1. Discover sessions (glob for JSONL/JSON files)
2. Deduplicate against `smriti_session_meta`
3. Parse agent-specific format → `ParsedMessage[]`
4. Save via QMD's `addMessage()` (content-addressable, SHA256 hashed)
5. Attach Smriti metadata (agent, project, categories)

### Search

- **Filtered search** (`searchFiltered`): FTS5 with JOINs to Smriti metadata tables for category/project/agent filtering
- **Unfiltered search** (`searchFTS`, `searchVec`): Delegates directly to QMD
- **Recall**: Search → deduplicate by session → optionally synthesize via Ollama

### Team Sharing

- `smriti share`: Exports sessions as clean documentation to `.smriti/knowledge/`
  - Sanitizes XML noise, interrupt markers, API errors, narration filler
  - Filters noise-only sessions, merges consecutive same-role messages
  - Generates LLM reflections via Ollama by default (use `--no-reflect` to skip)
  - Generates `.smriti/CLAUDE.md` so Claude Code auto-discovers shared knowledge
  - Customizable reflection prompt at `.smriti/prompts/share-reflect.md`
- `smriti sync`: Imports markdown files from `.smriti/knowledge/` back into local DB
- Deduplication via content hashing — same content won't import twice

## Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `QMD_DB_PATH` | `~/.cache/qmd/index.sqlite` | Database path |
| `CLAUDE_LOGS_DIR` | `~/.claude/projects` | Claude Code logs |
| `CODEX_LOGS_DIR` | `~/.codex` | Codex CLI logs |
| `SMRITI_PROJECTS_ROOT` | `~/zero8.dev` | Projects root for ID derivation |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama endpoint |
| `QMD_MEMORY_MODEL` | `qwen3:8b-tuned` | Ollama model for synthesis |
| `SMRITI_CLASSIFY_THRESHOLD` | `0.5` | LLM classification trigger threshold |
| `SMRITI_AUTHOR` | `$USER` | Git author for team sharing |

## Database

Smriti extends QMD's tables with its own metadata:

- `smriti_session_meta` — agent_id, project_id per session
- `smriti_projects` — project registry (id, path, description)
- `smriti_categories` — hierarchical category tree
- `smriti_session_tags` — category tags on sessions
- `smriti_message_tags` — category tags on messages
- `smriti_shares` — dedup tracking for team sharing

QMD's core tables: `memory_sessions`, `memory_messages`, `memory_fts`, `content_vectors`.

## Development

```bash
bun install          # Install deps (QMD from github:zero8dotdev/qmd)
bun test             # Run all tests
bun --hot src/index.ts  # Dev mode with hot reload
```

## Design Decisions

1. **Single QMD import hub** (`src/qmd.ts`): No scattered dynamic imports, clean dependency boundary
2. **Greedy path resolution**: Handles ambiguous dashes in Claude dir names via `existsSync()`
3. **Embeddings share QMD's tables**: `content_vectors` + `vectors_vec`, no duplication
4. **Two-step vector search**: Query `vectors_vec` first, then JOIN to avoid sqlite-vec hang
5. **Content-addressable messages**: SHA256 hashing, same as QMD documents
6. **Auto-save via hooks**: Claude Code conversations saved without user action
