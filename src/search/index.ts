/**
 * search/index.ts - Filtered search wrapping QMD's memory search
 *
 * Adds WHERE clauses for category, project, and agent filtering
 * while preserving QMD's BM25 + vector + RRF fusion.
 */

import type { Database } from "bun:sqlite";
import { DEFAULT_SEARCH_LIMIT } from "../config";
import { searchMemoryFTS, searchMemoryVec } from "../qmd";

// =============================================================================
// Types
// =============================================================================

export type SearchFilters = {
  category?: string;
  project?: string;
  agent?: string;
  limit?: number;
  includeThinking?: boolean;    // Default: false (opt-in for privacy)
  includeArtifacts?: boolean;   // Default: true
  includeAttachments?: boolean; // Default: true
  includeVoiceNotes?: boolean;  // Default: true
};

export type SearchResult = {
  session_id: string;
  session_title: string;
  message_id: number;
  role: string;
  content: string;
  score: number;
  source: string;
  category?: string;
  project?: string;
  agent?: string;
};

// =============================================================================
// Filtered FTS Search
// =============================================================================

/**
 * Full-text search with category/project/agent filters.
 * Wraps QMD's memory_fts with JOIN to Smriti metadata tables.
 */
export function searchFiltered(
  db: Database,
  query: string,
  filters: SearchFilters = {}
): SearchResult[] {
  const limit = filters.limit || DEFAULT_SEARCH_LIMIT;

  // Build column list for FTS5 column filter
  const columns = ["session_title", "role", "content"];
  if (filters.includeThinking) columns.push("thinking");
  if (filters.includeArtifacts !== false) columns.push("artifacts");
  if (filters.includeAttachments !== false) columns.push("attachments");
  if (filters.includeVoiceNotes !== false) columns.push("voice_notes");

  // BM25 weights: session_title, role, content, thinking, artifacts, attachments, voice_notes
  const weights = [
    10.0, // session_title
    1.0,  // role
    5.0,  // content
    filters.includeThinking ? 3.0 : 0.0,
    filters.includeArtifacts !== false ? 4.0 : 0.0,
    filters.includeAttachments !== false ? 4.0 : 0.0,
    filters.includeVoiceNotes !== false ? 4.0 : 0.0,
  ];

  // Build dynamic WHERE clause
  const conditions: string[] = [];
  const params: any[] = [];

  // FTS match condition with column filter
  conditions.push(`memory_fts MATCH ?`);
  params.push(`{${columns.join(" ")}} : ${query}`);

  // Category filter
  if (filters.category) {
    conditions.push(
      `EXISTS (
        SELECT 1 FROM smriti_message_tags mt
        WHERE mt.message_id = mm.id
          AND (mt.category_id = ? OR mt.category_id LIKE ? || '/%')
      )`
    );
    params.push(filters.category, filters.category);
  }

  // Project filter
  if (filters.project) {
    conditions.push(
      `EXISTS (
        SELECT 1 FROM smriti_session_meta sm
        WHERE sm.session_id = mm.session_id AND sm.project_id = ?
      )`
    );
    params.push(filters.project);
  }

  // Agent filter
  if (filters.agent) {
    conditions.push(
      `EXISTS (
        SELECT 1 FROM smriti_session_meta sm
        WHERE sm.session_id = mm.session_id AND sm.agent_id = ?
      )`
    );
    params.push(filters.agent);
  }

  params.push(limit);

  const sql = `
    SELECT
      mm.session_id,
      ms.title AS session_title,
      mm.id AS message_id,
      mm.role,
      mm.content,
      (1.0 / (1.0 + ABS(bm25(memory_fts, ${weights.join(", ")})))) AS score,
      'fts' AS source,
      sm.project_id AS project,
      sm.agent_id AS agent
    FROM memory_fts mf
    JOIN memory_messages mm ON mm.rowid = mf.rowid
    JOIN memory_sessions ms ON ms.id = mm.session_id
    LEFT JOIN smriti_session_meta sm ON sm.session_id = mm.session_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY score DESC
    LIMIT ?
  `;

  const ftsRows = db.prepare(sql).all(...params) as SearchResult[];

  // Also search query aliases (from smriti enrich --queries) and merge in sessions
  // not already surfaced by FTS.
  const labelRows = searchByQueryAliases(db, query, filters, limit);
  const seenSessions = new Set(ftsRows.map(r => r.session_id));
  const novelFromLabels = labelRows.filter(r => !seenSessions.has(r.session_id));

  return [...ftsRows, ...novelFromLabels].slice(0, limit);
}

// =============================================================================
// Query Alias Search (#60)
// =============================================================================

/**
 * Find sessions via smriti_queries_fts (enriched aliases) and return their
 * representative top message as SearchResults with source='query_alias'.
 */
function searchByQueryAliases(
  db: Database,
  query: string,
  filters: SearchFilters,
  limit: number
): SearchResult[] {
  // Check table exists (enrichment is optional)
  const tableExists = (db as any)
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='smriti_queries_fts'`)
    .get();
  if (!tableExists) return [];

  const aliasConditions: string[] = ["smriti_queries_fts MATCH ?", "ms.active = 1"];
  const aliasParams: any[] = [query];

  if (filters.project) {
    aliasConditions.push("sm.project_id = ?");
    aliasParams.push(filters.project);
  }
  if (filters.agent) {
    aliasConditions.push("sm.agent_id = ?");
    aliasParams.push(filters.agent);
  }
  if (filters.category) {
    aliasConditions.push(
      `EXISTS (SELECT 1 FROM smriti_session_tags st WHERE st.session_id = sq.session_id
        AND (st.category_id = ? OR st.category_id LIKE ? || '/%'))`
    );
    aliasParams.push(filters.category, filters.category);
  }
  aliasParams.push(limit);

  const sql = `
    SELECT DISTINCT
      mm.session_id,
      ms.title AS session_title,
      mm.id AS message_id,
      mm.role,
      mm.content,
      0.5 AS score,
      'query_alias' AS source,
      sm.project_id AS project,
      sm.agent_id AS agent
    FROM smriti_queries_fts
    JOIN smriti_session_queries sq ON sq.rowid = smriti_queries_fts.rowid
    JOIN memory_sessions ms ON ms.id = sq.session_id
    JOIN memory_messages mm ON mm.session_id = sq.session_id
      AND mm.id = (SELECT MIN(id) FROM memory_messages WHERE session_id = sq.session_id)
    LEFT JOIN smriti_session_meta sm ON sm.session_id = sq.session_id
    WHERE ${aliasConditions.join(" AND ")}
    LIMIT ?
  `;

  try {
    return (db as any).prepare(sql).all(...aliasParams) as SearchResult[];
  } catch {
    return [];
  }
}

// =============================================================================
// Unfiltered Search (delegates to QMD)
// =============================================================================

/**
 * Search using QMD's native FTS search (no Smriti filters).
 */
export function searchFTS(
  db: Database,
  query: string,
  limit?: number
) {
  return searchMemoryFTS(db, query, limit || DEFAULT_SEARCH_LIMIT);
}

/**
 * Search using QMD's native vector search (no Smriti filters).
 */
export async function searchVec(
  db: Database,
  query: string,
  limit?: number
) {
  return searchMemoryVec(db, query, limit || DEFAULT_SEARCH_LIMIT);
}

// =============================================================================
// List Sessions with Filters
// =============================================================================

export type ListFilters = {
  category?: string;
  project?: string;
  agent?: string;
  limit?: number;
  includeInactive?: boolean;
};

/**
 * List sessions with optional filtering by category, project, and agent.
 */
export function listSessions(
  db: Database,
  filters: ListFilters = {}
): Array<{
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  summary: string | null;
  active: number;
  agent_id: string | null;
  project_id: string | null;
  categories: string;
}> {
  const conditions: string[] = [];
  const params: any[] = [];

  if (!filters.includeInactive) {
    conditions.push(`ms.active = 1`);
  }

  if (filters.category) {
    conditions.push(
      `EXISTS (
        SELECT 1 FROM smriti_session_tags st
        WHERE st.session_id = ms.id
          AND (st.category_id = ? OR st.category_id LIKE ? || '/%')
      )`
    );
    params.push(filters.category, filters.category);
  }

  if (filters.project) {
    conditions.push(`sm.project_id = ?`);
    params.push(filters.project);
  }

  if (filters.agent) {
    conditions.push(`sm.agent_id = ?`);
    params.push(filters.agent);
  }

  const limit = filters.limit || 50;
  params.push(limit);

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const sql = `
    SELECT
      ms.id,
      ms.title,
      ms.created_at,
      ms.updated_at,
      ms.summary,
      ms.active,
      sm.agent_id,
      sm.project_id,
      COALESCE(
        GROUP_CONCAT(DISTINCT st.category_id),
        ''
      ) AS categories
    FROM memory_sessions ms
    LEFT JOIN smriti_session_meta sm ON sm.session_id = ms.id
    LEFT JOIN smriti_session_tags st ON st.session_id = ms.id
    ${whereClause}
    GROUP BY ms.id
    ORDER BY ms.updated_at DESC
    LIMIT ?
  `;

  return db.prepare(sql).all(...params) as any;
}
