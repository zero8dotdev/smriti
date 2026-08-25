/**
 * memory.ts - Conversation memory storage & retrieval for Smriti
 *
 * Stores conversation messages in sessions, provides FTS5 + vector search,
 * summarization via Ollama, and memory recall for LLM context.
 *
 * Reuses QMD's existing infrastructure:
 * - content_vectors + vectors_vec tables for embeddings
 * - hashContent() for content-addressable storage
 * - chunkDocumentByTokens() for chunking
 * - insertEmbedding() for vector storage
 * - BM25 normalization pattern from searchFTS
 * - Two-step vector search pattern from searchVec
 * - reciprocalRankFusion() for combining results
 */

import type { Database } from "../qmd/src/db";
import {
  hashContent,
  chunkDocumentByTokens,
  reciprocalRankFusion,
  formatQueryForEmbedding,
  formatDocForEmbedding,
  type RankedResult,
} from "../qmd/src/store.js";
import { getQmdStore } from "./store";
import { ollamaSummarize, ollamaRecall as ollamaRecallSynthesize } from "./ollama";

// Returns the LLM instance from the SDK store (set during initSmriti).
// Throws if called before initSmriti() — only vector search + embed paths use this.
function getMemoryLlm() {
  return getQmdStore().internal.llm!;
}

// =============================================================================
// Types
// =============================================================================

export type MemorySession = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  summary: string | null;
  summary_at: string | null;
  active: number;
};

export type MemoryMessage = {
  id: number;
  session_id: string;
  role: string;
  content: string;
  hash: string;
  created_at: string;
  metadata: Record<string, unknown> | null;
};

export type MemorySearchResult = {
  session_id: string;
  session_title: string;
  message_id: number;
  role: string;
  content: string;
  score: number;
  source: "fts" | "vec";
};

type RecallTimings = {
  ftsMs: number;
  vecMs: number;
  fuseMs: number;
  dedupeMs: number;
  totalMs: number;
};

// =============================================================================
// Schema Initialization
// =============================================================================

/**
 * Create memory tables, indexes, triggers in the QMD database.
 * Safe to call multiple times (uses IF NOT EXISTS).
 */
export function initializeMemoryTables(db: Database): void {
  // Sessions table
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      summary TEXT,
      summary_at TEXT,
      active INTEGER NOT NULL DEFAULT 1
    )
  `);

  // Messages table
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      metadata TEXT,
      FOREIGN KEY (session_id) REFERENCES memory_sessions(id) ON DELETE CASCADE
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_messages_session ON memory_messages(session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_messages_hash ON memory_messages(hash)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_sessions_active ON memory_sessions(active, id)`);

  // FTS5 for memory search
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      session_title, role, content,
      tokenize='porter unicode61'
    )
  `);

  // Triggers to sync memory_fts
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memory_messages_ai AFTER INSERT ON memory_messages
    BEGIN
      INSERT INTO memory_fts(rowid, session_title, role, content)
      SELECT
        new.id,
        (SELECT title FROM memory_sessions WHERE id = new.session_id),
        new.role,
        new.content;
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memory_messages_ad AFTER DELETE ON memory_messages
    BEGIN
      DELETE FROM memory_fts WHERE rowid = old.id;
    END
  `);
}

// =============================================================================
// FTS5 Query Building (same pattern as store.ts buildFTS5Query)
// =============================================================================

/**
 * Build an FTS5 MATCH expression from a user query.
 *
 * Splits on everything the `porter unicode61` tokenizer treats as a boundary,
 * so a query tokenizes the same way the indexed text did. Without this,
 * punctuation either matched nothing ("2026.4.10" collapsed to "2026410", but
 * the index holds "2026"/"4"/"10") or leaked into FTS5's own grammar
 * ("node-llama-cpp" parsed "llama" as a column name).
 *
 * Exported so `searchFiltered` builds its MATCH the same way.
 */
export function buildMemoryFTS5Query(query: string): string | null {
  const terms = query
    .split(/[^\p{L}\p{N}']+/u)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 0);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t}"*`).join(" AND ");
}

// =============================================================================
// Session CRUD
// =============================================================================

/**
 * Create a new memory session. If id is "new", generates a random ID.
 */
export function createSession(
  db: Database,
  id: string,
  title: string = ""
): MemorySession {
  const now = new Date().toISOString();
  const sessionId = id === "new" ? crypto.randomUUID().slice(0, 8) : id;

  db.prepare(
    `INSERT INTO memory_sessions (id, title, created_at, updated_at, active) VALUES (?, ?, ?, ?, 1)`
  ).run(sessionId, title, now, now);

  return {
    id: sessionId,
    title,
    created_at: now,
    updated_at: now,
    summary: null,
    summary_at: null,
    active: 1,
  };
}

/**
 * Get a session by ID.
 */
export function getSession(db: Database, id: string): MemorySession | null {
  return (
    (db
      .prepare(`SELECT * FROM memory_sessions WHERE id = ?`)
      .get(id) as MemorySession | null) || null
  );
}

/**
 * List sessions, most recent first.
 */
export function listSessions(
  db: Database,
  options: { limit?: number; includeInactive?: boolean } = {}
): MemorySession[] {
  const limit = options.limit ?? 20;
  const where = options.includeInactive ? "" : "WHERE active = 1";
  return db
    .prepare(
      `SELECT * FROM memory_sessions ${where} ORDER BY updated_at DESC LIMIT ?`
    )
    .all(limit) as MemorySession[];
}

/**
 * Soft-delete a session (set active = 0). If hard = true, permanently delete.
 */
export function deleteSession(
  db: Database,
  id: string,
  hard: boolean = false
): void {
  if (hard) {
    // Delete messages first (CASCADE should handle, but be explicit)
    db.prepare(`DELETE FROM memory_messages WHERE session_id = ?`).run(id);
    db.prepare(`DELETE FROM memory_sessions WHERE id = ?`).run(id);
  } else {
    db.prepare(`UPDATE memory_sessions SET active = 0 WHERE id = ?`).run(id);
  }
}

/**
 * Clear all sessions (soft or hard delete).
 */
export function clearAllSessions(db: Database, hard: boolean = false): number {
  if (hard) {
    const count = (
      db.prepare(`SELECT COUNT(*) as count FROM memory_sessions`).get() as {
        count: number;
      }
    ).count;
    db.exec(`DELETE FROM memory_messages`);
    db.exec(`DELETE FROM memory_sessions`);
    db.exec(`DELETE FROM memory_fts`);
    return count;
  } else {
    const result = db.prepare(
      `UPDATE memory_sessions SET active = 0 WHERE active = 1`
    );
    return result.run().changes;
  }
}

/**
 * Remove content_vectors/vectors_vec rows whose hash is no longer referenced
 * by any memory message or active QMD document. Scoped deletion — unlike
 * QMD's own cleanupOrphanedVectors (which only checks `documents` and would
 * wipe every memory-message embedding, since messages aren't rows in
 * `documents`). Called after a hard session delete; a no-op (returns 0) when
 * the vector/document tables aren't present (e.g. sqlite-vec unavailable, or
 * a minimal test schema that skipped createStore()).
 */
export function cleanupOrphanedMemoryVectors(db: Database): number {
  try {
    db.prepare(`SELECT 1 FROM vectors_vec LIMIT 0`).get();
    db.prepare(`SELECT 1 FROM documents LIMIT 0`).get();
    db.prepare(`SELECT 1 FROM content_vectors LIMIT 0`).get();
  } catch {
    return 0;
  }

  const orphanWhere = `
    NOT EXISTS (SELECT 1 FROM memory_messages m WHERE m.hash = content_vectors.hash)
    AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.hash = content_vectors.hash AND d.active = 1)
  `;

  const { c } = db
    .prepare(`SELECT COUNT(*) as c FROM content_vectors WHERE ${orphanWhere}`)
    .get() as { c: number };
  if (c === 0) return 0;

  db.exec(`
    DELETE FROM vectors_vec WHERE hash_seq IN (
      SELECT content_vectors.hash || '_' || content_vectors.seq FROM content_vectors WHERE ${orphanWhere}
    )
  `);
  db.exec(`DELETE FROM content_vectors WHERE ${orphanWhere}`);

  return c;
}

// =============================================================================
// Message CRUD
// =============================================================================

/**
 * Add a message to a session. Creates session if it doesn't exist.
 */
export async function addMessage(
  db: Database,
  sessionId: string,
  role: string,
  content: string,
  options: { title?: string; metadata?: Record<string, unknown>; timestamp?: string } = {}
): Promise<MemoryMessage> {
  const now = new Date().toISOString();
  // Backfilled ingests pass the original message timestamp; live writes default to now
  const created = options.timestamp || now;
  const hash = await hashContent(content);

  // Preserve "new" behavior, which generates an ID.
  let resolvedSessionId = sessionId;
  if (sessionId === "new") {
    resolvedSessionId = crypto.randomUUID().slice(0, 8);
  }

  // Ensure session exists without a pre-read on every message.
  db.prepare(
    `INSERT OR IGNORE INTO memory_sessions (id, title, created_at, updated_at, active)
     VALUES (?, ?, ?, ?, 1)`
  ).run(resolvedSessionId, options.title || "", created, created);

  // If title is provided later, fill it only when current title is empty.
  if (options.title) {
    db.prepare(
      `UPDATE memory_sessions
       SET title = ?
       WHERE id = ? AND (title = '' OR title IS NULL)`
    ).run(options.title, resolvedSessionId);
  }

  const metadataStr = options.metadata
    ? JSON.stringify(options.metadata)
    : null;

  const result = db
    .prepare(
      `INSERT INTO memory_messages (session_id, role, content, hash, created_at, metadata)
     VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(resolvedSessionId, role, content, hash, created, metadataStr);

  // Update session timestamp
  db.prepare(`UPDATE memory_sessions SET updated_at = ? WHERE id = ?`).run(
    created,
    resolvedSessionId
  );

  return {
    id: Number(result.lastInsertRowid),
    session_id: resolvedSessionId,
    role,
    content,
    hash,
    created_at: created,
    metadata: options.metadata || null,
  };
}

/**
 * Get messages for a session, ordered by creation time.
 */
export function getMessages(
  db: Database,
  sessionId: string,
  options: { limit?: number } = {}
): MemoryMessage[] {
  let sql = `SELECT * FROM memory_messages WHERE session_id = ? ORDER BY created_at ASC`;
  const params: (string | number)[] = [sessionId];
  if (options.limit) {
    sql += ` LIMIT ?`;
    params.push(options.limit);
  }
  return db.prepare(sql).all(...params) as MemoryMessage[];
}

/**
 * Get a formatted transcript for a session.
 */
export function getSessionTranscript(
  db: Database,
  sessionId: string
): string {
  const messages = getMessages(db, sessionId);
  return messages.map((m) => `${m.role}: ${m.content}`).join("\n\n");
}

// =============================================================================
// Search
// =============================================================================

/**
 * Search memory using FTS5 (BM25). Same normalization as store.ts searchFTS.
 */
export function searchMemoryFTS(
  db: Database,
  query: string,
  limit: number = 20
): MemorySearchResult[] {
  const ftsQuery = buildMemoryFTS5Query(query);
  if (!ftsQuery) return [];
  const candidateLimit = Math.max(limit * 3, limit);

  // Rank candidate rowids in FTS first, then join to payload tables.
  // This keeps the expensive bm25 ordering on the smallest possible row shape.
  const sql = `
    WITH ranked AS (
      SELECT
        rowid,
        bm25(memory_fts, 5.0, 1.0, 1.0) as bm25_score
      FROM memory_fts
      WHERE memory_fts MATCH ?
      ORDER BY bm25_score ASC
      LIMIT ?
    )
    SELECT
      m.session_id,
      s.title as session_title,
      m.id as message_id,
      m.role,
      m.content,
      r.bm25_score
    FROM ranked r
    JOIN memory_messages m ON m.id = r.rowid
    JOIN memory_sessions s ON s.id = m.session_id
    WHERE s.active = 1
    ORDER BY r.bm25_score ASC
    LIMIT ?
  `;

  const stmt = getMemoryFtsStmt(db, sql);
  const rows = stmt.all(ftsQuery, candidateLimit, limit) as {
    session_id: string;
    session_title: string;
    message_id: number;
    role: string;
    content: string;
    bm25_score: number;
  }[];

  return rows.map((row) => ({
    session_id: row.session_id,
    session_title: row.session_title,
    message_id: row.message_id,
    role: row.role,
    content: row.content,
    // Same BM25 normalization as store.ts: 1 / (1 + |score|)
    score: 1 / (1 + Math.abs(row.bm25_score)),
    source: "fts" as const,
  }));
}

const memoryFtsStmtCache = new WeakMap<Database, ReturnType<Database["prepare"]>>();

function getMemoryFtsStmt(db: Database, sql: string) {
  let stmt = memoryFtsStmtCache.get(db);
  if (!stmt) {
    stmt = db.prepare(sql);
    memoryFtsStmtCache.set(db, stmt);
  }
  return stmt;
}

/**
 * Search memory using vector similarity.
 * Two-step pattern: query vectors_vec first, then JOIN separately.
 */
export async function searchMemoryVec(
  db: Database,
  query: string,
  limit: number = 20
): Promise<MemorySearchResult[]> {
  // Check if vectors_vec table exists
  const tableExists = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`
    )
    .get();
  if (!tableExists) return [];

  // Get query embedding
  const llm = getMemoryLlm();
  const formattedQuery = formatQueryForEmbedding(query);
  const result = await llm.embed(formattedQuery, { isQuery: true });
  if (!result) return [];

  // Step 1: Get vector matches (no JOINs - sqlite-vec hangs with JOINs)
  const vecResults = db
    .prepare(
      `SELECT hash_seq, distance FROM vectors_vec WHERE embedding MATCH ? AND k = ?`
    )
    .all(new Float32Array(result.embedding), limit * 3) as {
    hash_seq: string;
    distance: number;
  }[];

  if (vecResults.length === 0) return [];

  // Step 2: Match against memory_messages by hash
  const hashSeqs = vecResults.map((r) => r.hash_seq);
  const distanceMap = new Map(vecResults.map((r) => [r.hash_seq, r.distance]));

  // Extract unique hashes from hash_seq (format: "hash_seq")
  const hashes = [
    ...new Set(hashSeqs.map((hs) => hs.split("_").slice(0, -1).join("_"))),
  ];
  const hashPlaceholders = hashes.map(() => "?").join(",");

  const docSql = `
    SELECT
      m.id as message_id,
      m.session_id,
      s.title as session_title,
      m.role,
      m.content,
      m.hash,
      cv.hash || '_' || cv.seq as hash_seq
    FROM memory_messages m
    JOIN memory_sessions s ON s.id = m.session_id
    JOIN content_vectors cv ON cv.hash = m.hash
    WHERE m.hash IN (${hashPlaceholders}) AND s.active = 1
  `;

  const docRows = db.prepare(docSql).all(...hashes) as {
    message_id: number;
    session_id: string;
    session_title: string;
    role: string;
    content: string;
    hash: string;
    hash_seq: string;
  }[];

  // Combine with distances, dedupe by message_id
  const seen = new Map<
    number,
    { row: (typeof docRows)[0]; bestDist: number }
  >();
  for (const row of docRows) {
    const distance = distanceMap.get(row.hash_seq) ?? 1;
    const existing = seen.get(row.message_id);
    if (!existing || distance < existing.bestDist) {
      seen.set(row.message_id, { row, bestDist: distance });
    }
  }

  return Array.from(seen.values())
    .sort((a, b) => a.bestDist - b.bestDist)
    .slice(0, limit)
    .map(({ row, bestDist }) => ({
      session_id: row.session_id,
      session_title: row.session_title,
      message_id: row.message_id,
      role: row.role,
      content: row.content,
      score: 1 - bestDist, // cosine similarity
      source: "vec" as const,
    }));
}

// =============================================================================
// Embedding
// =============================================================================

/**
 * Embed unembedded memory messages.
 * Reuses existing content_vectors + vectors_vec tables.
 * Returns count of newly embedded messages.
 */
export async function embedMemoryMessages(
  db: Database,
  options: { onProgress?: (done: number, total: number) => void } = {}
): Promise<number> {
  // Find messages without embeddings
  const unembedded = db
    .prepare(
      `
    SELECT m.hash, m.content, m.session_id
    FROM memory_messages m
    LEFT JOIN content_vectors cv ON cv.hash = m.hash AND cv.seq = 0
    WHERE cv.hash IS NULL
    GROUP BY m.hash
  `
    )
    .all() as { hash: string; content: string; session_id: string }[];

  if (unembedded.length === 0) return 0;

  const llm = getMemoryLlm();
  let embedded = 0;

  for (const msg of unembedded) {
    // Chunk the message content
    const chunks = await chunkDocumentByTokens(msg.content);

    // Ensure vec table exists with correct dimensions
    // Get dimension from first embedding
    const firstText = formatDocForEmbedding(chunks[0]!.text);
    const firstEmbed = await llm.embed(firstText);
    if (!firstEmbed) continue;

    const dimensions = firstEmbed.embedding.length;

    // Ensure vectors_vec table exists with correct dimensions
    const tableInfo = db
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='vectors_vec'`
      )
      .get() as { sql: string } | null;
    if (!tableInfo) {
      db.exec(
        `CREATE VIRTUAL TABLE vectors_vec USING vec0(hash_seq TEXT PRIMARY KEY, embedding float[${dimensions}] distance_metric=cosine)`
      );
    }

    const now = new Date().toISOString();

    // Insert first chunk embedding
    getQmdStore().internal.insertEmbedding(
      msg.hash,
      0,
      chunks[0]!.pos,
      new Float32Array(firstEmbed.embedding),
      firstEmbed.model,
      now
    );

    // Embed remaining chunks
    for (let i = 1; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const text = formatDocForEmbedding(chunk.text);
      const embedResult = await llm.embed(text);
      if (embedResult) {
        getQmdStore().internal.insertEmbedding(
          msg.hash,
          i,
          chunk.pos,
          new Float32Array(embedResult.embedding),
          embedResult.model,
          now
        );
      }
    }

    embedded++;
    options.onProgress?.(embedded, unembedded.length);
  }

  return embedded;
}

// =============================================================================
// Summarization
// =============================================================================

/**
 * Summarize a session via Ollama and store the summary.
 */
export async function summarizeSession(
  db: Database,
  sessionId: string,
  options: { model?: string; force?: boolean } = {}
): Promise<string> {
  const session = getSession(db, sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  // Check if already summarized (unless force)
  if (session.summary && !options.force) {
    return session.summary;
  }

  const transcript = getSessionTranscript(db, sessionId);
  if (!transcript.trim()) throw new Error(`Session ${sessionId} has no messages`);

  const summary = await ollamaSummarize(transcript, { model: options.model });
  const now = new Date().toISOString();

  db.prepare(
    `UPDATE memory_sessions SET summary = ?, summary_at = ? WHERE id = ?`
  ).run(summary, now, sessionId);

  return summary;
}

/**
 * Summarize recent sessions that don't have summaries yet.
 * Returns count of sessions summarized.
 */
export async function summarizeRecentSessions(
  db: Database,
  options: { limit?: number; model?: string } = {}
): Promise<number> {
  const limit = options.limit ?? 10;
  const sessions = db
    .prepare(
      `SELECT id FROM memory_sessions WHERE active = 1 AND summary IS NULL ORDER BY updated_at DESC LIMIT ?`
    )
    .all(limit) as { id: string }[];

  let count = 0;
  for (const s of sessions) {
    try {
      await summarizeSession(db, s.id, { model: options.model });
      count++;
    } catch {
      // Skip sessions that fail to summarize
    }
  }
  return count;
}

// =============================================================================
// Recall
// =============================================================================

/**
 * Recall relevant memories for a query.
 * Combines FTS + vector search using RRF, deduplicates by session,
 * optionally expands query + reranks (skipped when fast=true),
 * and optionally synthesizes via Ollama.
 */
export async function recallMemories(
  db: Database,
  query: string,
  options: {
    limit?: number;
    synthesize?: boolean;
    model?: string;
    maxTokens?: number;
    fast?: boolean;
    intent?: string;
  } = {}
): Promise<{ results: MemorySearchResult[]; synthesis?: string }> {
  const startedAt = performance.now();
  const shouldTraceRecall = process.env.SMRITI_BENCH_TRACE === "1";
  const limit = options.limit ?? 10;
  const fast = options.fast ?? false;
  const intent = options.intent;

  // Candidate fetch size — fetch more when reranking to feed the reranker
  const candidateLimit = fast ? limit : Math.max(limit * 4, 40);

  // Run FTS and vector search for the original query
  const ftsStartedAt = performance.now();
  const ftsResults = searchMemoryFTS(db, query, candidateLimit);
  const ftsMs = performance.now() - ftsStartedAt;
  let vecResults: MemorySearchResult[] = [];
  const vecStartedAt = performance.now();
  try {
    vecResults = await searchMemoryVec(db, query, candidateLimit);
  } catch {
    // Vector search may fail if no embeddings exist
  }
  const vecMs = performance.now() - vecStartedAt;

  // Convert to RankedResult format for RRF
  const toRanked = (results: MemorySearchResult[]): RankedResult[] =>
    results.map((r) => ({
      file: `${r.session_id}:${r.message_id}`,
      displayPath: r.session_title,
      title: r.role,
      body: r.content,
      score: r.score,
    }));

  // Build ranked lists — start with original query results
  const rankedLists: RankedResult[][] = [toRanked(ftsResults), toRanked(vecResults)];
  const rankWeights: number[] = [1.0, 1.0];

  // Quality mode: expand query variants and fold in their results
  if (!fast) {
    try {
      const store = getQmdStore();
      const expanded = await store.internal.expandQuery(query);
      for (const variant of expanded) {
        // lex variants are best suited for FTS; vec/hyde for vector search
        const variantFts = searchMemoryFTS(db, variant.query, candidateLimit);
        rankedLists.push(toRanked(variantFts));
        rankWeights.push(0.7);
        if (variant.type !== "lex") {
          try {
            const variantVec = await searchMemoryVec(db, variant.query, candidateLimit);
            rankedLists.push(toRanked(variantVec));
            rankWeights.push(0.7);
          } catch {
            // skip if no embeddings
          }
        }
      }
    } catch {
      // LLM unavailable — fall through with original results only
    }
  }

  // Fuse all ranked lists with RRF
  const fuseStartedAt = performance.now();
  const fused = reciprocalRankFusion(rankedLists, rankWeights);
  const fuseMs = performance.now() - fuseStartedAt;

  // Deduplicate by session, keeping best score per session
  const dedupeStartedAt = performance.now();
  const sessionSeen = new Map<string, boolean>();
  const dedupedResults: MemorySearchResult[] = [];
  const originalByKey = new Map<string, MemorySearchResult>();
  for (const result of ftsResults) {
    originalByKey.set(`${result.session_id}:${result.message_id}`, result);
  }
  for (const result of vecResults) {
    const key = `${result.session_id}:${result.message_id}`;
    // Prefer vector entry if both are present because it typically carries the better semantic score.
    originalByKey.set(key, result);
  }

  for (const r of fused) {
    const [sessionId] = r.file.split(":");
    if (!sessionId) continue;

    // Find the original result to preserve all fields
    const original = originalByKey.get(r.file) ?? null;

    if (original && !sessionSeen.has(sessionId)) {
      sessionSeen.set(sessionId, true);
      dedupedResults.push({ ...original, score: r.score });
    } else if (!original && !sessionSeen.has(sessionId)) {
      sessionSeen.set(sessionId, true);
      dedupedResults.push({
        session_id: sessionId!,
        session_title: r.displayPath,
        message_id: parseInt(r.file.split(":")[1] || "0"),
        role: r.title,
        content: r.body,
        score: r.score,
        source: "fts",
      });
    }
  }
  const dedupeMs = performance.now() - dedupeStartedAt;

  // Quality mode: rerank the deduped candidates before density blending
  if (!fast && dedupedResults.length > 1) {
    try {
      const store = getQmdStore();
      const docs = dedupedResults.map((r) => ({
        file: `${r.session_id}:${r.message_id}`,
        text: r.content,
      }));
      const reranked = await store.internal.rerank(query, docs, undefined, intent);
      const scoreMap = new Map(reranked.map((r) => [r.file, r.score]));
      for (const r of dedupedResults) {
        const key = `${r.session_id}:${r.message_id}`;
        const rerankerScore = scoreMap.get(key);
        if (rerankerScore !== undefined) {
          // Blend: 60% reranker + 40% RRF to stay anchored to retrieval signal
          r.score = rerankerScore * 0.6 + r.score * 0.4;
        }
      }
      dedupedResults.sort((a, b) => b.score - a.score);
    } catch {
      // Reranker unavailable — keep RRF order
    }
  }

  // Blend density scores into recall scores — dense sessions rank higher.
  // smriti_session_meta is a Smriti-layer table, not a QMD core one — this
  // file is meant to stay usable against a bare QMD store (e.g.
  // scripts/bench-qmd.ts), so a missing table degrades gracefully instead
  // of throwing, same as the vector-search fallback above.
  if (dedupedResults.length > 0) {
    try {
      const sessionIds = dedupedResults.map((r) => r.session_id);
      const placeholders = sessionIds.map(() => "?").join(",");
      const densityRows = (db as any)
        .prepare(
          `SELECT session_id, COALESCE(density_score, 0) as density_score
           FROM smriti_session_meta WHERE session_id IN (${placeholders})`
        )
        .all(...sessionIds) as { session_id: string; density_score: number }[];
      const densityMap = new Map(densityRows.map((r) => [r.session_id, r.density_score]));

      for (const r of dedupedResults) {
        const ds = densityMap.get(r.session_id) ?? 0;
        r.score = r.score * 0.8 + ds * 0.2;
      }
      dedupedResults.sort((a, b) => b.score - a.score);
    } catch {
      // smriti_session_meta doesn't exist (bare QMD store) — skip blending.
    }
  }

  const results = dedupedResults.slice(0, limit);

  // Optionally synthesize via Ollama
  let synthesis: string | undefined;
  if (options.synthesize && results.length > 0) {
    const memoriesText = results
      .map(
        (r) =>
          `[Session: ${r.session_title || r.session_id}]\n${r.role}: ${r.content}`
      )
      .join("\n\n---\n\n");

    synthesis = await ollamaRecallSynthesize(query, memoriesText, {
      model: options.model,
      maxTokens: options.maxTokens,
    });
  }

  if (shouldTraceRecall) {
    const timings: RecallTimings = {
      ftsMs,
      vecMs,
      fuseMs,
      dedupeMs,
      totalMs: performance.now() - startedAt,
    };
    console.error(
      `[recall.trace] q="${query.slice(0, 64)}" ` +
        `fts=${timings.ftsMs.toFixed(3)}ms ` +
        `vec=${timings.vecMs.toFixed(3)}ms ` +
        `fuse=${timings.fuseMs.toFixed(3)}ms ` +
        `dedupe=${timings.dedupeMs.toFixed(3)}ms ` +
        `total=${timings.totalMs.toFixed(3)}ms`
    );
  }

  return { results, synthesis };
}

// =============================================================================
// Import
// =============================================================================

/**
 * Import a conversation transcript from a file.
 * Supports 'chat' format (role: content) and 'jsonl' format.
 */
export async function importTranscript(
  db: Database,
  content: string,
  options: { title?: string; format?: "chat" | "jsonl"; sessionId?: string } = {}
): Promise<{ sessionId: string; messageCount: number }> {
  const format = options.format ?? "chat";
  const sessionId = options.sessionId || crypto.randomUUID().slice(0, 8);

  let messages: { role: string; content: string }[] = [];

  if (format === "jsonl") {
    messages = content
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        const parsed = JSON.parse(line);
        return { role: parsed.role || "user", content: parsed.content || "" };
      });
  } else {
    // Chat format: "role: content" separated by blank lines
    const blocks = content.split(/\n\n+/);
    for (const block of blocks) {
      const trimmed = block.trim();
      if (!trimmed) continue;
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx > 0 && colonIdx < 20) {
        const role = trimmed.slice(0, colonIdx).trim().toLowerCase();
        const msgContent = trimmed.slice(colonIdx + 1).trim();
        if (msgContent) {
          messages.push({ role, content: msgContent });
        }
      } else {
        messages.push({ role: "user", content: trimmed });
      }
    }
  }

  for (const msg of messages) {
    await addMessage(db, sessionId, msg.role, msg.content, {
      title: options.title,
    });
  }

  return { sessionId, messageCount: messages.length };
}

// =============================================================================
// Status
// =============================================================================

/**
 * Get memory statistics.
 */
export function getMemoryStatus(db: Database): {
  sessions: number;
  activeSessions: number;
  messages: number;
  embeddedMessages: number;
  summarizedSessions: number;
} {
  const sessions = (
    db
      .prepare(`SELECT COUNT(*) as count FROM memory_sessions`)
      .get() as { count: number }
  ).count;

  const activeSessions = (
    db
      .prepare(
        `SELECT COUNT(*) as count FROM memory_sessions WHERE active = 1`
      )
      .get() as { count: number }
  ).count;

  const messages = (
    db
      .prepare(`SELECT COUNT(*) as count FROM memory_messages`)
      .get() as { count: number }
  ).count;

  const embeddedMessages = (
    db
      .prepare(
        `SELECT COUNT(DISTINCT m.hash) as count FROM memory_messages m
       JOIN content_vectors cv ON cv.hash = m.hash`
      )
      .get() as { count: number }
  ).count;

  const summarizedSessions = (
    db
      .prepare(
        `SELECT COUNT(*) as count FROM memory_sessions WHERE summary IS NOT NULL`
      )
      .get() as { count: number }
  ).count;

  return {
    sessions,
    activeSessions,
    messages,
    embeddedMessages,
    summarizedSessions,
  };
}
