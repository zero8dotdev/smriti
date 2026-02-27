# Search & Recall: Architecture, Findings, and Improvement Plan

## Table of Contents

1. [Current Architecture](#current-architecture)
2. [Execution Paths](#execution-paths)
3. [Component Deep Dive](#component-deep-dive)
4. [Findings & Gaps](#findings--gaps)
5. [Improvement Plan](#improvement-plan)

---

## Current Architecture

### System Layers

```
┌─────────────────────────────────────────────────────────────┐
│  CLI Layer (src/index.ts)                                   │
│  Parse args → route to search/recall → format output        │
├─────────────────────────────────────────────────────────────┤
│  Smriti Layer (src/search/)                                 │
│  Metadata filtering (project, category, agent)              │
│  Session dedup, synthesis delegation                        │
│  searchFiltered() — dynamic SQL with EXISTS subqueries      │
├─────────────────────────────────────────────────────────────┤
│  QMD Layer (qmd/src/memory.ts, qmd/src/store.ts)           │
│  BM25 FTS5 search (searchMemoryFTS)                        │
│  Vector search (searchMemoryVec — EmbeddingGemma)           │
│  RRF fusion (reciprocalRankFusion)                         │
│  Ollama synthesis (ollamaRecall)                           │
├─────────────────────────────────────────────────────────────┤
│  Storage Layer (SQLite)                                     │
│  memory_fts (FTS5)    — full-text index                    │
│  vectors_vec (vec0)   — cosine similarity via sqlite-vec   │
│  content_vectors      — chunk metadata (hash, seq, pos)    │
│  smriti_session_meta  — project/agent per session          │
│  smriti_*_tags        — category tags on messages/sessions │
└─────────────────────────────────────────────────────────────┘
```

### Model Stack

| Model | Runtime | Size | Purpose | Used In |
|-------|---------|------|---------|---------|
| EmbeddingGemma 300M (Q8_0) | node-llama-cpp | ~300MB | Dense vector embeddings | `smriti embed`, vector search |
| Qwen3-Reranker 0.6B (Q8_0) | node-llama-cpp | ~640MB | Cross-encoder reranking | `qmd query` only — **NOT used in smriti** |
| qmd-query-expansion 1.7B | node-llama-cpp | ~1.1GB | Query expansion (lex/vec/hyde) | `qmd query` only — **NOT used in smriti** |
| qwen3:8b-tuned | Ollama (HTTP) | ~4.7GB | Synthesis, summarization, classification | `smriti recall --synthesize`, `smriti share`, `smriti categorize --llm` |

---

## Execution Paths

### `smriti search "query"` — Always FTS-Only

```
index.ts:210 → searchFiltered(db, query, filters)
                │
                ├─ Build dynamic SQL:
                │   FROM memory_fts mf
                │   JOIN memory_messages mm ON mm.rowid = mf.rowid
                │   JOIN memory_sessions ms ON ms.id = mm.session_id
                │   LEFT JOIN smriti_session_meta sm
                │   WHERE mf.content MATCH ?
                │     AND EXISTS(...category filter...)
                │     AND EXISTS(...project filter...)
                │     AND EXISTS(...agent filter...)
                │   ORDER BY (1/(1+ABS(bm25(memory_fts)))) DESC
                │   LIMIT ?
                │
                └─ Return SearchResult[] → formatSearchResults()
```

**Retrieval**: BM25 only, no vector, no RRF, no reranking.

### `smriti recall "query"` — Two Branches

```
recall.ts:40 → hasFilters = category || project || agent

┌──────────────────────────────────────────────────────────────┐
│  Branch A: No Filters → QMD Native (full hybrid)            │
│                                                              │
│  recallMemories(db, query, opts)                             │
│    ├─ searchMemoryFTS() → BM25 results                      │
│    ├─ searchMemoryVec() → vector results (EmbeddingGemma)    │
│    ├─ reciprocalRankFusion([fts, vec], [1.0, 1.0])           │
│    ├─ Session dedup (one best per session)                   │
│    └─ [if --synthesize] ollamaRecallSynthesize()             │
├──────────────────────────────────────────────────────────────┤
│  Branch B: With Filters → FTS Only (loses vectors!)         │
│                                                              │
│  searchFiltered(db, query, filters)                          │
│    └─ Same SQL as search command                             │
│  Session dedup via Map<session_id, boolean>                  │
│  [if --synthesize] synthesizeResults() → ollamaRecall()      │
└──────────────────────────────────────────────────────────────┘
```

### Data Flow Through RRF (Unfiltered Recall)

```
FTS Results (ranked by BM25):         Vector Results (ranked by cosine):
  rank 0: msg_A (score 0.85)            rank 0: msg_C (score 0.92)
  rank 1: msg_B (score 0.71)            rank 1: msg_A (score 0.88)
  rank 2: msg_C (score 0.65)            rank 2: msg_D (score 0.76)

RRF (k=60, weights [1.0, 1.0]):
  msg_A: 1/61 + 1/62          = 0.0326  (in both lists!)
  msg_C: 1/63 + 1/61          = 0.0322  (in both lists!)
  msg_B: 1/62                 = 0.0161  (FTS only)
  msg_D: 1/63                 = 0.0159  (vec only)

After top-rank bonus:
  msg_A: 0.0326 + 0.05 = 0.0826  ← rank 0 in FTS
  msg_C: 0.0322 + 0.05 = 0.0822  ← rank 0 in vec
  msg_B: 0.0161 + 0.02 = 0.0361  ← rank 1 in FTS
  msg_D: 0.0159 + 0.02 = 0.0359  ← rank 2 in vec

Final: A > C > B > D
```

The top-rank bonus (+0.05) dominates — being #1 in either list is worth 3x a single rank contribution.

---

## Component Deep Dive

### 1. FTS5 Query Building

**QMD's `buildMemoryFTS5Query()`** (used in unfiltered recall):
```typescript
// "how to configure auth" → '"how"* AND "to"* AND "configure"* AND "auth"*'
sanitizeMemoryFTSTerm(t) → strip non-alphanumeric, lowercase
terms.map(t => `"${t}"*`).join(' AND ')  // prefix match + boolean AND
```

**Smriti's `searchFiltered()`** (used in filtered search/recall):
```typescript
// Raw user input passed directly to MATCH
conditions.push(`mf.content MATCH ?`);
params.push(query);  // NO sanitization, NO prefix matching
```

### 2. BM25 Scoring

```sql
-- QMD (unfiltered): weighted columns
bm25(memory_fts, 5.0, 1.0, 1.0)  -- title=5x, role=1x, content=1x

-- Smriti (filtered): unweighted
bm25(memory_fts)                  -- equal weights on all columns
```

Both normalize to `(0, 1]`: `score = 1 / (1 + |bm25_score|)`

### 3. Vector Search (Two-Step Pattern)

```
Step 1: Query vectors_vec directly (NO JOINs — sqlite-vec hangs)
  SELECT hash_seq, distance FROM vectors_vec
  WHERE embedding MATCH ? AND k = ?
  → Returns hash_seq keys like "abc123_0" (hash + chunk index)

Step 2: Normal SQL JOIN using collected hashes
  SELECT m.*, cv.hash || '_' || cv.seq as hash_seq
  FROM memory_messages m
  JOIN content_vectors cv ON cv.hash = m.hash
  WHERE m.hash IN (?) AND s.active = 1

Step 3: Deduplicate by message_id (best distance per message)
  score = 1 - cosine_distance  → range [0, 1]
```

### 4. Embedding Format

```typescript
// Queries: asymmetric task prefix
"task: search result | query: how to configure auth"

// Documents: title + text prefix
"title: Setting up OAuth | text: To configure OAuth2..."
```

Chunking: 800 tokens/chunk, 15% overlap (120 tokens). Token-based via actual model tokenizer.

### 5. Synthesis Prompt

```
System: "You are a memory recall assistant. Given a query and relevant
past conversation memories, synthesize the memories into useful context
for answering the query. Be concise and focus on information directly
relevant to the query. If memories contain contradictory information,
note the most recent. Output only the synthesized context, no preamble."

User: "Query: {query}\n\nRelevant memories:\n
[Session: title]\nrole: content\n---\n
[Session: title]\nrole: content"
```

Temperature 0.3, max 1024 tokens, via Ollama `/api/chat`.

---

## Findings & Gaps

### Critical Issues

#### F1. Filtered recall loses vector search entirely

**Impact**: High — most real-world recall uses filters.

When any filter (`--project`, `--category`, `--agent`) is set, `recall()` falls back to `searchFiltered()` which is FTS-only. The hybrid FTS+vector+RRF pipeline is completely bypassed.

This means `smriti recall "auth flow" --project myapp` only does keyword matching. Semantic matches ("login mechanism" for "auth flow") are lost.

**Root cause**: The two-step sqlite-vec pattern cannot be easily combined with Smriti's `EXISTS` subqueries on metadata tables. Nobody has built the bridge.

#### F2. `searchFiltered()` does not sanitize FTS queries

**Impact**: Medium — FTS5 syntax errors on special characters.

QMD's `searchMemoryFTS` passes queries through `buildMemoryFTS5Query()` which strips special chars, lowercases, and adds prefix matching. Smriti's `searchFiltered` passes raw user input to `MATCH`. Queries containing FTS5 operators (`*`, `"`, `NEAR`, `OR`, `NOT`) may cause parse errors or unintended behavior.

#### F3. `searchFiltered()` does not use BM25 column weights

**Impact**: Medium — title matches are not boosted.

QMD uses `bm25(memory_fts, 5.0, 1.0, 1.0)` (title weighted 5x). Smriti uses `bm25(memory_fts)` (equal weights). Session title matches don't get the boost they deserve in filtered search.

#### F4. Error handling asymmetry in synthesis

**Impact**: Medium — inconsistent UX.

- Filtered path: `synthesizeResults()` has `try/catch`, silently returns `undefined`
- Unfiltered path: `recallMemories()` has NO `try/catch` around `ollamaRecallSynthesize()` — Ollama failure crashes the CLI with exit code 1

#### F5. No timeout on Ollama calls in recall

**Impact**: Medium — CLI hangs indefinitely.

`ollamaChat()` uses raw `fetch()` with no `AbortSignal.timeout()`. A slow or unresponsive Ollama server hangs the CLI forever. Compare with `reflect.ts` which uses a 120-second `AbortController`.

#### F6. `searchFiltered()` does not filter inactive sessions

**Impact**: Low — returns deleted/inactive sessions.

QMD's `searchMemoryFTS` filters `s.active = 1`. Smriti's `searchFiltered` has no such filter. Deleted sessions appear in filtered results.

### Missing Capabilities

#### M1. Reranker not used in recall

QMD has a Qwen3-Reranker 0.6B cross-encoder model that significantly improves result quality. It's used in `qmd query` but never in `smriti recall`. The reranker sees query+document pairs together, catching relevance signals that embedding similarity and BM25 miss independently.

#### M2. Query expansion not used in recall

QMD has a query expansion model (1.7B) that generates lexical synonyms, vector-optimized reformulations, and hypothetical document expansions (HyDE). It's used in `qmd query` but never in `smriti recall`. This means recall misses vocabulary gaps (user says "auth", relevant content says "authentication token management").

#### M3. No search result provenance/explanation

Results show `[0.847]` score but no indication of *why* a result ranked high. Was it a title match? Content keyword? Semantic similarity? Understanding provenance helps users refine queries.

#### M4. No multi-message context in results

Search returns individual messages truncated to 200 chars. A message saying "yes, let's do that" is useless without the preceding context. No mechanism to include surrounding messages.

#### M5. `smriti search` never uses vector search

The `search` command always goes through `searchFiltered()` which is FTS-only. There's no `--hybrid` or `--vector` flag to enable semantic search.

#### M6. Sequential FTS+vec in `recallMemories()` — not parallel

```typescript
const ftsResults = searchMemoryFTS(db, query, limit);     // sync
vecResults = await searchMemoryVec(db, query, limit);      // async, waits
```

FTS is synchronous and vec is async, but they run sequentially. FTS could be wrapped in a microtask and both run in parallel.

---

## Improvement Plan

### Phase 1: Fix Critical Gaps (Correctness & Reliability)

#### P1.1 — Sanitize FTS queries in `searchFiltered()`

**Addresses**: F2

Import and use `buildMemoryFTS5Query()` pattern in `searchFiltered()`:
```typescript
import { buildFTS5Query } from "./query-utils";  // extract from QMD or reimplement

const ftsQuery = buildFTS5Query(query);
if (!ftsQuery) return [];
conditions.push(`mf.content MATCH ?`);
params.push(ftsQuery);  // sanitized, prefix-matched, AND-joined
```

**Effort**: Small. Extract the 15-line function, wire it in.

#### P1.2 — Add BM25 column weights to `searchFiltered()`

**Addresses**: F3

```sql
-- Before:
(1.0 / (1.0 + ABS(bm25(memory_fts)))) AS score

-- After:
(1.0 / (1.0 + ABS(bm25(memory_fts, 5.0, 1.0, 1.0)))) AS score
```

**Effort**: One-line change.

#### P1.3 — Filter inactive sessions in `searchFiltered()`

**Addresses**: F6

Add `AND ms.active = 1` to the WHERE clause (or as a default condition).

**Effort**: One-line change.

#### P1.4 — Add timeout to Ollama calls in recall

**Addresses**: F5

```typescript
const resp = await fetch(`${OLLAMA_HOST}/api/chat`, {
  signal: AbortSignal.timeout(60_000),  // 60-second timeout
  ...
});
```

**Effort**: Small. One line per callsite. Consider adding to `ollamaChat()` itself in QMD.

#### P1.5 — Fix synthesis error handling asymmetry

**Addresses**: F4

Wrap the synthesis call in `recallMemories()` with try/catch to match filtered path behavior:
```typescript
if (options.synthesize && results.length > 0) {
  try {
    synthesis = await ollamaRecallSynthesize(query, memoriesText, opts);
  } catch {
    // Synthesis failure should not crash recall
  }
}
```

**Effort**: 3-line change in QMD's memory.ts.

---

### Phase 2: Hybrid Filtered Search (High-Value)

#### P2.1 — Add vector search to filtered recall

**Addresses**: F1 (the biggest gap)

The core challenge: `searchMemoryVec()` returns results without Smriti metadata, and sqlite-vec's two-step pattern can't be combined with `EXISTS` subqueries.

**Approach**: Post-filter strategy — run vector search unfiltered, then filter results against Smriti metadata.

```typescript
export async function recallFiltered(
  db: Database,
  query: string,
  filters: SearchFilters,
  options: RecallOptions
): Promise<RecallResult> {
  // 1. Run both searches
  const ftsResults = searchFilteredFTS(db, query, filters);
  const vecResults = await searchMemoryVec(db, query, limit * 3);  // overfetch

  // 2. Post-filter vector results against metadata
  const filteredVec = postFilterByMetadata(db, vecResults, filters);

  // 3. RRF fusion
  const fused = reciprocalRankFusion(
    [toRanked(ftsResults), toRanked(filteredVec)],
    [1.0, 1.0]
  );

  // 4. Session dedup + synthesis (same as unfiltered path)
  ...
}
```

**Post-filter implementation**:
```typescript
function postFilterByMetadata(
  db: Database,
  results: MemorySearchResult[],
  filters: SearchFilters
): MemorySearchResult[] {
  if (results.length === 0) return [];

  // Batch-check metadata for all result session IDs
  const sessionIds = [...new Set(results.map(r => r.session_id))];
  const metaMap = loadSessionMetaBatch(db, sessionIds);

  return results.filter(r => {
    const meta = metaMap.get(r.session_id);
    if (filters.project && meta?.project_id !== filters.project) return false;
    if (filters.agent && meta?.agent_id !== filters.agent) return false;
    if (filters.category) {
      const tags = loadMessageTags(db, r.message_id);
      if (!tags.some(t => matchesCategory(t, filters.category!))) return false;
    }
    return true;
  });
}
```

**Trade-offs**:
- Pro: No changes to QMD's vector search internals
- Pro: Metadata filtering is a simple SQL lookup
- Con: Vector search fetches results that may be filtered out (hence 3x overfetch)
- Con: Category filtering requires per-message tag lookup (batch-able)

**Effort**: Medium. New function in `src/search/index.ts`, modify `recall()` routing.

#### P2.2 — Add `--hybrid` flag to `smriti search`

**Addresses**: M5

Allow `smriti search "query" --hybrid` to use the same FTS+vector+RRF pipeline as recall (minus session dedup and synthesis). Default stays FTS-only for speed.

```typescript
case "search": {
  if (hasFlag(args, "--hybrid")) {
    const results = await searchHybrid(db, query, filters);
  } else {
    const results = searchFiltered(db, query, filters);
  }
}
```

**Effort**: Medium. Reuses P2.1's infrastructure.

---

### Phase 3: Quality Improvements

#### P3.1 — Integrate reranker into recall

**Addresses**: M1

After RRF fusion, pass the top-N results through the Qwen3 reranker for precision reranking:

```typescript
// After RRF fusion, before session dedup
const fusedResults = reciprocalRankFusion([fts, vec], [1.0, 1.0]);

if (options.rerank !== false) {  // opt-out via --no-rerank
  const llm = getDefaultLlamaCpp();
  const reranked = await llm.rerank(query, fusedResults.map(r => ({
    file: r.file,
    text: r.body,
  })));
  // Replace RRF scores with reranker scores
  // Proceed to session dedup with reranked order
}
```

**Trade-offs**:
- Pro: Significant quality improvement — cross-encoder sees query+document together
- Con: Adds ~500ms-2s latency (model inference per result)
- Con: Requires EmbeddingGemma model to be loaded (already loaded for vector search)

**Mitigation**: Make reranking opt-in (`--rerank`) initially, later default-on after benchmarking.

**Effort**: Medium. Import `rerank` from QMD's llm.ts, wire into recall pipeline.

#### P3.2 — Add query expansion

**Addresses**: M2

Use QMD's query expansion model to generate alternative query forms before search:

```typescript
const llm = getDefaultLlamaCpp();
const expanded = await llm.expandQuery(query);
// expanded = { lexical: ["auth", "authentication", "login"],
//              vector: "user authentication and login flow",
//              hyde: "To set up auth, configure the OAuth2 provider..." }

// Use expanded.lexical for FTS (OR-join synonyms)
// Use expanded.vector for vector search embedding
// Use expanded.hyde for a second vector search pass
```

**Trade-offs**:
- Pro: Bridges vocabulary gaps ("auth" → "authentication", "login")
- Con: Adds ~1-3s latency for model inference
- Con: Requires the 1.7B model to be loaded

**Mitigation**: Cache expanded queries in `llm_cache` (QMD already does this). Make opt-in (`--expand`) initially.

**Effort**: Medium-Large. Need to modify FTS query building to support OR-joined synonyms, run multiple vector searches.

#### P3.3 — Add multi-message context window

**Addresses**: M4

When displaying results, include N surrounding messages from the same session:

```typescript
function expandContext(
  db: Database,
  result: SearchResult,
  windowSize: number = 2
): ExpandedResult {
  const messages = db.prepare(`
    SELECT role, content FROM memory_messages
    WHERE session_id = ? AND id BETWEEN ? AND ?
    ORDER BY id
  `).all(result.session_id, result.message_id - windowSize, result.message_id + windowSize);

  return { ...result, context: messages };
}
```

Display as:
```
[0.847] Setting up OAuth authentication
  ... (2 messages before)
  user: How should we handle the refresh token?
  >>> assistant: To configure OAuth2 with PKCE, first install the auth...  ← matched
  user: What about token rotation?
  ... (1 message after)
```

**Effort**: Small-Medium. New function + format update.

#### P3.4 — Result source indicators

**Addresses**: M3

Show why a result ranked high:

```
[0.083 fts+vec] Setting up OAuth authentication    ← appeared in both lists
  assistant: To configure OAuth2...

[0.036 fts] API design session                     ← keyword match only
  user: How should we structure...

[0.034 vec] Login flow discussion                  ← semantic match only
  assistant: The authentication mechanism...
```

**Effort**: Small. Track source in RRF fusion, pass through to formatter.

---

### Phase 4: Performance

#### P4.1 — Parallelize FTS and vector search

**Addresses**: M6

```typescript
// Before (sequential):
const ftsResults = searchMemoryFTS(db, query, limit);
const vecResults = await searchMemoryVec(db, query, limit);

// After (parallel):
const [ftsResults, vecResults] = await Promise.all([
  Promise.resolve(searchMemoryFTS(db, query, limit)),
  searchMemoryVec(db, query, limit).catch(() => []),
]);
```

**Effort**: Tiny. One-line refactor.

#### P4.2 — Batch metadata lookups for post-filtering

When post-filtering vector results (P2.1), batch all session metadata lookups into a single SQL query:

```typescript
function loadSessionMetaBatch(
  db: Database,
  sessionIds: string[]
): Map<string, { project_id: string; agent_id: string }> {
  const placeholders = sessionIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT session_id, project_id, agent_id
    FROM smriti_session_meta
    WHERE session_id IN (${placeholders})
  `).all(...sessionIds);
  return new Map(rows.map(r => [r.session_id, r]));
}
```

**Effort**: Small. Part of P2.1.

#### P4.3 — Fix O(N*M) find() in `recallMemories()` session dedup

```typescript
// Before: O(N*M) linear scan per result
const original = [...ftsResults, ...vecResults].find(
  (o) => `${o.session_id}:${o.message_id}` === r.file
);

// After: O(1) Map lookup
const originalMap = new Map<string, MemorySearchResult>();
for (const r of [...ftsResults, ...vecResults]) {
  const key = `${r.session_id}:${r.message_id}`;
  if (!originalMap.has(key)) originalMap.set(key, r);
}
// ... in loop:
const original = originalMap.get(r.file);
```

**Effort**: Tiny. QMD-side change.

---

### Implementation Priority

| Phase | Item | Impact | Effort | Priority |
|-------|------|--------|--------|----------|
| 1 | P1.1 Sanitize FTS queries | Correctness | Small | **Now** |
| 1 | P1.2 BM25 column weights | Quality | Tiny | **Now** |
| 1 | P1.3 Filter inactive sessions | Correctness | Tiny | **Now** |
| 1 | P1.4 Ollama timeout | Reliability | Small | **Now** |
| 1 | P1.5 Synthesis error handling | Reliability | Tiny | **Now** |
| 2 | P2.1 Hybrid filtered recall | **Quality** | Medium | **Next** |
| 2 | P2.2 `--hybrid` search flag | Quality | Medium | **Next** |
| 3 | P3.1 Reranker in recall | Quality | Medium | Later |
| 3 | P3.2 Query expansion | Quality | Med-Large | Later |
| 3 | P3.3 Multi-message context | UX | Small-Med | Later |
| 3 | P3.4 Source indicators | UX | Small | Later |
| 4 | P4.1 Parallel FTS+vec | Performance | Tiny | **Next** |
| 4 | P4.2 Batch metadata lookups | Performance | Small | **Next** |
| 4 | P4.3 Fix O(N*M) dedup | Performance | Tiny | Later |

### Recommended Execution Order

1. **Quick wins** (P1.1–P1.5, P4.1): Fix all correctness/reliability issues. ~1 session.
2. **Hybrid filtered recall** (P2.1, P4.2): The single highest-value improvement. ~1 session.
3. **Search parity** (P2.2): Expose hybrid search to `search` command. ~0.5 session.
4. **Quality stack** (P3.1, P3.4): Reranker + source indicators. ~1 session.
5. **Context & expansion** (P3.3, P3.2): Multi-message context, query expansion. ~1-2 sessions.

---

### Architecture After All Phases

```
smriti search "query" [--hybrid]
  ├─ [default] searchFiltered() — sanitized FTS, weighted BM25, active filter
  └─ [--hybrid] searchHybrid()
       ├─ searchFilteredFTS()
       ├─ searchMemoryVec() + postFilterByMetadata()
       └─ reciprocalRankFusion()

smriti recall "query" [--project X] [--synthesize] [--rerank] [--expand]
  ├─ [--expand] expandQuery() → lexical + vector + HyDE forms
  ├─ searchFilteredFTS() or searchMemoryFTS()
  ├─ searchMemoryVec() + [if filtered] postFilterByMetadata()
  ├─ reciprocalRankFusion([fts, vec], [1.0, 1.0])
  ├─ [--rerank] llm.rerank(query, topResults)
  ├─ Session dedup (Map-based, O(1) lookup)
  ├─ [--context N] expandContext() — surrounding messages
  └─ [--synthesize] ollamaRecall() — with timeout + error handling
```

Both commands use the same retrieval pipeline with different defaults:
- `search`: FTS-only by default (fast), `--hybrid` for quality
- `recall`: Always hybrid (quality), session-deduped, optional synthesis
- Filters always work with full hybrid pipeline (no capability loss)
- Reranker and query expansion are opt-in quality boosters
