# Ingest Architecture Refactoring: Separation of Concerns

## Context

**Problem**: The current ingest system violates separation of concerns. Parsers and orchestrators handle:
- Session discovery & project detection
- Message parsing & block extraction
- SQLite persistence + side-car table population
- Elasticsearch parallel writes
- Token accumulation & cost aggregation
- Session metadata updates
- Incremental ingest logic

All mixed together in 600+ line functions.

**Result**: 7 major coupling points making the code hard to test, extend, and maintain.

**Solution**: Refactor into clean layers where **each parser ONLY extracts raw messages** and **persistence happens separately**.

---

## New Architecture: 4 Clean Layers

```
Layer 1: PARSERS (agent-specific extraction only)
├── src/ingest/parsers/claude.ts
├── src/ingest/parsers/codex.ts
├── src/ingest/parsers/cursor.ts
└── src/ingest/parsers/cline.ts
   Output: { session, messages[], blocks[], metadata }

Layer 2: SESSION RESOLVER (project detection, incremental logic)
├── src/ingest/session-resolver.ts
   Input: { session, metadata, projectDir }
   Output: { sessionId, projectId, projectPath, isNew, existing_count }

Layer 3: MESSAGE STORE GATEWAY (unified SQLite + ES writes)
├── src/ingest/store-gateway.ts
   - storeMessage(sessionId, role, content, blocks, metadata)
   - storeSession(sessionId, projectId, title, metadata)
   - storeBlocks(messageId, blocks)
   - storeCosts(sessionId, tokens, duration)
   Output: { messageId, success, errors }

Layer 4: INGEST ORCHESTRATOR (composition layer)
├── src/ingest/index.ts (refactored)
   - Load parser
   - Resolve sessions
   - Store all messages via gateway
   - Aggregate costs
   - Report results
```

**Key principle**: Each layer can be tested independently. Parsers don't know about databases. Store gateway doesn't know about parsing.

---

## Implementation Plan

### Phase 1: Extract Parsers into Pure Functions (No DB Knowledge)

#### 1.1 Refactor `src/ingest/parsers/claude.ts`

**Goal**: Claude parser returns ONLY parsed messages, session info. Zero database calls.

**Current problem (lines 389-625)**:
- 237 lines doing: discovery → parsing → DB writes → ES writes → block extraction → cost aggregation
- Couples parser output to SQLite schema

**New `ingestClaudeSessions()` signature**:
```typescript
export async function parseClaude(
  sessionPath: string,
  projectDir: string
): Promise<{
  session: { id: string; title: string; created_at: string };
  messages: StructuredMessage[];
  metadata: { total_tokens?: number; total_duration_ms?: number };
}>;
```

**What stays in parser**:
- Session discovery: find .jsonl files ✓
- Title derivation: extract from first user message ✓
- Block extraction: analyze content for tool_calls, file_ops, git_ops, errors ✓
- Structured message creation ✓

**What LEAVES parser**:
- ❌ `addMessage(db, ...)` calls → return messages array
- ❌ `ingestMessageToES(...)` calls → let caller decide
- ❌ `insertToolUsage()`, `insertFileOperation()`, etc. → return blocks separately
- ❌ `upsertSessionCosts()` → return metadata with token counts
- ❌ `upsertSessionMeta()` → let caller decide

**Implementation**:
- Rename current `ingestClaude()` → `parseClaude()`
- Remove all DB calls (lines 454-592)
- Return `ParsedSession` interface with messages + blocks + metadata
- Keep block extraction logic (needed for structured output)

**Files to modify**:
- `src/ingest/parsers/claude.ts` - Extract, no DB calls

**Lines deleted**: ~180 lines of DB I/O, ES calls, cost aggregation
**Lines added**: ~50 lines (return ParsedSession interface)
**Net**: Simpler, testable parser

**Effort**: 1.5 hours

---

#### 1.2 Refactor Other Parsers (codex, cursor, cline, copilot)

**Same refactoring for all**:
- `src/ingest/parsers/codex.ts` - Remove DB, ES calls (40 lines deleted)
- `src/ingest/parsers/cursor.ts` - Remove DB, ES calls (30 lines deleted)
- `src/ingest/parsers/cline.ts` - Remove DB, ES calls (30 lines deleted)
- `src/ingest/parsers/copilot.ts` - Remove DB, ES calls (30 lines deleted)
- `src/ingest/parsers/generic.ts` - Remove DB, ES calls (30 lines deleted)

All return same `ParsedSession` interface for consistency.

**Effort**: 2 hours (5 parsers × 24 min each)

**Total Phase 1**: 3.5 hours

---

### Phase 2: Create Session Resolver Layer

#### 2.1 New `src/ingest/session-resolver.ts`

**Purpose**: Take parsed session + project info, resolve database state

**Responsibilities**:
- Derive project_id from projectDir (using existing `deriveProjectId()`)
- Derive project_path from projectDir (using existing `deriveProjectPath()`)
- Check if session already exists in database
- Count existing messages (for incremental ingest)
- Determine if this is a new session or append

**Function signature**:
```typescript
export async function resolveSession(
  db: Database,
  sessionId: string,
  projectDir: string,
  metadata: { total_tokens?: number; total_duration_ms?: number }
): Promise<{
  sessionId: string;
  projectId: string;
  projectPath: string;
  isNew: boolean;
  existingMessageCount: number;
}>;
```

**Uses existing functions**:
- `deriveProjectId()` from `src/ingest/claude.ts` (already exists)
- `deriveProjectPath()` from `src/ingest/claude.ts` (already exists)
- DB query: `SELECT COUNT(*) FROM memory_messages WHERE session_id = ?`
- DB query: `SELECT 1 FROM smriti_session_meta WHERE session_id = ?`

**New file**:
- `src/ingest/session-resolver.ts` (~80 lines)

**Effort**: 1 hour

---

### Phase 3: Create Store Gateway Layer

#### 3.1 New `src/ingest/store-gateway.ts`

**Purpose**: Unified interface for all database writes (SQLite + ES)

**Four functions**:

**Function 1: `storeMessage()`**
```typescript
export async function storeMessage(
  db: Database,
  sessionId: string,
  role: string,
  content: string,
  blocks: Block[],
  metadata?: Record<string, any>
): Promise<{ messageId: string; success: boolean; error?: string }>;
```
- Calls QMD's `addMessage(db, sessionId, role, content, metadata)`
- Captures returned messageId
- Calls `ingestMessageToES()` in parallel (fire & forget)
- Returns messageId + success status

**Function 2: `storeBlocks()`**
```typescript
export async function storeBlocks(
  db: Database,
  messageId: string,
  sessionId: string,
  blocks: Block[]
): Promise<void>;
```
- Iterates blocks and calls existing DB functions:
  - `insertToolUsage()` for tool_call blocks
  - `insertFileOperation()` for file_op blocks
  - `insertCommand()` for command blocks
  - `insertGitOperation()` for git blocks
  - `insertError()` for error blocks
- Centralizes all block storage logic

**Function 3: `storeSession()`**
```typescript
export async function storeSession(
  db: Database,
  sessionId: string,
  agentId: string,
  projectId: string,
  title: string,
  metadata?: { total_tokens?: number; total_duration_ms?: number }
): Promise<void>;
```
- Calls `upsertSessionMeta()` (existing function)
- Calls `ingestSessionToES()` in parallel
- Ensures session metadata is stored once per session (not per message)

**Function 4: `storeCosts()`**
```typescript
export async function storeCosts(
  db: Database,
  sessionId: string,
  tokens: number,
  duration_ms: number
): Promise<void>;
```
- Calls `upsertSessionCosts()` (existing function)
- Aggregates token spend and duration at session level
- Called once after all messages processed

**New file**:
- `src/ingest/store-gateway.ts` (~150 lines, wraps existing DB functions)

**Design benefit**: All DB logic is now in ONE place. Easy to add new persistence layers (Postgres, etc.) without changing parsers.

**Effort**: 1.5 hours

---

### Phase 4: Refactor Main Orchestrator

#### 4.1 Refactor `src/ingest/index.ts`

**Current problem (lines 50-117)**:
- `ingest()` function mixes: discovery → parsing → orchestration → result aggregation
- Uses dynamic imports for each parser (messy)
- Calls parser's ingestClaude/ingestCodex/etc directly

**New flow**:
```typescript
export async function ingest(
  db: Database,
  agentId: string,
  options: IngestOptions
): Promise<IngestResult> {
  // Step 1: Load parser dynamically
  const parser = await loadParser(agentId);

  // Step 2: Get sessions to process
  const sessions = await discoverSessions(agentId, parser);

  let ingested = 0;
  let totalMessages = 0;
  let errors: string[] = [];

  for (const session of sessions) {
    try {
      // Step 3: Parse session (NO DB calls)
      const parsed = await parser.parse(session.path, session.projectDir);

      // Step 4: Resolve session state
      const resolved = await resolveSession(
        db,
        parsed.session.id,
        session.projectDir,
        parsed.metadata
      );

      // Step 5: Store each message through gateway
      for (const message of parsed.messages) {
        const result = await storeMessage(
          db,
          resolved.sessionId,
          message.role,
          message.plainText,
          message.blocks,
          { ...message.metadata, title: parsed.session.title }
        );

        if (result.success && message.blocks.length > 0) {
          await storeBlocks(
            db,
            result.messageId,
            resolved.sessionId,
            message.blocks
          );
        }
      }

      // Step 6: Store session metadata (once, after all messages)
      await storeSession(
        db,
        resolved.sessionId,
        agentId,
        resolved.projectId,
        parsed.session.title,
        parsed.metadata
      );

      // Step 7: Store aggregated costs (once per session)
      if (parsed.metadata.total_tokens || parsed.metadata.total_duration_ms) {
        await storeCosts(
          db,
          resolved.sessionId,
          parsed.metadata.total_tokens || 0,
          parsed.metadata.total_duration_ms || 0
        );
      }

      ingested++;
      totalMessages += parsed.messages.length;
    } catch (err) {
      errors.push(`Session ${session.id}: ${(err as Error).message}`);
      console.warn(`Ingest failed for ${session.id}`, err);
    }
  }

  return {
    agentId,
    sessionsIngested: ingested,
    messagesIngested: totalMessages,
    errors,
  };
}
```

**Key improvements**:
- Clear 7-step flow (discover → parse → resolve → store)
- Each function does ONE thing
- Error handling is per-session, doesn't break entire run
- Session metadata written ONCE (not during loop)
- No DB calls in parsers anymore
- Easy to add new layers (caching, validation, etc.)

**Files to modify**:
- `src/ingest/index.ts` - Rewrite orchestration logic (~150 lines)

**Lines kept**: 30 (discovery logic)
**Lines rewritten**: 70 (main loop)
**Lines removed**: 30 (dynamic imports, calls to old parser functions)
**Lines added**: 20 (calls to new gateway functions)

**Effort**: 1.5 hours

---

### Phase 5: Testing & Documentation

#### 5.1 Write Unit Tests

**Test modules**:
- `test/ingest-parsers.test.ts` - Test each parser returns correct interface
- `test/session-resolver.test.ts` - Test project derivation, increment logic
- `test/store-gateway.test.ts` - Test DB writes go to correct tables
- `test/ingest-orchestrator.test.ts` - Test full flow (mocked DB)

**Each test**:
- Uses in-memory SQLite (no external deps)
- Tests happy path + error cases
- Verifies function outputs match contract

**Effort**: 2 hours

#### 5.2 Update Documentation

**Files to create/modify**:
- `INGEST_ARCHITECTURE.md` - New doc explaining 4-layer design
- `src/ingest/README.md` - Parser interface contract
- Update `CLAUDE.md` - Explain separation of concerns

**Effort**: 1 hour

**Total Phase 5**: 3 hours

---

## Summary of Changes

| Layer | Files | Change | LOC Impact |
|-------|-------|--------|-----------|
| Parser | claude.ts, codex.ts, cursor.ts, cline.ts, copilot.ts, generic.ts | Remove DB/ES calls | -400 lines (deleted), +100 lines (return interface) |
| Resolver | NEW: session-resolver.ts | Extract project detection + incremental logic | +80 lines |
| Gateway | NEW: store-gateway.ts | Unified DB write interface | +150 lines |
| Orchestrator | ingest/index.ts | Refactor main loop | -30 lines, +70 lines rewritten |
| **Net Result** | | Clean layered architecture | +100 net lines, but MUCH cleaner |

---

## Timeline

| Phase | What | Effort | Total |
|-------|------|--------|-------|
| 1 | Extract parsers (6 files) | 3.5h | 3.5h |
| 2 | Create session-resolver | 1h | 4.5h |
| 3 | Create store-gateway | 1.5h | 6h |
| 4 | Refactor orchestrator | 1.5h | 7.5h |
| 5 | Testing + docs | 3h | 10.5h |
| **Total** | | | **~10 hours** |

---

## Why This Refactoring Matters

### Current Problems (BEFORE)
- ❌ Parsers have database dependencies
- ❌ Hard to test parsers in isolation
- ❌ Hard to add new persistence layers (Postgres, Snowflake, etc.)
- ❌ Hard to understand the flow (600+ line functions)
- ❌ Hard to debug (mixing of concerns)
- ❌ Hard to maintain (7 coupling points)

### New Benefits (AFTER)
- ✅ Parsers are pure functions (given path → return messages)
- ✅ Test parsers without database
- ✅ Add new storage backends by extending store-gateway
- ✅ Each layer is ~100-150 lines (readable, understandable)
- ✅ Single place to debug (store-gateway for all writes)
- ✅ Follows dependency inversion principle (parsers don't depend on DB)

---

## Verification Plan

Before/after each phase:

1. **Parser extraction**:
   - [ ] Run `smriti ingest claude` → same number of sessions/messages as before
   - [ ] Check ES indices have data (same count)
   - [ ] Check SQLite has data (same count)

2. **Full refactoring**:
   - [ ] Run `smriti ingest all` → ingests all agents without errors
   - [ ] Run test suite: `bun test` → all tests pass
   - [ ] Check data consistency: ES count ≈ SQLite count
   - [ ] Verify no regressions: same data in both stores

3. **Code quality**:
   - [ ] Each parser < 300 lines (was 600+)
   - [ ] Each function has single responsibility
   - [ ] No circular imports
   - [ ] No global state

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| **Break existing ingest** | Keep old code in parallel during refactor, test both |
| **Lose data** | Test with small dataset first (single agent) |
| **ES writes fail** | Gateway already has fire-and-forget pattern, won't break SQLite |
| **Merge conflicts** | Work on separate files (parsers/, new files in ingest/) |
- [ ] Create `elastic-setup/` folder structure:
  ```
  elastic-setup/
  ├── docker-compose.yml      # ES 8.11.0 + Kibana + setup
  ├── elasticsearch.yml        # ES node configuration
  ├── .env.example             # Env var template (ELASTIC_HOST, ELASTIC_PASSWORD, etc.)
  ├── README.md                # Setup instructions (3 min to running)
  ├── scripts/
  │   ├── setup.sh            # Create indices + templates
  │   ├── seed-data.sh        # (Optional) Load sample sessions
  │   └── cleanup.sh          # Destroy containers
  └── kibana/
      └── dashboards.json     # Pre-built Kibana dashboard (export)
  ```

- [ ] `docker-compose.yml`:
  - Elasticsearch 8.11.0 (single-node, 2GB heap)
  - Kibana 8.11.0 (for judges to inspect data)
  - Auto-generated credentials + certificates
  - Health checks

- [ ] `scripts/setup.sh`:
  - Wait for ES to be healthy
  - Create indices: `smriti_sessions`, `smriti_messages`
  - Create index templates for automatic field mapping
  - Output connection details (host, user, password)

- [ ] `README.md`:
  ```markdown
  # Elasticsearch Setup for Smriti Hackathon

  ## Quick Start (3 minutes)

  1. Clone repo, enter elastic-setup folder
  2. Run: docker-compose up -d
  3. Wait: scripts/setup.sh (waits for ES to be ready)
  4. Access:
     - Elasticsearch: http://localhost:9200 (user: elastic, password: changeme)
     - Kibana: http://localhost:5601

  ## Environment Variables
  - ELASTIC_HOST=localhost:9200
  - ELASTIC_USER=elastic
  - ELASTIC_PASSWORD=<auto-generated>
  - ELASTIC_CLOUD_ID=<optional, for cloud>
  ```

**Files to Create**:
- `elastic-setup/docker-compose.yml`
- `elastic-setup/elasticsearch.yml`
- `elastic-setup/.env.example`
- `elastic-setup/README.md`
- `elastic-setup/scripts/setup.sh`
- `elastic-setup/scripts/cleanup.sh`

**Effort**: 1.5 hours

---

#### 1.2 Elasticsearch Client Library (No Auth Yet)

**Goal**: Minimal ES client that can be toggled on/off via env var

**Tasks**:
- [ ] Create `src/es/client.ts` - Elasticsearch connection
  - Check if `ELASTIC_HOST` env var set
  - If yes: Connect to ES, expose `{ client, indexName }`
  - If no: Return null (parallel ingestion will skip ES writes)

- [ ] Define ES index schema in `src/es/schema.ts`:
  ```ts
  export const SESSION_INDEX = "smriti_sessions";
  export const MESSAGE_INDEX = "smriti_messages";

  export const sessionMapping = {
    properties: {
      session_id: { type: "keyword" },
      agent_id: { type: "keyword" },
      project_id: { type: "keyword" },
      title: { type: "text" },
      summary: { type: "text" },
      created_at: { type: "date" },
      duration_ms: { type: "integer" },
      turn_count: { type: "integer" },
      token_spend: { type: "float" },
      error_count: { type: "integer" },
      categories: { type: "keyword" },
      embedding: { type: "dense_vector", dims: 1536, similarity: "cosine" }
    }
  };
  ```

**Files to Create**:
- `src/es/client.ts` - Connection + null check
- `src/es/schema.ts` - Index definitions
- `src/es/ingest.ts` - Parallel write helper (see 1.4)

**Effort**: 1 hour

---

#### 1.2 Adapter Layer (src/es.ts)

**Goal**: Create a wrapper that mimics QMD's exported functions but hits ES instead

**Why**: Minimal changes to existing code. `src/qmd.ts` becomes a routing layer:
```ts
// src/qmd.ts (modified)
export { addMessage, searchMemoryFTS, searchMemoryVec, recallMemories } from "./es.ts"
```

**Tasks**:
- [ ] Implement `addMessage(sessionId, role, content, metadata)` → ES bulk insert
- [ ] Implement `searchMemoryFTS(query)` → ES query_string
- [ ] Implement `searchMemoryVec(embedding)` → ES dense_vector search
- [ ] Implement `recallMemories(query, synthesize?)` → hybrid search + session dedup
- [ ] Implement metadata helpers (for tool usage, git ops, etc.)

**Example addMessage**:
```ts
export async function addMessage(
  sessionId: string,
  role: "user" | "assistant" | "system",
  content: string,
  metadata?: Record<string, any>
) {
  const doc = {
    session_id: sessionId,
    role,
    content,
    timestamp: new Date(),
    embedding: await generateEmbedding(content),  // Reuse Ollama
    ...metadata
  };

  const client = getEsClient();
  await client.index({
    index: "smriti_messages",
    document: doc
  });
}
```

**Files to Create/Modify**:
- `src/es.ts` - Core ES adapter functions
- `src/qmd.ts` - Change imports to route to ES (keep surface API identical)
- `src/es/embedding.ts` - Reuse Ollama embedding logic from QMD

**Effort**: 2.5 hours

---

#### 1.3 Parallel Ingest (SQLite + Elasticsearch)

**Goal**: When `ELASTIC_HOST` env var set, write to both SQLite (via QMD) and Elasticsearch in parallel

**Why parallel**:
- SQLite ingestion keeps working (zero breaking changes)
- ES gets the same data (judges see dual-write success)
- If ES fails, SQLite succeeds (safe fallback)
- Can test ES independently

**Tasks**:
- [ ] Create `src/es/ingest.ts` - Helper to write messages + sessions to ES
  ```ts
  export async function ingestMessageToES(
    sessionId: string,
    role: string,
    content: string,
    metadata?: Record<string, any>
  ) {
    const esClient = getEsClient();
    if (!esClient) return;  // ES not configured, skip

    const doc = {
      session_id: sessionId,
      role,
      content,
      timestamp: new Date().toISOString(),
      ...metadata
    };

    await esClient.index({
      index: MESSAGE_INDEX,
      document: doc
    });
  }

  export async function ingestSessionToES(sessionMetadata) {
    // Similar for session-level metadata
  }
  ```

- [ ] Modify `src/ingest/index.ts:ingestAgent()` - Add parallel ES write:
  ```ts
  async function ingestAgent(agentId: string, options: IngestOptions) {
    const sessions = await discoverSessions(agentId);
    let ingested = 0;

    for (const session of sessions) {
      if (await sessionExists(session.id)) continue;

      const messages = await parseSessions(session);

      for (const msg of messages) {
        // Write to SQLite (QMD) - unchanged
        await addMessage(msg.sessionId, msg.role, msg.content, msg.metadata);

        // Write to ES in parallel (non-blocking)
        ingestMessageToES(msg.sessionId, msg.role, msg.content, msg.metadata).catch(err => {
          console.warn(`ES ingest failed for ${msg.sessionId}:`, err.message);
          // Don't throw - SQLite succeeded, ES is optional
        });
      }

      ingested++;
    }

    return { agentId, sessionsIngested: ingested };
  }
  ```

- [ ] Modify `src/config.ts` - Add ES env vars:
  ```ts
  export const ELASTIC_HOST = process.env.ELASTIC_HOST || null;
  export const ELASTIC_USER = process.env.ELASTIC_USER || "elastic";
  export const ELASTIC_PASSWORD = process.env.ELASTIC_PASSWORD || "changeme";
  export const ELASTIC_API_KEY = process.env.ELASTIC_API_KEY || null;
  ```

**Key design**:
- `getEsClient()` returns null if `ELASTIC_HOST` not set → parallel ingest is no-op
- ES write is async/non-blocking → doesn't slow down SQLite ingestion
- All error handling is local (one ES failure doesn't break the whole ingest)

**Files to Create/Modify**:
- `src/es/ingest.ts` - New parallel write helpers
- `src/ingest/index.ts` - Add ES write after QMD write
- `src/config.ts` - Add ES env vars
- Keep all parsers unchanged (src/ingest/claude.ts, codex.ts, etc.)

**Effort**: 2 hours

**Total Phase 1: 4.5 hours** (much faster than full auth refactor!)

---

### Phase 2: API & Frontend (Day 2, Hours 5-16)

#### 2.1 Backend API Layer (No Auth Yet)

**Goal**: Expose ES data via HTTP endpoints for React frontend

**Tasks**:
- [ ] Create `src/api/server.ts` - Bun.serve() with /api routes
  ```ts
  import { Bun } from "bun";

  const PORT = 3000;

  Bun.serve({
    port: PORT,
    routes: {
      "/api/sessions": sessionsEndpoint,
      "/api/sessions/:id": sessionDetailEndpoint,
      "/api/search": searchEndpoint,
      "/api/analytics/overview": analyticsOverviewEndpoint,
      "/api/analytics/timeline": analyticsTimelineEndpoint,
      "/api/analytics/tools": toolsEndpoint,
      "/api/analytics/projects": projectsEndpoint,
    }
  });
  ```

- [ ] Implement endpoints:
  - `GET /api/sessions?limit=50&offset=0` - List sessions from ES
  - `GET /api/sessions/:id` - Single session + all messages
  - `POST /api/search` - Query ES with keyword + optional vector search
  - `GET /api/analytics/overview` - Aggregations (total sessions, avg duration, token spend, errors)
  - `GET /api/analytics/timeline` - Time-bucket aggregations (sessions per day, tokens per day for last 30 days)
  - `GET /api/analytics/tools` - Tool usage histogram
  - `GET /api/analytics/projects` - Per-project stats

- [ ] Example endpoint (sessions list):
  ```ts
  async function sessionsEndpoint(req: Request) {
    const url = new URL(req.url);
    const limit = parseInt(url.searchParams.get("limit") ?? "50");
    const offset = parseInt(url.searchParams.get("offset") ?? "0");

    const esClient = getEsClient();
    if (!esClient) {
      return new Response(JSON.stringify({ error: "ES not configured" }), { status: 500 });
    }

    const result = await esClient.search({
      index: "smriti_sessions",
      from: offset,
      size: limit,
      sort: [{ created_at: { order: "desc" } }]
    });

    return new Response(JSON.stringify({
      total: result.hits.total.value,
      sessions: result.hits.hits.map(h => h._source)
    }));
  }
  ```

**Files to Create**:
- `src/api/server.ts` - Main Bun server
- `src/api/endpoints/sessions.ts` - GET /api/sessions, /api/sessions/:id
- `src/api/endpoints/search.ts` - POST /api/search (keyword + optional embedding)
- `src/api/endpoints/analytics.ts` - All /api/analytics/* endpoints

**Effort**: 2 hours

---

#### 2.2 React Web App (Simple Dashboard)

**Goal**: Minimal dashboard to visualize ES data (no auth yet, just UI)

**Architecture**:
```
frontend/
├── index.html           (entry point)
├── App.tsx              (main app, simple nav)
├── pages/
│   ├── Dashboard.tsx    (stats overview)
│   ├── SessionList.tsx  (searchable sessions)
│   ├── SessionDetail.tsx (read-only view)
│   └── Analytics.tsx    (tool usage, timelines)
├── components/
│   ├── StatsCard.tsx
│   ├── SessionCard.tsx
│   └── Chart.tsx
├── hooks/
│   └── useApi.ts        (fetch from /api/*)
└── index.css            (Tailwind)
```

**Key pages**:
- **Dashboard**: 4 stat cards (total sessions, avg duration, token spend, error rate) + timeline chart
- **SessionList**: Searchable table of sessions, click to detail
- **SessionDetail**: Show messages, tool usage, git ops for a session
- **Analytics**: Tool usage pie chart, project breakdown, error rate timeline

**Example Dashboard**:
```tsx
export default function Dashboard() {
  const [stats, setStats] = useState(null);

  useEffect(() => {
    fetch("/api/analytics/overview")
      .then(r => r.json())
      .then(setStats);
  }, []);

  if (!stats) return <div>Loading...</div>;

  return (
    <div className="p-6">
      <h1 className="text-3xl font-bold mb-6">Smriti Analytics</h1>
      <div className="grid grid-cols-4 gap-4">
        <StatsCard label="Sessions" value={stats.total_sessions} />
        <StatsCard label="Avg Duration" value={`${stats.avg_duration_sec}s`} />
        <StatsCard label="Total Tokens" value={stats.total_tokens} />
        <StatsCard label="Error Rate" value={`${(stats.error_rate * 100).toFixed(1)}%`} />
      </div>
    </div>
  );
}
```

**Tech**:
- React 18 + TypeScript (Bun bundling)
- Recharts for charts (simple, zero-config)
- Tailwind CSS
- No auth/routing complexity (just simple pages)

**Files to Create**:
- `frontend/index.html` - Static entry point
- `frontend/App.tsx` - Main component, tab navigation
- `frontend/pages/Dashboard.tsx`
- `frontend/pages/SessionList.tsx`
- `frontend/pages/SessionDetail.tsx`
- `frontend/pages/Analytics.tsx`
- `frontend/components/StatsCard.tsx`
- `frontend/hooks/useApi.ts`
- `frontend/index.css` - Tailwind

**Effort**: 3.5 hours

---

#### 2.3 CLI Integration (API Server Flag)

**Goal**: Add `--api` flag to start API server alongside CLI

**Tasks**:
- [ ] Modify `src/index.ts` - Check for `--api` flag
- [ ] If `--api`: Start `src/api/server.ts` in background
- [ ] Default: CLI works as before (no breaking changes)
- [ ] Example: `smriti ingest claude --api` (or `smriti --api` then `smriti ingest...`)

**Files to Modify**:
- `src/index.ts` - Add --api flag handler

**Effort**: 0.5 hours

**Total Phase 2: 6.5 hours**

---

### Phase 3: Polish & Submission (Day 2, Hours 21-24)

#### 3.1 Demo Script & Video

**Pre-demo setup** (30 min before recording):
- [ ] Start Docker: `cd elastic-setup && docker-compose up -d && bash scripts/setup.sh`
- [ ] Ingest existing Smriti data:
  ```bash
  export ELASTIC_HOST=localhost:9200
  smriti ingest all  # or just "claude" if fast
  ```
- [ ] Verify ES has data: `curl http://localhost:9200/smriti_sessions/_count`
- [ ] Start API server: `smriti --api` (or `bun src/api/server.ts`)
- [ ] Open browser: http://localhost:3000 → dashboard should load

**Demo script** (3 min):
1. **Show setup** (20s)
   - Briefly show docker-compose running
   - Show `curl` output (ES has data)

2. **Dashboard** (30s)
   - Refresh page, show stats cards load (sessions, tokens, errors, duration)
   - Point out that real data from all ingested sessions is shown

3. **Timeline** (20s)
   - Click "Analytics" tab
   - Show timeline chart of sessions per week
   - Explain: "Teams can see productivity trends"

4. **Session browser** (30s)
   - Click "Sessions" tab
   - Search for a known topic (e.g., "bug", "refactor")
   - Click one session → show messages, tool usage, git ops

5. **Explain architecture** (20s)
   - "CLI ingests to both SQLite and Elasticsearch in parallel"
   - "ES powers the analytics API"
   - "React dashboard visualizes shared learning"

- [ ] Record screen capture (QuickTime on macOS, OBS on Linux)
- [ ] Upload to YouTube, get shareable link

**Effort**: 1.5 hours

---

#### 3.2 Documentation & README

**Tasks**:
- [ ] Update `README.md`:
  - New section: "Elasticsearch Edition (Hackathon)"
  - Architecture diagram (SQLite → ES)
  - Setup instructions (ES + env vars)
  - CLI auth flow
  - API endpoint reference

- [ ] Create `ELASTICSEARCH.md`:
  - Index schema explanation
  - Adapter layer design decisions
  - Team isolation model
  - Analytics aggregations

- [ ] Add comments to critical functions (es.ts, api/server.ts)

**Files to Create/Modify**:
- `README.md` - Add ES section
- `ELASTICSEARCH.md` - Technical design
- Inline code comments

**Effort**: 1.5 hours

---

#### 3.3 Final Testing & Polish

**Tasks**:
- [ ] Test end-to-end flow:
  1. `smriti login team-acme`
  2. `smriti ingest claude`
  3. `smriti search "fix bug"`
  4. Open web app at `http://localhost:3000`
  5. Verify dashboard loads, search works, analytics show data

- [ ] Fix any bugs found during testing
- [ ] Ensure API error handling is solid (don't expose ES errors directly)
- [ ] Check web app mobile responsiveness (judges might view on phone)

**Effort**: 1 hour

---

#### 3.4 GitHub & Submission

**Tasks**:
- [ ] Push to GitHub (ensure repo is public, MIT license)
- [ ] Add hackathon-specific badges/mentions to README
- [ ] Create `SUBMISSION.md`:
  ```
  # Smriti: Enterprise Memory for AI Teams

  ## Problem
  Enterprise AI teams lack visibility into agentic coding patterns.
  Teams can't track token spend, error patterns, productivity signals.

  ## Solution
  Smriti migrated to Elasticsearch for enterprise-grade memory management:
  - Team-scoped data (CLI auth)
  - Real-time analytics (token spend, error rates, tool adoption)
  - Hybrid search (keyword + semantic)
  - Web dashboard for CTOs and team leads

  ## Features Used
  - Elasticsearch hybrid search (BM25 + dense vectors)
  - Elasticsearch aggregations (time-series analytics)
  - Elasticsearch team isolation (query scoping)

  ## Demo Video
  [YouTube link]

  ## Code Repository
  https://github.com/zero8dotdev/smriti
  ```

- [ ] Fill out Devpost submission form
- [ ] Add demo video link
- [ ] Double-check: Public repo ✓, OSI license ✓, ~400 words ✓, video ✓

**Effort**: 1 hour

**Total Phase 3: 5 hours**

---

## Timeline

| Phase | What | Time | Hours |
|-------|------|------|-------|
| 1.1 | Elastic setup folder | Day 1, 1-2.5h | 1.5h |
| 1.2 | ES client library | Day 1, 2.5-3.5h | 1h |
| 1.3 | Parallel ingest (SQLite + ES) | Day 1, 3.5-5.5h | 2h |
| **Phase 1 Total** | | **Day 1, 1-5.5h** | **4.5h** |
| 2.1 | API layer (7 endpoints) | Day 2, 1-3h | 2h |
| 2.2 | React frontend (Dashboard + views) | Day 2, 3-6.5h | 3.5h |
| 2.3 | CLI --api flag | Day 2, 6.5-7h | 0.5h |
| **Phase 2 Total** | | **Day 2, 1-7h** | **6.5h** |
| 3.1 | Demo + video | Day 2, 7-8.5h | 1.5h |
| 3.2 | Docs (README + ELASTICSEARCH.md) | Day 2, 8.5-10h | 1.5h |
| 3.3 | Testing + polishing | Day 2, 10-11h | 1h |
| 3.4 | GitHub + submit | Day 2, 11-12h | 1h |
| **Phase 3 Total** | | **Day 2, 7-12h** | **5h** |
| **Grand Total** | | **~16 hours** | |

**Buffer**: 32 hours for interruptions, debugging, sleep, extra polish.

---

## Architectural Decisions

### 1. Parallel Ingest (Not a Replacement)
**Why**: Keeps SQLite working while adding ES.
- SQLite is the primary store (zero breaking changes)
- ES writes happen asynchronously in parallel
- If ES fails, SQLite still succeeds (safe fallback)
- Judges see "dual-write" success (impressive)
- Easy to toggle: `if (esClient) { ingestToES() }` (line-by-line)

### 2. SQLite-First, ES-Aware
**Why**: Fastest to ship.
- Keep all existing ingestion code unchanged
- Add 20-30 lines per parser to call `ingestMessageToES()`
- No schema migration (SQLite stays as-is)
- ES indices are separate (never need to sync back)
- If ES cluster dies, CLI still works

### 3. No Auth in MVP
**Why**: Simplifies scope by 1-2 days.
- All ES data is readable via `/api/*` (no scoping)
- Team isolation added in Phase 2 (post-hackathon)
- Demo still shows multi-agent data (impressive volume)
- Security: Run API on private network only (not public)

### 4. Reuse Ollama for Embeddings
**Why**: Already running, no new deps.
- Call Ollama for vector generation (1536-dim)
- Store in ES `dense_vector` field
- Hybrid search: ES `match` (BM25) + `dense_vector` query

### 5. React Dashboard Over Kibana
**Why**: Shows custom engineering + faster to demo.
- Custom React app controls story (judges like polish)
- Kibana is nice-to-have (Phase 2)
- React renders well on judge's phone/laptop
- Pre-built components (StatsCard, Timeline) fast to code

### 6. Elastic Setup Folder (Reproducibility)
**Why**: Judges need to run it locally.
- `docker-compose.yml` + scripts = 5-min setup
- No cloud credentials needed (local ES)
- Judges can validate data ingestion themselves
- Shows professional packaging

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| **Docker setup (elasticsearch + kibana) slow** | Medium | Pre-build docker-compose.yml + test locally first. Scripts auto-create indices. Should be 5 min. |
| **Parallel ingest causes data duplication** | Low | ES writes are isolated (no shared DB), so dedup is per-store. OK for demo. |
| **Ollama embedding timeout** | Medium | Wrap ES ingest in try/catch, log errors. SQLite write still succeeds. Non-blocking prevents slowdown. |
| **React frontend API errors** | Medium | Test API endpoints manually (`curl http://localhost:3000/api/...`) before React build. |
| **Demo data too small (few sessions)** | Medium | Use existing Smriti data (`smriti ingest all` before demo). Real volume = impressive analytics. |
| **ES query syntax errors** | Medium | Test each endpoint manually. Bun error logs are clear. Fix in-place during demo rehearsal. |
| **GitHub repo structure confusing** | Low | Add `ELASTICSEARCH.md` with folder structure + setup diagram. |

---

## Success Criteria

By end of Day 2, you should have:

✅ **Elasticsearch running locally** (docker-compose.yml + setup scripts)
✅ **ES indices created** (smriti_sessions, smriti_messages with correct mappings)
✅ **Parallel ingest working** (CLI ingests to both SQLite + ES, no errors)
✅ **API server up** (7 endpoints: /api/sessions, /api/sessions/:id, /api/search, /api/analytics/*)
✅ **React dashboard live** (Dashboard page + SessionList + SessionDetail + Analytics pages)
✅ **Demo workflow** (ingest sessions → API returns data → React displays it, 3 min video)
✅ **Public GitHub repo** with elastic-setup/ folder, README, ELASTICSEARCH.md
✅ **Devpost submission** (description + demo video + repo link)

Optional (nice-to-have, if time allows):
- ⭐ GitHub OAuth login (elegant but not required for MVP)
- ⭐ Kibana dashboard pre-built (shows ES native power)
- ⭐ Elasticsearch Agent Builder agent (too ambitious for 48h)
- ⭐ Social media post + blog post

---

## Critical Files to Create/Modify

### New Folders & Files (Essential)

**Elastic Setup** (reproducible for judges):
```
elastic-setup/
├── docker-compose.yml              # ES 8.11.0 + Kibana, auto-setup
├── elasticsearch.yml               # Node config (heap, plugins)
├── .env.example                    # Template for ELASTIC_HOST, password
├── README.md                       # 5-min setup guide
├── scripts/
│   ├── setup.sh                    # Create indices + templates
│   ├── cleanup.sh                  # Destroy containers
│   └── seed-data.sh                # (Optional) Load sample data
└── kibana/
    └── dashboards.json             # (Optional) Pre-built dashboard
```

**Backend (ES client + parallel ingest)**:
```
src/
├── es/
│   ├── client.ts                   # Elasticsearch client (null if ELASTIC_HOST not set)
│   ├── schema.ts                   # Index definitions (smriti_sessions, messages)
│   └── ingest.ts                   # Helper: ingestMessageToES, ingestSessionToES
├── api/
│   ├── server.ts                   # Bun.serve() with /api routes
│   ├── endpoints/
│   │   ├── sessions.ts             # GET /api/sessions, /api/sessions/:id
│   │   ├── search.ts               # POST /api/search
│   │   └── analytics.ts            # GET /api/analytics/overview, timeline, tools, projects
│   └── utils/
│       └── esQuery.ts              # Helper: format ES aggregation queries

frontend/
├── index.html                      # Static entry point
├── App.tsx                         # Main component + tab nav
├── pages/
│   ├── Dashboard.tsx               # Stats cards + timeline
│   ├── SessionList.tsx             # Searchable session table
│   ├── SessionDetail.tsx           # Single session messages + metadata
│   └── Analytics.tsx               # Tool usage, projects, trends
├── components/
│   ├── StatsCard.tsx               # Reusable stat display
│   ├── Chart.tsx                   # Recharts wrapper
│   └── Loading.tsx                 # Loading spinner
├── hooks/
│   └── useApi.ts                   # fetch() wrapper with error handling
└── index.css                       # Tailwind styles
```

### Modified Files
```
src/
├── index.ts                        # Add --api flag (starts API server)
├── config.ts                       # Add ELASTIC_HOST, ELASTIC_USER, ELASTIC_PASSWORD
└── ingest/index.ts                 # After QMD addMessage(), call ingestMessageToES() (fire & forget)

package.json                        # Add @elastic/elasticsearch, react, react-dom, recharts, tailwindcss
```

---

## Deployment

### Development Setup (Local)

```bash
# 1. Set up GitHub OAuth
# Create GitHub App at https://github.com/settings/developers
# - App name: "Smriti Hackathon"
# - Homepage URL: http://localhost:3000
# - Authorization callback URL: http://localhost:3000/api/auth/github/callback
# - Copy CLIENT_ID and CLIENT_SECRET

# 2. Set env vars
export ELASTICSEARCH_CLOUD_ID="<your-cloud-id>"
export ELASTICSEARCH_API_KEY="<your-api-key>"
export GITHUB_CLIENT_ID="<your-client-id>"
export GITHUB_CLIENT_SECRET="<your-client-secret>"
export OLLAMA_HOST="http://127.0.0.1:11434"

# 3. Ingest existing Smriti data
bun src/index.ts ingest all

# 4. Start API server
bun --hot src/index.ts --serve
# Server on :3000, API on :3000/api
```

### Production Deployment (Vercel/Railway)

**Frontend (Vercel)**:
```bash
# 1. Push repo to GitHub
git push origin elastic-hackathon

# 2. Create new Vercel project from GitHub repo
# https://vercel.com/new → select smriti repo

# 3. Set env var:
# VITE_API_URL = https://smriti-api.railway.app

# 4. Deploy (automatic on push)
```

**Backend (Railway or Render)**:
```bash
# 1. Create new project on Railway.app or Render.com
# 2. Connect GitHub repo
# 3. Set environment variables:
# - ELASTICSEARCH_CLOUD_ID (from Elastic Cloud)
# - ELASTICSEARCH_API_KEY (from Elastic Cloud)
# - GITHUB_CLIENT_ID (from GitHub App)
# - GITHUB_CLIENT_SECRET (from GitHub App)
# - OLLAMA_HOST (your local Ollama or cloud)
# - NODE_ENV=production

# 4. Deploy (automatic on push)
```

**Elastic Cloud Setup** (~15 min):
1. Go to https://cloud.elastic.co/registration
2. Create free trial account (credit card required)
3. Create new Elasticsearch deployment (8.11.0, < 4GB RAM)
4. Get Cloud ID and API Key from deployment settings
5. Store in `ELASTICSEARCH_CLOUD_ID` and `ELASTICSEARCH_API_KEY`

**GitHub OAuth Setup** (~5 min):
1. Go to https://github.com/settings/developers/new
2. Create OAuth App:
   - **App name**: Smriti Hackathon
   - **Homepage URL**: `https://smriti-hackathon.vercel.app` (deployed URL)
   - **Authorization callback URL**: `https://smriti-hackathon.vercel.app/api/auth/github/callback`
3. Copy Client ID and Client Secret into Railway/Render env vars

---

### Notes

- **No additional databases needed** — Elasticsearch is the only data store
- **Ollama can be local or cloud** — API server will connect via `OLLAMA_HOST`
- **Vercel frontend is static** — Just React bundle, no secrets
- **Railway/Render backend** — Runs Node.js/Bun server, connects to ES Cloud
- **Total setup time**: ~30 min (Elastic Cloud + GitHub OAuth + Vercel/Railway deploy)

---

## Testing Checklist

Before recording demo:

- [ ] Docker running: `docker-compose ps` (elasticsearch + kibana running)
- [ ] ES healthy: `curl http://localhost:9200/_cat/health` (status: green or yellow)
- [ ] Indices created: `curl http://localhost:9200/_cat/indices` (smriti_sessions, smriti_messages visible)
- [ ] Ingest works: `export ELASTIC_HOST=localhost:9200 && smriti ingest claude` (no errors)
- [ ] Data in ES: `curl http://localhost:9200/smriti_sessions/_count` (returns count > 0)
- [ ] API server starts: `bun src/api/server.ts` (logs "Listening on http://localhost:3000")
- [ ] API endpoints respond:
  - `curl http://localhost:3000/api/analytics/overview` → valid JSON
  - `curl http://localhost:3000/api/sessions` → array of sessions
  - `curl http://localhost:3000/api/sessions/UUID` → single session or 404
- [ ] React app loads: `http://localhost:3000` → Dashboard page visible
- [ ] Dashboard stats visible (total sessions, avg duration, tokens, errors)
- [ ] SessionList page: search works, results appear
- [ ] SessionDetail: click session, messages appear
- [ ] Analytics page: timeline + tool usage chart render
- [ ] No 500 errors in browser console or server logs
- [ ] Refresh page (React state persists via API calls)

---

## Roadmap (Post-Hackathon)

If submission is successful, next priorities:

**Phase 2 (Short-term)**:
- Team authentication (GitHub OAuth or API keys)
- Team isolation via query filtering
- Persisted saved searches
- Email alerts on anomalies

**Phase 3 (Medium-term)**:
- Elasticsearch Agent Builder agents:
  - "Anomaly Scout" - Detects unusual session patterns
  - "Code Quality Advisor" - Suggests improvements based on patterns
- Kibana dashboard export (native ES visualization)
- Time-series alerting (token spike, error rate increase)

**Phase 4 (Long-term)**:
- Multi-org support (SaaS model)
- Role-based access control (admin, analyst, viewer)
- Audit logs (who accessed what)
- Cost optimization (ES index size reduction, archival)
- Mobile app (read-only dashboard)
