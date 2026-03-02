# QMD Implementation Deep Dive - Learning Session Plan

## Context

This is a comprehensive learning session to understand QMD (Quality Memory Database) implementation from the ground up. QMD serves as the foundational memory layer for Smriti, providing content-addressable storage, full-text search, vector embeddings, and LLM-powered recall capabilities.

**Goal**: Understand every architectural decision, implementation detail, and design pattern in QMD to enable confident contributions and debugging.

**Session Categorization**: This session should be tagged as `smriti/qmd` and `topic/architecture` for future recall.

## QMD Architecture Overview

QMD is a sophisticated memory system built on SQLite with three core capabilities:

1. **Content-Addressable Storage** - SHA256-based deduplication
2. **Hybrid Search** - BM25 FTS + vector embeddings + LLM reranking
3. **Conversation Memory** - Session-based message storage with recall

### Key Files (Located at `/Users/zero8/zero8.dev/smriti/qmd/`)

- `src/store.ts` (2571 lines) - Core data access, search, document operations
- `src/memory.ts` (848 lines) - Conversation memory storage & retrieval
- `src/llm.ts` (1208 lines) - LLM abstraction using node-llama-cpp
- `src/ollama.ts` (169 lines) - Ollama HTTP API for synthesis
- `src/collections.ts` (390 lines) - YAML-based collection management

## Learning Session Structure

### Part 1: Database Schema & Content Addressing (30 min)

**Concepts to Explore**:
1. **Content Table** - SHA256-based storage
   - Why content-addressable? (deduplication, referential integrity)
   - Hash collision handling (practically impossible with SHA256)
   - `INSERT OR IGNORE` pattern for automatic dedup

2. **Documents Table** - Virtual filesystem layer
   - Collection-based organization (YAML managed)
   - Soft deletes (`active` column)
   - Path uniqueness constraints

3. **Memory Tables** - Conversation storage
   - `memory_sessions` - Session metadata
   - `memory_messages` - Messages with content hashes
   - Trigger-based FTS updates

**Hands-On Activities**:
- Read `qmd/src/store.ts:100-200` (schema initialization)
- Examine hash function: `qmd/src/store.ts` (search for `hashContent`)
- Trace a message insert: `qmd/src/memory.ts` (find `addMessage`)

**Verification**:
```bash
# Inspect actual database schema
sqlite3 ~/.cache/qmd/index.sqlite ".schema"

# Check content dedup in action
smriti ingest claude  # Ingest sessions
sqlite3 ~/.cache/qmd/index.sqlite "SELECT COUNT(*) FROM content"
sqlite3 ~/.cache/qmd/index.sqlite "SELECT COUNT(DISTINCT hash) FROM memory_messages"
# These should show deduplication working
```

### Part 2: Search Architecture - BM25 Full-Text Search (30 min)

**Concepts to Explore**:
1. **FTS5 Query Building**
   - Term normalization (lowercase, strip special chars)
   - Prefix matching (`*` suffix)
   - Boolean operators (AND/OR)

2. **BM25 Scoring**
   - Score normalization: `1 / (1 + abs(bm25_score))`
   - Why negative scores? (FTS5 convention)
   - Custom weights in `bm25()` function

3. **Trigger-Based FTS Updates**
   - SQLite triggers keep `documents_fts` in sync
   - Performance implications (writes are slower)

**Hands-On Activities**:
- Read FTS query builder: `qmd/src/store.ts` (search for `buildFTS5Query`)
- Read FTS search: `qmd/src/store.ts` (search for `searchDocumentsFTS`)
- Examine triggers: `qmd/src/store.ts` (search for `CREATE TRIGGER`)

**Verification**:
```bash
# Test FTS search
smriti search "vector embeddings" --project smriti

# Compare with exact phrase
smriti search '"vector embeddings"' --project smriti

# Check FTS index size
sqlite3 ~/.cache/qmd/index.sqlite "SELECT COUNT(*) FROM documents_fts"
```

### Part 3: Vector Search & Embeddings (45 min)

**Concepts to Explore**:
1. **Two-Step Query Pattern** (CRITICAL)
   - Why: sqlite-vec hangs on JOINs with `MATCH`
   - Step 1: Query `vectors_vec` directly
   - Step 2: Separate JOIN to get document data

2. **Chunking Strategy**
   - Token-based (not character-based)
   - 800 tokens per chunk, 120 token overlap (15%)
   - Natural break points (paragraph > sentence > line)

3. **Embedding Format** (EmbeddingGemma)
   - Queries: `"task: search result | query: {query}"`
   - Documents: `"title: {title} | text: {content}"`

4. **Storage Schema**
   - `content_vectors` - Metadata table
   - `vectors_vec` - sqlite-vec virtual table
   - `hash_seq` composite key: `"hash_seq"`

**Hands-On Activities**:
- Read chunking logic: `qmd/src/store.ts` (search for `chunkDocumentByTokens`)
- Read vector search: `qmd/src/store.ts` (search for `searchDocumentsVec`)
- Read embedding insertion: `qmd/src/store.ts` (search for `insertEmbedding`)

**Verification**:
```bash
# Build embeddings for a project
smriti embed --project smriti

# Check embedding storage
sqlite3 ~/.cache/qmd/index.sqlite "SELECT COUNT(*) FROM content_vectors"
sqlite3 ~/.cache/qmd/index.sqlite "SELECT COUNT(*) FROM vectors_vec"

# Verify chunking (count chunks per document)
sqlite3 ~/.cache/qmd/index.sqlite "
  SELECT hash, COUNT(*) as chunks
  FROM content_vectors
  GROUP BY hash
  ORDER BY chunks DESC
  LIMIT 10
"
```

### Part 4: Hybrid Search - RRF & Reranking (45 min)

**Concepts to Explore**:
1. **Query Expansion**
   - LLM generates query variants
   - Original query weighted 2x
   - Parallel retrieval per variant

2. **Reciprocal Rank Fusion (RRF)**
   - Formula: `score = Σ(weight/(k+rank+1))` where k=60
   - Top-rank bonus: +0.05 for rank 1, +0.02 for ranks 2-3
   - Why RRF? (Normalizes scores across different retrieval methods)

3. **LLM Reranking** (Qwen3-Reranker)
   - Cross-encoder scoring (0-1 scale)
   - Position-aware blending:
     - Ranks 1-3: 75% retrieval / 25% reranker
     - Ranks 4-10: 60% retrieval / 40% reranker
     - Ranks 11+: 40% retrieval / 60% reranker

4. **Why Position-Aware Blending?**
   - Trust retrieval for exact matches (top ranks)
   - Trust reranker for semantic understanding (lower ranks)
   - Balance precision and recall

**Hands-On Activities**:
- Read RRF implementation: `qmd/src/store.ts` (search for `reciprocalRankFusion`)
- Read reranking logic: `qmd/src/store.ts` (search for `rerankResults`)
- Read hybrid search: `qmd/src/store.ts` (search for `searchDocumentsHybrid`)

**Verification**:
```bash
# Test hybrid search
smriti search "how does vector search work" --project smriti

# Compare with keyword-only
smriti search "vector search" --project smriti --no-vector

# Enable debug logging to see RRF scores
DEBUG=qmd:* smriti search "embeddings" --project smriti
```

### Part 5: LLM Integration & Model Management (30 min)

**Concepts to Explore**:
1. **node-llama-cpp Abstraction**
   - Model loading on-demand
   - Context pooling
   - Inactivity timeout (5 min default)

2. **Three Model Types**
   - Embedding: `embeddinggemma-300M-Q8_0` (~300MB)
   - Reranking: `Qwen3-Reranker-0.6B-Q8_0` (~640MB)
   - Generation: `qmd-query-expansion-1.7B` (~1.1GB)

3. **LRU Cache**
   - SQLite-based response cache
   - Probabilistic pruning (1% chance on hits)
   - Hash-based deduplication

4. **Why GGUF Models?**
   - CPU inference (no GPU required)
   - Quantization reduces memory (Q8_0 = 8-bit)
   - HuggingFace distribution

**Hands-On Activities**:
- Read LLM class: `qmd/src/llm.ts` (read entire file)
- Read cache logic: `qmd/src/store.ts` (search for `llm_cache`)
- Read model loading: `qmd/src/llm.ts` (search for `getModel`)

**Verification**:
```bash
# Check model cache
ls -lh ~/.cache/node-llama-cpp/models/

# Test query expansion (should auto-download model on first run)
DEBUG=qmd:llm smriti search "testing" --project smriti

# Check LLM cache hits
sqlite3 ~/.cache/qmd/index.sqlite "SELECT COUNT(*) FROM llm_cache"
```

### Part 6: Memory System & Recall (30 min)

**Concepts to Explore**:
1. **Session-Based Storage**
   - Sessions = conversations
   - Messages = turns within sessions
   - Metadata JSON field for extensibility

2. **Recall Pipeline**
   - Parallel FTS + vector search
   - RRF fusion
   - Session-level deduplication (keep best score per session)
   - Optional Ollama synthesis

3. **Ollama Integration**
   - HTTP API (not node-llama-cpp)
   - Configurable model (`QMD_MEMORY_MODEL`)
   - Synthesis prompt engineering

**Hands-On Activities**:
- Read `addMessage`: `qmd/src/memory.ts` (search for `addMessage`)
- Read `recallMemories`: `qmd/src/memory.ts` (search for `recallMemories`)
- Read Ollama synthesis: `qmd/src/ollama.ts` (read entire file)

**Verification**:
```bash
# Ingest sessions
smriti ingest claude

# Test recall without synthesis
smriti recall "vector embeddings"

# Test recall with synthesis (requires Ollama running)
ollama serve &
smriti recall "vector embeddings" --synthesize

# Check memory tables
sqlite3 ~/.cache/qmd/index.sqlite "SELECT COUNT(*) FROM memory_sessions"
sqlite3 ~/.cache/qmd/index.sqlite "SELECT COUNT(*) FROM memory_messages"
```

### Part 7: Smriti Extensions to QMD (30 min)

**Concepts to Explore**:
1. **Metadata Tables**
   - `smriti_session_meta` - Agent/project tracking
   - `smriti_categories` - Hierarchical taxonomy
   - `smriti_session_tags` - Category assignments
   - `smriti_shares` - Team knowledge exports

2. **Filtered Search**
   - JOINs QMD tables with Smriti metadata
   - Category/project/agent filters
   - Preserves BM25 scoring

3. **Integration Pattern**
   - Single re-export hub: `src/qmd.ts`
   - No scattered dynamic imports
   - Clean dependency boundary

**Hands-On Activities**:
- Read Smriti schema: `src/db.ts` (search for `CREATE TABLE`)
- Read filtered search: `src/search/index.ts` (search for `searchFiltered`)
- Read QMD integration: `src/qmd.ts` (read entire file)

**Verification**:
```bash
# Test filtered search
smriti search "embeddings" --category code/implementation

# Check Smriti metadata
sqlite3 ~/.cache/qmd/index.sqlite "SELECT * FROM smriti_projects"
sqlite3 ~/.cache/qmd/index.sqlite "SELECT * FROM smriti_categories"

# Verify integration (should not import from QMD directly anywhere except qmd.ts)
grep -r "from ['\"]qmd" src/ --exclude="qmd.ts" || echo "✓ No direct QMD imports"
```

## Key Design Patterns Summary

1. **Content Addressing** - SHA256 deduplication, `INSERT OR IGNORE`
2. **Two-Step Vector Queries** - Avoid sqlite-vec JOIN hangs
3. **Virtual Paths** - `qmd://collection/path` format
4. **LRU Caching** - SQLite-based with probabilistic pruning
5. **Soft Deletes** - `active` column for reversibility
6. **Trigger-Based FTS** - Automatic index updates
7. **YAML Collections** - Config not in SQLite
8. **Token-Based Chunking** - Accurate boundaries via tokenizer
9. **RRF with Top-Rank Bonus** - Preserve exact matches
10. **Position-Aware Blending** - Trust retrieval for top results

## Critical Files to Master

| File | Lines | Purpose |
|------|-------|---------|
| `qmd/src/store.ts` | 2571 | Core data access, search, embeddings |
| `qmd/src/memory.ts` | 848 | Conversation storage & recall |
| `qmd/src/llm.ts` | 1208 | LLM abstraction (node-llama-cpp) |
| `qmd/src/ollama.ts` | 169 | Ollama HTTP API |
| `src/qmd.ts` | ~50 | Smriti's QMD re-export hub |
| `src/db.ts` | ~500 | Smriti metadata schema |
| `src/search/index.ts` | ~300 | Filtered search implementation |

## Post-Session Actions

1. **Tag This Session**:
   ```bash
   # After session completes, categorize it
   smriti categorize --force

   # Verify tagging
   sqlite3 ~/.cache/qmd/index.sqlite "
     SELECT c.name
     FROM smriti_session_tags st
     JOIN smriti_categories c ON c.id = st.category_id
     WHERE st.session_id = '<this-session-id>'
   "
   ```

2. **Share Knowledge**:
   ```bash
   # Export this session to team knowledge
   smriti share --project smriti --segmented

   # Verify export
   ls -lh .smriti/knowledge/
   ```

3. **Update Memory**:
   - Update `/Users/zero8/.claude/projects/-Users-zero8-zero8-dev-smriti/memory/MEMORY.md`
   - Add section: "QMD Implementation Deep Dive (2026-02-12)"
   - Document key insights and gotchas

## Known Issues Discovered

### sqlite-vec Extension Not Loaded in Smriti

**Issue**: The `smriti embed` command fails with "no such module: vec0" error.

**Root Cause**: Smriti's `getDb()` function in `src/db.ts` doesn't load the sqlite-vec extension, but QMD's `embedMemoryMessages()` requires it.

**Fix Required**: Modify `src/db.ts` to load sqlite-vec:
```typescript
import * as sqliteVec from "sqlite-vec";

export function getDb(path?: string): Database {
  if (_db) return _db;
  _db = new Database(path || QMD_DB_PATH);
  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec("PRAGMA foreign_keys = ON");
  sqliteVec.load(_db);  // Add this line
  return _db;
}
```

**Workaround**: For this session, we can still explore all other QMD functionality (search, recall, ingest, categorize). Vector embeddings can be discussed conceptually.

## Expected Outcomes

By the end of this session, you should be able to:

✓ Explain why QMD uses content-addressing (deduplication, efficiency)
✓ Describe the two-step vector query pattern and why it's necessary
✓ Understand RRF scoring and position-aware blending rationale
✓ Debug search quality issues (FTS vs vector vs hybrid)
✓ Optimize chunking parameters for different content types
✓ Extend QMD with custom metadata tables (like Smriti does)
✓ Trace a query from CLI → search → LLM → results
✓ Contribute confidently to QMD or Smriti codebases

## Execution Approach

This is a **learning session**, not an implementation task. The execution will be:

1. **Interactive Exploration**: Read code together, explain concepts, answer questions
2. **Hands-On Verification**: Run commands to see architecture in action
3. **Deep Dives**: Investigate interesting implementation details on request
4. **Knowledge Capture**: Ensure session gets properly tagged for future recall

**No code changes required** - this is pure knowledge acquisition and understanding.
