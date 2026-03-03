# Architecture

Smriti's architecture follows the same pattern as memory in your brain:
**Ingest → Categorize → Recall → Search**.

Every layer has one job. Parsers extract conversations. The resolver maps
them to projects. The store persists them. Search retrieves them. Nothing
crosses those boundaries.

---

## System Overview

```
Claude Code    Cursor    Codex    Cline    Copilot
     |           |         |        |         |
     v           v         v        v         v
┌──────────────────────────────────────────────┐
│            Smriti Ingestion Layer             │
│                                              │
│  parsers/claude.ts    (JSONL)                │
│  parsers/codex.ts     (JSONL)                │
│  parsers/cursor.ts    (JSON)                 │
│  parsers/cline.ts     (task files)           │
│  parsers/copilot.ts   (VS Code storage)      │
│  parsers/generic.ts   (file import)          │
│                                              │
│  session-resolver.ts  (project detection)    │
│  store-gateway.ts     (persistence)          │
└──────────────────┬───────────────────────────┘
                   │
                   v
┌──────────────────────────────────────────────┐
│           QMD Core (via src/qmd.ts)           │
│                                              │
│  addMessage()       content-addressed        │
│  searchMemoryFTS()  BM25 full-text           │
│  searchMemoryVec()  vector similarity        │
│  recallMemories()   dedup + synthesis        │
└──────────────────┬───────────────────────────┘
                   │
                   v
┌──────────────────────────────────────────────┐
│  SQLite  (~/.cache/qmd/index.sqlite)          │
│                                              │
│  QMD tables:                                 │
│    memory_sessions    memory_messages        │
│    memory_fts (BM25)  content_vectors        │
│                                              │
│  Smriti tables:                              │
│    smriti_session_meta  (agent, project)     │
│    smriti_projects      (registry)           │
│    smriti_categories    (taxonomy)           │
│    smriti_session_tags  (categorization)     │
│    smriti_message_tags  (categorization)     │
│    smriti_shares        (team dedup)         │
└──────────────────────────────────────────────┘
```

Everything runs locally. Nothing leaves your machine.

---

## Built on QMD

Smriti builds on [QMD](https://github.com/tobi/qmd) — a local-first search
engine for markdown files by Tobi Lütke. QMD handles the hard parts:

- **Content-addressable storage** — messages are SHA256-hashed, no duplicates
- **FTS5 full-text search** — BM25 ranking with Porter stemming
- **Vector embeddings** — 384-dim via EmbeddingGemma (node-llama-cpp),
  computed entirely on-device
- **Reciprocal Rank Fusion** — combines FTS and vector results

All QMD imports go through a single re-export hub at `src/qmd.ts`. No file
in the codebase imports from QMD directly — only through this hub. If QMD's
API changes, one file needs updating.

```ts
import { addMessage, searchMemoryFTS, recallMemories } from "./qmd";
import { hashContent, ollamaRecall } from "./qmd";
```

---

## Ingestion Pipeline

Ingestion is a four-stage pipeline with clean separation between stages:

1. **Parse** — agent-specific parsers extract conversations into a normalized
   `ParsedMessage[]` format. No DB writes, no side effects. Pure functions.
2. **Resolve** — `session-resolver.ts` maps sessions to projects, handles
   incremental ingestion (picks up where it left off), derives clean project
   IDs from agent-specific path formats.
3. **Store** — `store-gateway.ts` persists messages, session metadata,
   sidecars, and cost data. All writes go through here.
4. **Orchestrate** — `ingest/index.ts` drives the flow with per-session error
   isolation. One broken session doesn't stop the rest.

### Project Detection

Claude Code encodes project paths into directory names like
`-Users-zero8-zero8.dev-openfga` (slashes become dashes). Since folder
names can also contain real dashes, `deriveProjectPath()` uses greedy
`existsSync()` matching — trying candidate paths left to right, picking the
longest valid directory at each step.

`deriveProjectId()` then strips `SMRITI_PROJECTS_ROOT` to produce a clean
name: `openfga`, `avkash/regulation-hub`.

---

## Search

Smriti adds a metadata filter layer on top of QMD's native search:

**`smriti search`** — FTS5 full-text with JOINs to Smriti's metadata tables.
Filters by project, agent, and category without touching the vector index.
Fast, synchronous, no model loading.

**`smriti recall`** — Two paths depending on whether filters are applied:

- *No filters* → delegates to QMD's native `recallMemories()`: FTS + vector
  + Reciprocal Rank Fusion + session dedup. Full hybrid pipeline.
- *With filters* → filtered FTS search + session dedup. Vector search is
  currently bypassed when filters are active. (This is a known gap — see
  [search.md](./search.md) for details.)

**`smriti embed`** — builds vector embeddings for all unembedded messages.
Required before vector search works. Runs locally via node-llama-cpp.

---

## Database Schema

### QMD Tables

| Table | Purpose |
|-------|---------|
| `memory_sessions` | Session metadata (id, title, timestamps, summary) |
| `memory_messages` | Messages (session_id, role, content, SHA256 hash) |
| `memory_fts` | FTS5 index on session titles + message content |
| `content_vectors` | 384-dim embeddings keyed by content hash |

### Smriti Tables

| Table | Purpose |
|-------|---------|
| `smriti_agents` | Agent registry (claude-code, codex, cursor...) |
| `smriti_projects` | Project registry (id, filesystem path) |
| `smriti_session_meta` | Maps sessions to agents and projects |
| `smriti_categories` | Hierarchical category taxonomy |
| `smriti_session_tags` | Category tags on sessions (with confidence score) |
| `smriti_message_tags` | Category tags on messages (with confidence score) |
| `smriti_shares` | Deduplication tracking for team sharing |

---

## Team Sharing

Export (`smriti share`) converts sessions to markdown with YAML frontmatter
and writes them to `.smriti/knowledge/`, organized by category. The YAML
carries session ID, category, project, agent, author, and tags — enough to
reconstruct the full metadata on import.

Import (`smriti sync`) parses frontmatter, restores categories, and inserts
via `addMessage()`. Content hashing prevents duplicate imports. The
roundtrip is symmetric: what gets written during share is exactly what gets
read during sync.

See [team-sharing.md](./team-sharing.md) for the workflow.
