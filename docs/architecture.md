# Architecture

## Overview

```
  Claude Code    Cursor    Codex    Antigravity
       |           |         |           |
       v           v         v          v
  ┌──────────────────────────────────────────┐
  │          Smriti Ingestion Layer           │
  │                                          │
  │  src/ingest/claude.ts   (JSONL parser)   │
  │  src/ingest/antigravity.ts (Markdown)      │
  │  src/ingest/codex.ts    (JSONL parser)   │
  │  src/ingest/cursor.ts   (JSON parser)    │
  │  src/ingest/generic.ts  (file import)    │
  └──────────────────┬───────────────────────┘
                     │
                     v
  ┌──────────────────────────────────────────┐
  │           QMD Core (via src/qmd.ts)       │
  │                                          │
  │  addMessage()      content-addressed     │
  │  searchMemoryFTS() BM25 full-text        │
  │  searchMemoryVec() vector similarity     │
  │  recallMemories()  dedup + synthesis     │
  └──────────────────┬───────────────────────┘
                     │
                     v
  ┌──────────────────────────────────────────┐
  │     SQLite Database                       │
  │     ~/.cache/qmd/index.sqlite            │
  │                                          │
  │  QMD tables:                             │
  │    memory_sessions   memory_messages     │
  │    memory_fts        content_vectors     │
  │                                          │
  │  Smriti tables:                          │
  │    smriti_session_meta  (agent, project) │
  │    smriti_projects      (registry)       │
  │    smriti_categories    (taxonomy)       │
  │    smriti_session_tags  (categorization) │
  │    smriti_message_tags  (categorization) │
  │    smriti_shares        (team dedup)     │
  └──────────────────────────────────────────┘
```

## QMD Integration

Smriti builds on top of [QMD](https://github.com/tobi/qmd), a local-first search engine. QMD provides:

- **Content-addressable storage** — Messages are SHA256-hashed, no duplicates
- **FTS5 full-text search** — BM25 ranking with Porter stemming
- **Vector embeddings** — 384-dim vectors via embeddinggemma (node-llama-cpp)
- **Reciprocal Rank Fusion** — Combines FTS and vector results

All QMD imports go through a single re-export hub at `src/qmd.ts`:

```ts
// Every file imports from here, never from qmd directly
import { addMessage, searchMemoryFTS, recallMemories } from "./qmd";
import { hashContent } from "./qmd";
import { ollamaRecall } from "./qmd";
```

This creates a clean boundary — if QMD's API changes, only `src/qmd.ts` needs updating.

## Ingestion Pipeline

Each agent has a dedicated parser. The flow:

1. **Discover** — Glob for session files in agent-specific log directories
2. **Deduplicate** — Check `smriti_session_meta` for already-ingested session IDs
3. **Parse** — Agent-specific parsing into a common `ParsedMessage[]` format
4. **Store** — Save via QMD's `addMessage()` (content-addressed, SHA256 hashed)
5. **Annotate** — Attach Smriti metadata (agent ID, project ID) to `smriti_session_meta`

### Project Detection (Claude Code)

Claude Code stores sessions in `~/.claude/projects/<encoded-dir>/`. The directory name encodes the filesystem path with `-` replacing `/`:

```
-Users-zero8-zero8.dev-openfga  →  /Users/zero8/zero8.dev/openfga
```

Since folder names can also contain dashes, `deriveProjectPath()` uses greedy `existsSync()` matching: it tries candidate paths from left to right, picking the longest existing directory at each step.

`deriveProjectId()` then strips the configured `PROJECTS_ROOT` (default `~/zero8.dev`) to produce a clean project name like `openfga` or `avkash/regulation-hub`.

## Search Architecture

### Filtered Search

`searchFiltered()` in `src/search/index.ts` extends QMD's FTS5 search with JOINs to Smriti's metadata tables:

```sql
FROM memory_fts mf
JOIN memory_messages mm ON mm.rowid = mf.rowid
JOIN memory_sessions ms ON ms.id = mm.session_id
LEFT JOIN smriti_session_meta sm ON sm.session_id = mm.session_id
WHERE mf.content MATCH ?
  AND sm.project_id = ?      -- project filter
  AND sm.agent_id = ?         -- agent filter
  AND EXISTS (...)            -- category filter via smriti_message_tags
```

### Recall

`recall()` in `src/search/recall.ts` wraps search with:

1. **Session deduplication** — Keep only the best-scoring result per session
2. **Optional synthesis** — Sends results to Ollama's `ollamaRecall()` for a coherent summary

When no filters are specified, it delegates directly to QMD's native `recallMemories()`.

## Team Sharing

### Export (`smriti share`)

Sessions are exported as markdown files with YAML frontmatter:

```
.smriti/
├── config.json
├── index.json              # Manifest of all shared files
└── knowledge/
    ├── decision/
    │   └── 2026-02-10_auth-migration-approach.md
    └── bug/
        └── 2026-02-09_connection-pool-fix.md
```

Each file contains:

- YAML frontmatter (session ID, category, project, agent, author, tags)
- Session title as heading
- Summary (if available)
- Full conversation in `**role**: content` format

Content hashes prevent re-exporting the same content.

### Import (`smriti sync`)

Reads markdown files from `.smriti/knowledge/`, parses frontmatter and conversation, and imports via `addMessage()`. Content hashing prevents duplicate imports.

## Database Schema

### QMD Tables (not modified by Smriti)

| Table             | Purpose                                           |
| ----------------- | ------------------------------------------------- |
| `memory_sessions` | Session metadata (id, title, timestamps, summary) |
| `memory_messages` | Messages (session_id, role, content, SHA256 hash) |
| `memory_fts`      | FTS5 index on session titles + message content    |
| `content_vectors` | 384-dim embeddings keyed by content hash          |

### Smriti Tables

| Table                 | Purpose                                                  |
| --------------------- | -------------------------------------------------------- |
| `smriti_agents`       | Agent registry (claude-code, codex, cursor, antigravity) |
| `smriti_projects`     | Project registry (id, filesystem path)                   |
| `smriti_session_meta` | Maps sessions to agents and projects                     |
| `smriti_categories`   | Hierarchical category taxonomy                           |
| `smriti_session_tags` | Category tags on sessions (with confidence)              |
| `smriti_message_tags` | Category tags on messages (with confidence)              |
| `smriti_shares`       | Deduplication tracking for team sharing                  |
