/**
 * db.ts - Database schema, migrations, and connection for Smriti
 *
 * Uses the shared QMD SQLite database. All Smriti tables are prefixed with
 * `smriti_` to avoid collisions. Does NOT alter existing QMD tables.
 *
 * DB lifecycle: initSmriti() → createStore() (SDK) → setQmdStore() → initializeSmritiTables()
 */

import { Database } from "bun:sqlite";
import { mkdirSync, existsSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { QMD_DB_PATH, SMRITI_SESSIONS_DIR, SMRITI_DIR } from "./config";
import { initializeMemoryTables, deleteSession, cleanupOrphanedMemoryVectors } from "./qmd";
import { createStore } from "../qmd/src/index";
import { setQmdStore, closeQmdStore } from "./store";
import type { KnowledgeUnit } from "./team/types";

// =============================================================================
// Connection
// =============================================================================

let _db: Database | null = null;

/** Return the cached DB connection. Throws if initSmriti() hasn't been called. */
export function getDb(): Database {
  if (!_db) throw new Error("Database not initialized — call initSmriti() first");
  return _db;
}

/** Close the database and release the QMD store (including its LLM backend). */
export async function closeDb(): Promise<void> {
  _db = null;
  await closeQmdStore();
}

// =============================================================================
// Schema Initialization
// =============================================================================

/** Create all Smriti tables if they don't exist */
export function initializeSmritiTables(db: Database): void {
  db.exec(`
    -- Agent registry
    CREATE TABLE IF NOT EXISTS smriti_agents (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      log_pattern TEXT,
      parser TEXT NOT NULL
    );

    -- Project registry
    CREATE TABLE IF NOT EXISTS smriti_projects (
      id TEXT PRIMARY KEY,
      path TEXT,
      description TEXT,
      language TEXT,
      framework TEXT,
      language_version TEXT,
      detected_at TEXT,
      rule_version TEXT DEFAULT '1.0.0',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Session metadata (maps to QMD's memory_sessions)
    CREATE TABLE IF NOT EXISTS smriti_session_meta (
      session_id TEXT PRIMARY KEY,
      agent_id TEXT,
      project_id TEXT,
      FOREIGN KEY (agent_id) REFERENCES smriti_agents(id),
      FOREIGN KEY (project_id) REFERENCES smriti_projects(id)
    );
  `);

  // Migrations for existing installations
  try {
    db.exec(`ALTER TABLE smriti_projects ADD COLUMN language TEXT`);
  } catch {
    // Column already exists
  }
  try {
    db.exec(`ALTER TABLE smriti_projects ADD COLUMN framework TEXT`);
  } catch {
    // Column already exists
  }
  try {
    db.exec(`ALTER TABLE smriti_projects ADD COLUMN language_version TEXT`);
  } catch {
    // Column already exists
  }
  try {
    db.exec(`ALTER TABLE smriti_projects ADD COLUMN detected_at TEXT`);
  } catch {
    // Column already exists
  }
  try {
    db.exec(`ALTER TABLE smriti_projects ADD COLUMN rule_version TEXT DEFAULT '1.0.0'`);
  } catch {
    // Column already exists
  }

  // density_score on smriti_session_meta
  try {
    db.exec(`ALTER TABLE smriti_session_meta ADD COLUMN density_score REAL DEFAULT 0`);
  } catch {
    // Column already exists
  }

  // Migrate smriti_shares if they don't exist (migration)
  try {
    db.exec(`ALTER TABLE smriti_shares ADD COLUMN unit_id TEXT`);
  } catch {
    // Column already exists or table not created yet
  }
  try {
    db.exec(`ALTER TABLE smriti_shares ADD COLUMN unit_sequence INTEGER DEFAULT 0`);
  } catch {
    // Column already exists
  }
  try {
    db.exec(`ALTER TABLE smriti_shares ADD COLUMN relevance_score REAL`);
  } catch {
    // Column already exists
  }
  try {
    db.exec(`ALTER TABLE smriti_shares ADD COLUMN entities TEXT`);
  } catch {
    // Column already exists
  }

  // Migrate smriti_session_costs: change PK from (session_id) to (session_id, model)
  try {
    const hasOldSchema = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='smriti_session_costs'`)
      .get() as { sql: string } | null;
    if (hasOldSchema?.sql && hasOldSchema.sql.includes("session_id TEXT PRIMARY KEY")) {
      db.exec(`
        ALTER TABLE smriti_session_costs RENAME TO _smriti_session_costs_old;
        CREATE TABLE smriti_session_costs (
          session_id TEXT NOT NULL,
          model TEXT NOT NULL DEFAULT 'unknown',
          total_input_tokens INTEGER DEFAULT 0,
          total_output_tokens INTEGER DEFAULT 0,
          total_cache_tokens INTEGER DEFAULT 0,
          estimated_cost_usd REAL DEFAULT 0,
          turn_count INTEGER DEFAULT 0,
          total_duration_ms INTEGER DEFAULT 0,
          PRIMARY KEY (session_id, model)
        );
        INSERT INTO smriti_session_costs (session_id, model, total_input_tokens, total_output_tokens, total_cache_tokens, estimated_cost_usd, turn_count, total_duration_ms)
          SELECT session_id, COALESCE(model, 'unknown'), total_input_tokens, total_output_tokens, total_cache_tokens, estimated_cost_usd, turn_count, total_duration_ms
          FROM _smriti_session_costs_old;
        DROP TABLE _smriti_session_costs_old;
      `);
    }
  } catch {
    // Table doesn't exist yet or already migrated
  }

  db.exec(`
    -- Category taxonomy (hierarchical)
    CREATE TABLE IF NOT EXISTS smriti_categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      parent_id TEXT,
      description TEXT,
      FOREIGN KEY (parent_id) REFERENCES smriti_categories(id)
    );

    -- Message categorization (many-to-many)
    CREATE TABLE IF NOT EXISTS smriti_message_tags (
      message_id INTEGER NOT NULL,
      category_id TEXT NOT NULL,
      confidence REAL DEFAULT 1.0,
      source TEXT DEFAULT 'manual',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (message_id, category_id),
      FOREIGN KEY (category_id) REFERENCES smriti_categories(id)
    );

    -- Session-level categorization
    CREATE TABLE IF NOT EXISTS smriti_session_tags (
      session_id TEXT NOT NULL,
      category_id TEXT NOT NULL,
      confidence REAL DEFAULT 1.0,
      source TEXT DEFAULT 'manual',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (session_id, category_id),
      FOREIGN KEY (category_id) REFERENCES smriti_categories(id)
    );

    -- Team sharing log
    CREATE TABLE IF NOT EXISTS smriti_shares (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      message_id INTEGER,
      category_id TEXT,
      project_id TEXT,
      author TEXT,
      shared_at TEXT NOT NULL DEFAULT (datetime('now')),
      content_hash TEXT,
      unit_id TEXT,
      unit_sequence INTEGER DEFAULT 0,
      relevance_score REAL,
      entities TEXT
    );

    -- Knowledge consolidation: raw Stage-1 extracts, promoted to canonical on reuse
    CREATE TABLE IF NOT EXISTS smriti_knowledge_units (
      id TEXT PRIMARY KEY,                    -- KnowledgeUnit.id (uuid)
      session_id TEXT NOT NULL,
      project_id TEXT,
      topic TEXT NOT NULL,
      category TEXT NOT NULL,
      relevance REAL NOT NULL DEFAULT 0,      -- 0-10, from Stage 1
      entities TEXT,                          -- JSON array
      files TEXT,                             -- JSON array
      plain_text TEXT NOT NULL,               -- raw Stage-1 extract
      line_ranges TEXT,                       -- JSON array of {start,end}
      content_hash TEXT NOT NULL,             -- hashContent({topic,category,plainText}) — Stage-1 dedup key
      tier TEXT NOT NULL DEFAULT 'segmented', -- 'segmented' | 'canonical' | 'archived'
      retrieval_count INTEGER NOT NULL DEFAULT 0,
      last_recalled_at TEXT,
      promoted_at TEXT,
      canonical_doc_path TEXT,                -- relative path under .smriti/knowledge/, set on promotion
      share_id TEXT,                          -- points at the smriti_shares row created on promotion
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_smriti_knowledge_units_session ON smriti_knowledge_units(session_id);
    CREATE INDEX IF NOT EXISTS idx_smriti_knowledge_units_hash ON smriti_knowledge_units(content_hash);
    CREATE INDEX IF NOT EXISTS idx_smriti_knowledge_units_tier ON smriti_knowledge_units(tier);

    -- Canonical entity registry: resolves free-text entity mentions (from Stage 1
    -- extraction) onto a stable node, so recurrence is detected regardless of wording.
    -- Propagated team/org-wide via .smriti/config.json, same mechanism as custom categories.
    CREATE TABLE IF NOT EXISTS smriti_entities (
      id TEXT PRIMARY KEY,                          -- slug, e.g. "jwt", "redis"
      label TEXT NOT NULL,                          -- canonical display name
      entity_type TEXT NOT NULL DEFAULT 'concept',  -- 'technology' | 'concept' | 'file' | 'pattern'
      aliases TEXT NOT NULL DEFAULT '[]',           -- JSON array of raw strings seen
      mention_count INTEGER NOT NULL DEFAULT 0,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_smriti_entities_label ON smriti_entities(label);

    -- Relationship triples (subject/object polymorphic via type+id, not literal RDF URIs).
    -- knowledge_unit -mentions-> entity edges come free from Stage-1 extraction;
    -- knowledge_unit -relatesTo/supersedes/contradicts-> knowledge_unit edges are LLM-gated,
    -- only at promotion time (see src/learn/consolidate.ts), persisting what
    -- ollamaCheckConflicts previously only computed ephemerally.
    CREATE TABLE IF NOT EXISTS smriti_relationships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_type TEXT NOT NULL,   -- 'knowledge_unit' | 'entity' | 'session'
      subject_id TEXT NOT NULL,
      predicate TEXT NOT NULL,      -- 'mentions' | 'relatesTo' | 'supersedes' | 'contradicts'
      object_type TEXT NOT NULL,
      object_id TEXT NOT NULL,
      confidence REAL DEFAULT 1.0,
      source TEXT DEFAULT 'extraction',  -- 'extraction' | 'derived' | 'llm'
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(subject_type, subject_id, predicate, object_type, object_id)
    );
    CREATE INDEX IF NOT EXISTS idx_smriti_relationships_subject ON smriti_relationships(subject_type, subject_id);
    CREATE INDEX IF NOT EXISTS idx_smriti_relationships_object ON smriti_relationships(object_type, object_id);
    CREATE INDEX IF NOT EXISTS idx_smriti_relationships_predicate ON smriti_relationships(predicate);

    -- Tool usage tracking
    CREATE TABLE IF NOT EXISTS smriti_tool_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      input_summary TEXT,
      success INTEGER DEFAULT 1,
      duration_ms INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY (message_id) REFERENCES memory_messages(id)
    );

    -- File operation tracking
    CREATE TABLE IF NOT EXISTS smriti_file_operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      file_path TEXT NOT NULL,
      project_id TEXT,
      created_at TEXT NOT NULL
    );

    -- Command execution tracking
    CREATE TABLE IF NOT EXISTS smriti_commands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      command TEXT NOT NULL,
      exit_code INTEGER,
      cwd TEXT,
      is_git INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );

    -- Error tracking
    CREATE TABLE IF NOT EXISTS smriti_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      error_type TEXT NOT NULL,
      message TEXT,
      created_at TEXT NOT NULL
    );

    -- Token/cost tracking per session per model
    CREATE TABLE IF NOT EXISTS smriti_session_costs (
      session_id TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT 'unknown',
      total_input_tokens INTEGER DEFAULT 0,
      total_output_tokens INTEGER DEFAULT 0,
      total_cache_tokens INTEGER DEFAULT 0,
      estimated_cost_usd REAL DEFAULT 0,
      turn_count INTEGER DEFAULT 0,
      total_duration_ms INTEGER DEFAULT 0,
      PRIMARY KEY (session_id, model)
    );

    -- Git operation tracking
    CREATE TABLE IF NOT EXISTS smriti_git_operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      branch TEXT,
      pr_url TEXT,
      pr_number INTEGER,
      details TEXT,
      created_at TEXT NOT NULL
    );

    -- Rule cache (fetched from GitHub)
    CREATE TABLE IF NOT EXISTS smriti_rule_cache (
      language TEXT NOT NULL,
      version TEXT NOT NULL,
      framework TEXT,
      fetched_at TEXT NOT NULL,
      rules_yaml TEXT NOT NULL,
      PRIMARY KEY (language, version, framework)
    );

    -- Artifacts from Claude.ai conversations (code, documents, diagrams)
    CREATE TABLE IF NOT EXISTS smriti_artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      artifact_id TEXT,
      type TEXT,
      title TEXT,
      command TEXT,
      language TEXT,
      content TEXT,
      created_at TEXT NOT NULL
    );

    -- Thinking blocks (Claude's internal reasoning)
    CREATE TABLE IF NOT EXISTS smriti_thinking (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      thinking TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    -- File attachments with extracted content
    CREATE TABLE IF NOT EXISTS smriti_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      file_name TEXT,
      file_type TEXT,
      file_size INTEGER,
      content TEXT,
      created_at TEXT NOT NULL
    );

    -- Voice note transcripts
    CREATE TABLE IF NOT EXISTS smriti_voice_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      title TEXT,
      transcript TEXT,
      created_at TEXT NOT NULL
    );

    -- Indexes (original)
    CREATE INDEX IF NOT EXISTS idx_smriti_session_meta_agent
      ON smriti_session_meta(agent_id);
    CREATE INDEX IF NOT EXISTS idx_smriti_session_meta_project
      ON smriti_session_meta(project_id);
    CREATE INDEX IF NOT EXISTS idx_smriti_message_tags_category
      ON smriti_message_tags(category_id);
    CREATE INDEX IF NOT EXISTS idx_smriti_session_tags_category
      ON smriti_session_tags(category_id);
    CREATE INDEX IF NOT EXISTS idx_smriti_shares_hash
      ON smriti_shares(content_hash);
    CREATE INDEX IF NOT EXISTS idx_smriti_shares_unit
      ON smriti_shares(unit_id);

    -- Indexes (sidecar tables)
    CREATE INDEX IF NOT EXISTS idx_smriti_tool_usage_session
      ON smriti_tool_usage(session_id);
    CREATE INDEX IF NOT EXISTS idx_smriti_tool_usage_tool_name
      ON smriti_tool_usage(tool_name);
    CREATE INDEX IF NOT EXISTS idx_smriti_file_operations_session
      ON smriti_file_operations(session_id);
    CREATE INDEX IF NOT EXISTS idx_smriti_file_operations_path
      ON smriti_file_operations(file_path);
    CREATE INDEX IF NOT EXISTS idx_smriti_commands_session
      ON smriti_commands(session_id);
    CREATE INDEX IF NOT EXISTS idx_smriti_commands_is_git
      ON smriti_commands(is_git);
    CREATE INDEX IF NOT EXISTS idx_smriti_errors_session
      ON smriti_errors(session_id);
    CREATE INDEX IF NOT EXISTS idx_smriti_errors_type
      ON smriti_errors(error_type);
    CREATE INDEX IF NOT EXISTS idx_smriti_git_operations_session
      ON smriti_git_operations(session_id);
    CREATE INDEX IF NOT EXISTS idx_smriti_git_operations_op
      ON smriti_git_operations(operation);
    CREATE INDEX IF NOT EXISTS idx_smriti_rule_cache_language
      ON smriti_rule_cache(language);

    -- Indexes (claude-web sidecar tables)
    CREATE INDEX IF NOT EXISTS idx_smriti_artifacts_session
      ON smriti_artifacts(session_id);
    CREATE INDEX IF NOT EXISTS idx_smriti_artifacts_type
      ON smriti_artifacts(type);
    CREATE INDEX IF NOT EXISTS idx_smriti_thinking_session
      ON smriti_thinking(session_id);
    CREATE INDEX IF NOT EXISTS idx_smriti_attachments_session
      ON smriti_attachments(session_id);
    CREATE INDEX IF NOT EXISTS idx_smriti_voice_notes_session
      ON smriti_voice_notes(session_id);

    -- Semantic session clusters (#66)
    CREATE TABLE IF NOT EXISTS smriti_session_clusters (
      session_id   TEXT NOT NULL,
      cluster_id   INTEGER NOT NULL,
      cluster_name TEXT,
      distance     REAL,
      PRIMARY KEY (session_id, cluster_id)
    );
    CREATE INDEX IF NOT EXISTS idx_smriti_session_clusters_cluster
      ON smriti_session_clusters(cluster_id);
    CREATE INDEX IF NOT EXISTS idx_smriti_session_clusters_name
      ON smriti_session_clusters(cluster_name);

    -- Query aliases generated by expandQuery (issue #60)
    CREATE TABLE IF NOT EXISTS smriti_session_queries (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      query     TEXT NOT NULL,
      source    TEXT NOT NULL DEFAULT 'enrich',
      created_at TEXT NOT NULL,
      UNIQUE(session_id, query)
    );
    CREATE INDEX IF NOT EXISTS idx_smriti_session_queries_session
      ON smriti_session_queries(session_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS smriti_queries_fts USING fts5(
      session_id UNINDEXED,
      query,
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS smriti_session_queries_ai
      AFTER INSERT ON smriti_session_queries
    BEGIN
      INSERT INTO smriti_queries_fts(rowid, session_id, query)
      VALUES (new.id, new.session_id, new.query);
    END;

    CREATE TRIGGER IF NOT EXISTS smriti_session_queries_ad
      AFTER DELETE ON smriti_session_queries
    BEGIN
      DELETE FROM smriti_queries_fts WHERE rowid = old.id;
    END;
  `);

  // Prune: 'archived' tier support on smriti_knowledge_units (no CHECK
  // constraint on `tier`, so the new value needs no migration — only these
  // two nullable columns, set when a canonical unit is archived because a
  // `supersedes` edge points at it).
  try {
    db.exec(`ALTER TABLE smriti_knowledge_units ADD COLUMN archived_at TEXT`);
  } catch {
    // Column already exists
  }
  try {
    db.exec(`ALTER TABLE smriti_knowledge_units ADD COLUMN archived_reason TEXT`);
  } catch {
    // Column already exists
  }
}

// =============================================================================
// Seed Data
// =============================================================================

/** Default agent definitions */
const DEFAULT_AGENTS = [
  {
    id: "claude-code",
    display_name: "Claude Code",
    log_pattern: "~/.claude/projects/*/*.jsonl",
    parser: "claude",
  },
  {
    id: "codex",
    display_name: "Codex CLI",
    log_pattern: "~/.codex/**/*.jsonl",
    parser: "codex",
  },
  {
    id: "cursor",
    display_name: "Cursor",
    log_pattern: ".cursor/**/*.json",
    parser: "cursor",
  },
  {
    id: "cline",
    display_name: "Cline",
    log_pattern: "~/.cline/tasks/**/*.json",
    parser: "cline",
  },
  {
    id: "copilot",
    display_name: "GitHub Copilot",
    log_pattern: "*/chatSessions/*.json",
    parser: "copilot",
  },
  {
    id: "generic",
    display_name: "Generic Import",
    log_pattern: null,
    parser: "generic",
  },
  {
    id: "claude-web",
    display_name: "Claude.ai",
    log_pattern: null,
    parser: "claude-web",
  },
  {
    id: "team",
    display_name: "Team Import",
    log_pattern: null,
    parser: "generic",
  },
] as const;

/** Default category taxonomy */
const DEFAULT_CATEGORIES: Array<{
  id: string;
  name: string;
  parent_id: string | null;
  description: string;
}> = [
    // Top-level
    { id: "code", name: "Code", parent_id: null, description: "Code-related knowledge" },
    { id: "architecture", name: "Architecture", parent_id: null, description: "System architecture and design" },
    { id: "bug", name: "Bug", parent_id: null, description: "Bugs and debugging" },
    { id: "feature", name: "Feature", parent_id: null, description: "Feature work" },
    { id: "project", name: "Project", parent_id: null, description: "Project setup and configuration" },
    { id: "decision", name: "Decision", parent_id: null, description: "Decisions and rationale" },
    { id: "topic", name: "Topic", parent_id: null, description: "Learning and knowledge topics" },

    // Code children
    { id: "code/implementation", name: "Implementation", parent_id: "code", description: "Code implementation details" },
    { id: "code/pattern", name: "Pattern", parent_id: "code", description: "Design patterns and idioms" },
    { id: "code/review", name: "Review", parent_id: "code", description: "Code review insights" },
    { id: "code/snippet", name: "Snippet", parent_id: "code", description: "Useful code snippets" },

    // Architecture children
    { id: "architecture/design", name: "Design", parent_id: "architecture", description: "System design" },
    { id: "architecture/decision", name: "Decision", parent_id: "architecture", description: "Architecture decisions (ADRs)" },
    { id: "architecture/tradeoff", name: "Tradeoff", parent_id: "architecture", description: "Architecture tradeoffs" },

    // Bug children
    { id: "bug/report", name: "Report", parent_id: "bug", description: "Bug reports" },
    { id: "bug/fix", name: "Fix", parent_id: "bug", description: "Bug fixes" },
    { id: "bug/investigation", name: "Investigation", parent_id: "bug", description: "Bug investigation and debugging" },

    // Feature children
    { id: "feature/requirement", name: "Requirement", parent_id: "feature", description: "Feature requirements" },
    { id: "feature/design", name: "Design", parent_id: "feature", description: "Feature design" },
    { id: "feature/implementation", name: "Implementation", parent_id: "feature", description: "Feature implementation" },

    // Project children
    { id: "project/setup", name: "Setup", parent_id: "project", description: "Project setup and scaffolding" },
    { id: "project/config", name: "Config", parent_id: "project", description: "Configuration" },
    { id: "project/dependency", name: "Dependency", parent_id: "project", description: "Dependencies and package management" },

    // Decision children
    { id: "decision/technical", name: "Technical", parent_id: "decision", description: "Technical decisions" },
    { id: "decision/process", name: "Process", parent_id: "decision", description: "Process decisions" },
    { id: "decision/tooling", name: "Tooling", parent_id: "decision", description: "Tooling decisions" },

    // Topic children
    { id: "topic/learning", name: "Learning", parent_id: "topic", description: "Learning and tutorials" },
    { id: "topic/explanation", name: "Explanation", parent_id: "topic", description: "Explanations and deep dives" },
    { id: "topic/comparison", name: "Comparison", parent_id: "topic", description: "Comparisons and evaluations" },
  ];

/** Seed agents and categories (idempotent) */
export function seedDefaults(db: Database): void {
  const insertAgent = db.prepare(
    `INSERT OR IGNORE INTO smriti_agents(id, display_name, log_pattern, parser)
  VALUES(?, ?, ?, ?)`
  );
  for (const agent of DEFAULT_AGENTS) {
    insertAgent.run(agent.id, agent.display_name, agent.log_pattern, agent.parser);
  }

  const insertCategory = db.prepare(
    `INSERT OR IGNORE INTO smriti_categories(id, name, parent_id, description)
  VALUES(?, ?, ?, ?)`
  );
  for (const cat of DEFAULT_CATEGORIES) {
    insertCategory.run(cat.id, cat.name, cat.parent_id, cat.description);
  }
}

// =============================================================================
// FTS Migration (sidecar content search)
// =============================================================================

/**
 * Migrate memory_fts to v2: adds thinking, artifacts, attachments, voice_notes columns.
 * Drops old FTS table + triggers, rebuilds index from existing data.
 * Idempotent — skips if already migrated.
 */
export function migrateFTSToV2(db: Database): void {
  // Check if migration needed by looking for the 'thinking' column
  const cols = db.prepare("PRAGMA table_info(memory_fts)").all() as { name: string }[];
  if (cols.some((c) => c.name === "thinking")) return;

  console.log("Migrating memory_fts to include sidecar content...");

  // 1. Drop old triggers
  db.exec(`DROP TRIGGER IF EXISTS memory_messages_ai`);
  db.exec(`DROP TRIGGER IF EXISTS memory_messages_ad`);

  // 2. Drop old FTS table
  db.exec(`DROP TABLE IF EXISTS memory_fts`);

  // 3. Create new FTS table with sidecar columns
  db.exec(`
    CREATE VIRTUAL TABLE memory_fts USING fts5(
      session_title, role, content,
      thinking, artifacts, attachments, voice_notes,
      tokenize='porter unicode61'
    )
  `);

  // 4. Rebuild index from existing messages + sidecar data
  db.exec(`
    INSERT INTO memory_fts(
      rowid, session_title, role, content,
      thinking, artifacts, attachments, voice_notes
    )
    SELECT
      mm.id,
      COALESCE(ms.title, ''),
      mm.role,
      mm.content,
      COALESCE((SELECT GROUP_CONCAT(thinking, ' ') FROM smriti_thinking WHERE message_id = mm.id), ''),
      COALESCE((SELECT GROUP_CONCAT(content, ' ') FROM smriti_artifacts WHERE message_id = mm.id), ''),
      COALESCE((SELECT GROUP_CONCAT(content, ' ') FROM smriti_attachments WHERE message_id = mm.id), ''),
      COALESCE((SELECT GROUP_CONCAT(transcript, ' ') FROM smriti_voice_notes WHERE message_id = mm.id), '')
    FROM memory_messages mm
    LEFT JOIN memory_sessions ms ON ms.id = mm.session_id
  `);

  // 5. Create new triggers with sidecar columns
  db.exec(`
    CREATE TRIGGER memory_messages_ai AFTER INSERT ON memory_messages
    BEGIN
      INSERT INTO memory_fts(
        rowid, session_title, role, content,
        thinking, artifacts, attachments, voice_notes
      )
      SELECT
        new.id,
        COALESCE((SELECT title FROM memory_sessions WHERE id = new.session_id), ''),
        new.role,
        new.content,
        COALESCE((SELECT GROUP_CONCAT(thinking, ' ') FROM smriti_thinking WHERE message_id = new.id), ''),
        COALESCE((SELECT GROUP_CONCAT(content, ' ') FROM smriti_artifacts WHERE message_id = new.id), ''),
        COALESCE((SELECT GROUP_CONCAT(content, ' ') FROM smriti_attachments WHERE message_id = new.id), ''),
        COALESCE((SELECT GROUP_CONCAT(transcript, ' ') FROM smriti_voice_notes WHERE message_id = new.id), '');
    END
  `);

  db.exec(`
    CREATE TRIGGER memory_messages_ad AFTER DELETE ON memory_messages
    BEGIN
      DELETE FROM memory_fts WHERE rowid = old.id;
    END
  `);

  console.log("Migration complete.");
}

// =============================================================================
// Convenience
// =============================================================================

/**
 * Initialize the QMD SDK store, then create all Smriti tables.
 * Returns the underlying bun:sqlite Database for Smriti table operations.
 */
export async function initSmriti(dbPath?: string): Promise<Database> {
  const resolvedPath = dbPath || QMD_DB_PATH;
  if (resolvedPath !== ":memory:") {
    try { mkdirSync(dirname(resolvedPath), { recursive: true }); } catch { /* exists */ }
  }
  const store = await createStore({ dbPath: resolvedPath });
  setQmdStore(store);
  const db = store.internal.db as unknown as Database;
  _db = db;
  // busy_timeout is per-connection, not persisted in the DB file — set it on
  // every open. Without it, two processes opening the same SQLite file at
  // once (e.g. the daemon's flush and a manual `smriti ingest --force`) fail
  // immediately with "database is locked" instead of retrying briefly.
  db.exec("PRAGMA busy_timeout = 5000");
  initializeMemoryTables(db as any);
  initializeSmritiTables(db);
  seedDefaults(db);
  migrateFTSToV2(db);

  // Register the smriti-sessions QMD collection when the sessions dir exists
  if (resolvedPath !== ":memory:" && existsSync(SMRITI_SESSIONS_DIR)) {
    try {
      await store.addCollection("smriti-sessions", {
        path: SMRITI_SESSIONS_DIR,
        pattern: "**/*.md",
      });
    } catch { /* collection may already exist */ }
  }

  return db;
}

// =============================================================================
// CRUD Helpers
// =============================================================================

export function upsertProject(
  db: Database,
  id: string,
  path?: string,
  description?: string,
  language?: string,
  framework?: string,
  languageVersion?: string,
  ruleVersion?: string
): void {
  db.prepare(
    `INSERT INTO smriti_projects(id, path, description, language, framework, language_version, rule_version, detected_at)
  VALUES(?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
  path = COALESCE(excluded.path, path),
    description = COALESCE(excluded.description, description),
    language = COALESCE(excluded.language, language),
    framework = COALESCE(excluded.framework, framework),
    language_version = COALESCE(excluded.language_version, language_version),
    rule_version = COALESCE(excluded.rule_version, rule_version),
    detected_at = COALESCE(excluded.detected_at, detected_at)`
  ).run(
    id,
    path || null,
    description || null,
    language || null,
    framework || null,
    languageVersion || null,
    ruleVersion || "1.0.0",
    new Date().toISOString()
  );
}

export function upsertSessionMeta(
  db: Database,
  sessionId: string,
  agentId?: string,
  projectId?: string
): void {
  db.prepare(
    `INSERT INTO smriti_session_meta(session_id, agent_id, project_id) VALUES(?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
  agent_id = COALESCE(excluded.agent_id, agent_id),
    project_id = COALESCE(excluded.project_id, project_id)`
  ).run(sessionId, agentId || null, projectId || null);
}

export function tagMessage(
  db: Database,
  messageId: number,
  categoryId: string,
  confidence: number = 1.0,
  source: string = "manual"
): void {
  db.prepare(
    `INSERT OR REPLACE INTO smriti_message_tags(message_id, category_id, confidence, source)
  VALUES(?, ?, ?, ?)`
  ).run(messageId, categoryId, confidence, source);
}

export function tagSession(
  db: Database,
  sessionId: string,
  categoryId: string,
  confidence: number = 1.0,
  source: string = "manual"
): void {
  db.prepare(
    `INSERT OR REPLACE INTO smriti_session_tags(session_id, category_id, confidence, source)
  VALUES(?, ?, ?, ?)`
  ).run(sessionId, categoryId, confidence, source);
}

export function getCategories(db: Database, parentId?: string): Array<{
  id: string;
  name: string;
  parent_id: string | null;
  description: string;
}> {
  if (parentId !== undefined) {
    return db
      .prepare(
        `SELECT id, name, parent_id, description FROM smriti_categories WHERE parent_id = ? `
      )
      .all(parentId) as any;
  }
  return db
    .prepare(`SELECT id, name, parent_id, description FROM smriti_categories ORDER BY id`)
    .all() as any;
}

export function getCategoryTree(db: Database): Map<
  string,
  { id: string; name: string; description: string; children: string[] }
> {
  const all = getCategories(db);
  const tree = new Map<string, { id: string; name: string; description: string; children: string[] }>();

  // Insert top-level first
  for (const cat of all.filter((c) => !c.parent_id)) {
    tree.set(cat.id, { id: cat.id, name: cat.name, description: cat.description, children: [] });
  }

  // Attach children
  for (const cat of all.filter((c) => c.parent_id)) {
    const parent = tree.get(cat.parent_id!);
    if (parent) parent.children.push(cat.id);
  }

  return tree;
}

export function addCategory(
  db: Database,
  id: string,
  name: string,
  parentId?: string,
  description?: string
): void {
  db.prepare(
    `INSERT INTO smriti_categories(id, name, parent_id, description) VALUES(?, ?, ?, ?)`
  ).run(id, name, parentId || null, description || null);
}

export function listProjects(db: Database): Array<{
  id: string;
  path: string | null;
  description: string | null;
  created_at: string;
}> {
  return db.prepare(`SELECT * FROM smriti_projects ORDER BY created_at DESC`).all() as any;
}

export function listAgents(db: Database): Array<{
  id: string;
  display_name: string;
  log_pattern: string | null;
  parser: string;
}> {
  return db.prepare(`SELECT * FROM smriti_agents ORDER BY id`).all() as any;
}

// =============================================================================
// Project Inspection
// =============================================================================

export type ProjectInspectReport = {
  project: {
    id: string;
    path: string | null;
    description: string | null;
    language: string | null;
    framework: string | null;
  } | null;
  sessionCount: number;
  messageCount: number;
  byAgent: Array<{ agent_id: string | null; session_count: number }>;
  tags: Array<{ category_id: string; session_count: number }>;
  decisionCount: number;
  recentSessions: Array<{
    id: string;
    title: string;
    updated_at: string;
    agent_id: string | null;
    categories: string;
  }>;
};

export type TagUsageEntry = {
  category_id: string;
  session_count: number;
  display_name?: string | null;
};

export function getTagUsage(db: Database, projectId?: string): TagUsageEntry[] {
  let query = `
    SELECT st.category_id, COUNT(DISTINCT st.session_id) as session_count
    FROM smriti_session_tags st`;

  if (projectId) {
    query += `
      JOIN smriti_session_meta sm ON st.session_id = sm.session_id
      WHERE sm.project_id = ?`;
  }

  query += `
    GROUP BY st.category_id
    ORDER BY session_count DESC`;

  const results = projectId
    ? (db.prepare(query).all(projectId) as Array<{ category_id: string; session_count: number }>)
    : (db.prepare(query).all() as Array<{ category_id: string; session_count: number }>);

  return results;
}

export function getProjectReport(db: Database, projectId: string): ProjectInspectReport | null {
  // Get project details
  const projectRow = db
    .prepare(`SELECT id, path, description, language, framework FROM smriti_projects WHERE id = ?`)
    .get(projectId) as any;

  if (!projectRow) {
    return null;
  }

  // Session count
  const sessionCountRow = db
    .prepare(`SELECT COUNT(*) as count FROM smriti_session_meta WHERE project_id = ?`)
    .get(projectId) as { count: number };
  const sessionCount = sessionCountRow.count;

  // Message count
  const messageCountRow = db
    .prepare(
      `SELECT COUNT(*) as count FROM memory_messages mm
       JOIN smriti_session_meta sm ON mm.session_id = sm.session_id
       WHERE sm.project_id = ?`
    )
    .get(projectId) as { count: number };
  const messageCount = messageCountRow.count;

  // Agent breakdown
  const byAgent = db
    .prepare(
      `SELECT sm.agent_id, COUNT(*) as session_count
       FROM smriti_session_meta sm
       WHERE sm.project_id = ?
       GROUP BY sm.agent_id
       ORDER BY session_count DESC`
    )
    .all(projectId) as Array<{ agent_id: string | null; session_count: number }>;

  // Tag breakdown
  const tags = db
    .prepare(
      `SELECT st.category_id, COUNT(DISTINCT st.session_id) as session_count
       FROM smriti_session_tags st
       JOIN smriti_session_meta sm ON st.session_id = sm.session_id
       WHERE sm.project_id = ?
       GROUP BY st.category_id
       ORDER BY session_count DESC`
    )
    .all(projectId) as Array<{ category_id: string; session_count: number }>;

  // Decision count (decision or decision/*)
  const decisionRow = db
    .prepare(
      `SELECT COUNT(DISTINCT st.session_id) as count
       FROM smriti_session_tags st
       JOIN smriti_session_meta sm ON st.session_id = sm.session_id
       WHERE sm.project_id = ?
         AND (st.category_id = 'decision' OR st.category_id LIKE 'decision/%')`
    )
    .get(projectId) as { count: number };
  const decisionCount = decisionRow.count;

  // Recent 5 sessions
  const recentSessions = db
    .prepare(
      `SELECT ms.id, ms.title, ms.updated_at, sm.agent_id,
              COALESCE(GROUP_CONCAT(DISTINCT st.category_id), '') as categories
       FROM memory_sessions ms
       JOIN smriti_session_meta sm ON sm.session_id = ms.id
       LEFT JOIN smriti_session_tags st ON st.session_id = ms.id
       WHERE sm.project_id = ?
       GROUP BY ms.id
       ORDER BY ms.updated_at DESC
       LIMIT 5`
    )
    .all(projectId) as Array<{
    id: string;
    title: string;
    updated_at: string;
    agent_id: string | null;
    categories: string;
  }>;

  return {
    project: {
      id: projectRow.id,
      path: projectRow.path,
      description: projectRow.description,
      language: projectRow.language,
      framework: projectRow.framework,
    },
    sessionCount,
    messageCount,
    byAgent,
    tags,
    decisionCount,
    recentSessions,
  };
}

// =============================================================================
// Sidecar Table Insert Helpers
// =============================================================================

export function insertToolUsage(
  db: Database,
  messageId: number,
  sessionId: string,
  toolName: string,
  inputSummary: string | null,
  success: boolean,
  durationMs: number | null,
  createdAt: string
): void {
  db.prepare(
    `INSERT INTO smriti_tool_usage(message_id, session_id, tool_name, input_summary, success, duration_ms, created_at)
  VALUES(?, ?, ?, ?, ?, ?, ?)`
  ).run(messageId, sessionId, toolName, inputSummary, success ? 1 : 0, durationMs, createdAt);
}

export function insertFileOperation(
  db: Database,
  messageId: number,
  sessionId: string,
  operation: string,
  filePath: string,
  projectId: string | null,
  createdAt: string
): void {
  db.prepare(
    `INSERT INTO smriti_file_operations(message_id, session_id, operation, file_path, project_id, created_at)
  VALUES(?, ?, ?, ?, ?, ?)`
  ).run(messageId, sessionId, operation, filePath, projectId, createdAt);
}

export function insertCommand(
  db: Database,
  messageId: number,
  sessionId: string,
  command: string,
  exitCode: number | null,
  cwd: string | null,
  isGit: boolean,
  createdAt: string
): void {
  db.prepare(
    `INSERT INTO smriti_commands(message_id, session_id, command, exit_code, cwd, is_git, created_at)
  VALUES(?, ?, ?, ?, ?, ?, ?)`
  ).run(messageId, sessionId, command, exitCode, cwd, isGit ? 1 : 0, createdAt);
}

export function insertError(
  db: Database,
  messageId: number,
  sessionId: string,
  errorType: string,
  message: string,
  createdAt: string
): void {
  db.prepare(
    `INSERT INTO smriti_errors(message_id, session_id, error_type, message, created_at)
  VALUES(?, ?, ?, ?, ?)`
  ).run(messageId, sessionId, errorType, message, createdAt);
}

// Per-million-token pricing by model family
const MODEL_PRICING: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-opus-4": { input: 15.0, output: 75.0, cacheRead: 1.5 },
  "claude-sonnet-4": { input: 3.0, output: 15.0, cacheRead: 0.3 },
  "claude-haiku-4": { input: 0.8, output: 4.0, cacheRead: 0.08 },
};
const DEFAULT_PRICING = { input: 3.0, output: 15.0, cacheRead: 0.3 };

export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheTokens: number
): number {
  // Match model family: "claude-sonnet-4-20250514" → "claude-sonnet-4"
  const family = Object.keys(MODEL_PRICING).find((k) => model.startsWith(k));
  const pricing = family ? MODEL_PRICING[family] : DEFAULT_PRICING;
  return (
    (inputTokens * pricing.input +
      outputTokens * pricing.output +
      cacheTokens * pricing.cacheRead) /
    1_000_000
  );
}

export function upsertSessionCosts(
  db: Database,
  sessionId: string,
  model: string | null,
  inputTokens: number,
  outputTokens: number,
  cacheTokens: number,
  durationMs: number
): void {
  const modelName = model || "unknown";
  const cost = estimateCost(modelName, inputTokens, outputTokens, cacheTokens);
  db.prepare(
    `INSERT INTO smriti_session_costs(session_id, model, total_input_tokens, total_output_tokens, total_cache_tokens, estimated_cost_usd, turn_count, total_duration_ms)
  VALUES(?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(session_id, model) DO UPDATE SET
  total_input_tokens = total_input_tokens + excluded.total_input_tokens,
    total_output_tokens = total_output_tokens + excluded.total_output_tokens,
    total_cache_tokens = total_cache_tokens + excluded.total_cache_tokens,
    estimated_cost_usd = estimated_cost_usd + excluded.estimated_cost_usd,
    turn_count = turn_count + 1,
    total_duration_ms = total_duration_ms + excluded.total_duration_ms`
  ).run(sessionId, modelName, inputTokens, outputTokens, cacheTokens, cost, durationMs);
}

export function deleteSidecarRows(db: Database, sessionId: string): void {
  db.prepare(`DELETE FROM smriti_tool_usage WHERE session_id = ?`).run(sessionId);
  db.prepare(`DELETE FROM smriti_file_operations WHERE session_id = ?`).run(sessionId);
  db.prepare(`DELETE FROM smriti_commands WHERE session_id = ?`).run(sessionId);
  db.prepare(`DELETE FROM smriti_errors WHERE session_id = ?`).run(sessionId);
  db.prepare(`DELETE FROM smriti_git_operations WHERE session_id = ?`).run(sessionId);
  db.prepare(`DELETE FROM smriti_session_costs WHERE session_id = ?`).run(sessionId);
}

/**
 * Full sidecar cleanup for a session forget — a superset of deleteSidecarRows
 * (which `ingest --force` uses, needing only the narrower tool/file/command/
 * error/cost set that gets re-derived on re-ingest). Also clears
 * Smriti-specific metadata/content tables that didn't exist when
 * deleteSidecarRows was written. Does NOT touch smriti_knowledge_units or
 * smriti_shares — callers (forgetSession) handle those separately since
 * canonical (promoted) units are kept unless purging shared knowledge.
 */
export function deleteAllSidecarRows(db: Database, sessionId: string): void {
  deleteSidecarRows(db, sessionId);

  db.prepare(
    `DELETE FROM smriti_message_tags WHERE message_id IN (SELECT id FROM memory_messages WHERE session_id = ?)`
  ).run(sessionId);
  db.prepare(`DELETE FROM smriti_session_meta WHERE session_id = ?`).run(sessionId);
  db.prepare(`DELETE FROM smriti_session_tags WHERE session_id = ?`).run(sessionId);
  db.prepare(`DELETE FROM smriti_artifacts WHERE session_id = ?`).run(sessionId);
  db.prepare(`DELETE FROM smriti_thinking WHERE session_id = ?`).run(sessionId);
  db.prepare(`DELETE FROM smriti_attachments WHERE session_id = ?`).run(sessionId);
  db.prepare(`DELETE FROM smriti_voice_notes WHERE session_id = ?`).run(sessionId);
  db.prepare(`DELETE FROM smriti_session_queries WHERE session_id = ?`).run(sessionId);
  db.prepare(`DELETE FROM smriti_session_clusters WHERE session_id = ?`).run(sessionId);
}

export function insertGitOperation(
  db: Database,
  messageId: number,
  sessionId: string,
  operation: string,
  branch: string | null,
  prUrl: string | null,
  prNumber: number | null,
  details: string | null,
  createdAt: string
): void {
  db.prepare(
    `INSERT INTO smriti_git_operations(message_id, session_id, operation, branch, pr_url, pr_number, details, created_at)
  VALUES(?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(messageId, sessionId, operation, branch, prUrl, prNumber, details, createdAt);
}

// =============================================================================
// Claude-Web Sidecar Insert Helpers
// =============================================================================

export function insertArtifact(
  db: Database,
  messageId: number,
  sessionId: string,
  artifactId: string | null,
  type: string | null,
  title: string | null,
  command: string | null,
  language: string | null,
  content: string | null,
  createdAt: string
): void {
  db.prepare(
    `INSERT INTO smriti_artifacts (message_id, session_id, artifact_id, type, title, command, language, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(messageId, sessionId, artifactId, type, title, command, language, content, createdAt);
}

export function insertThinking(
  db: Database,
  messageId: number,
  sessionId: string,
  thinking: string,
  createdAt: string
): void {
  db.prepare(
    `INSERT INTO smriti_thinking (message_id, session_id, thinking, created_at)
     VALUES (?, ?, ?, ?)`
  ).run(messageId, sessionId, thinking, createdAt);
}

export function insertAttachment(
  db: Database,
  messageId: number,
  sessionId: string,
  fileName: string | null,
  fileType: string | null,
  fileSize: number | null,
  content: string | null,
  createdAt: string
): void {
  db.prepare(
    `INSERT INTO smriti_attachments (message_id, session_id, file_name, file_type, file_size, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(messageId, sessionId, fileName, fileType, fileSize, content, createdAt);
}

export function insertVoiceNote(
  db: Database,
  messageId: number,
  sessionId: string,
  title: string | null,
  transcript: string,
  createdAt: string
): void {
  db.prepare(
    `INSERT INTO smriti_voice_notes (message_id, session_id, title, transcript, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(messageId, sessionId, title, transcript, createdAt);
}

// =============================================================================
// Knowledge Density Scoring (#62)
// =============================================================================

export type DensityBreakdown = {
  toolCalls: number;
  fileWrites: number;
  gitOps: number;
  decisionTags: number;
  errors: number;
  totalTokens: number;
  score: number;
};

/**
 * Compute a composite density score (0–1) for a session based on sidecar signals.
 *
 * Weights: tool calls 25%, file writes 25%, git ops 20%, decision tags 15%,
 * errors 10%, token volume 5%. Each signal is linearly capped at a "full" ceiling.
 */
export function computeDensityScore(db: Database, sessionId: string): DensityBreakdown {
  const toolCalls = (db.prepare(
    `SELECT COUNT(*) as n FROM smriti_tool_usage WHERE session_id = ?`
  ).get(sessionId) as { n: number }).n;

  const fileWrites = (db.prepare(
    `SELECT COUNT(*) as n FROM smriti_file_operations
     WHERE session_id = ? AND operation IN ('write', 'edit', 'create')`
  ).get(sessionId) as { n: number }).n;

  const gitOps = (db.prepare(
    `SELECT COUNT(*) as n FROM smriti_git_operations WHERE session_id = ?`
  ).get(sessionId) as { n: number }).n;

  const decisionTags = (db.prepare(
    `SELECT COUNT(*) as n FROM smriti_session_tags
     WHERE session_id = ? AND (category_id = 'decision' OR category_id LIKE 'decision/%')`
  ).get(sessionId) as { n: number }).n;

  const errors = (db.prepare(
    `SELECT COUNT(*) as n FROM smriti_errors WHERE session_id = ?`
  ).get(sessionId) as { n: number }).n;

  const totalTokens = (db.prepare(
    `SELECT COALESCE(SUM(total_input_tokens + total_output_tokens + total_cache_tokens), 0) as n
     FROM smriti_session_costs WHERE session_id = ?`
  ).get(sessionId) as { n: number }).n;

  const score =
    Math.min(toolCalls / 50, 1) * 0.25 +
    Math.min(fileWrites / 20, 1) * 0.25 +
    Math.min(gitOps / 10, 1) * 0.20 +
    Math.min(decisionTags / 3, 1) * 0.15 +
    Math.min(errors / 10, 1) * 0.10 +
    Math.min(totalTokens / 200_000, 1) * 0.05;

  return { toolCalls, fileWrites, gitOps, decisionTags, errors, totalTokens, score };
}

export function updateDensityScore(db: Database, sessionId: string, score: number): void {
  db.prepare(
    `UPDATE smriti_session_meta SET density_score = ? WHERE session_id = ?`
  ).run(score, sessionId);
}

export function getDensityScore(db: Database, sessionId: string): number {
  const row = db.prepare(
    `SELECT density_score FROM smriti_session_meta WHERE session_id = ?`
  ).get(sessionId) as { density_score: number } | null;
  return row?.density_score ?? 0;
}

// =============================================================================
// Knowledge Consolidation (Progressive Summarization)
// =============================================================================

export interface StoredKnowledgeUnit {
  id: string;
  session_id: string;
  project_id: string | null;
  topic: string;
  category: string;
  relevance: number;
  entities: string[];
  files: string[];
  plain_text: string;
  line_ranges: Array<{ start: number; end: number }>;
  content_hash: string;
  tier: "segmented" | "canonical" | "archived";
  retrieval_count: number;
  last_recalled_at: string | null;
  promoted_at: string | null;
  canonical_doc_path: string | null;
  share_id: string | null;
  archived_at: string | null;
  archived_reason: string | null;
}

type KnowledgeUnitRow = {
  id: string;
  session_id: string;
  project_id: string | null;
  topic: string;
  category: string;
  relevance: number;
  entities: string | null;
  files: string | null;
  plain_text: string;
  line_ranges: string | null;
  content_hash: string;
  tier: string;
  retrieval_count: number;
  last_recalled_at: string | null;
  promoted_at: string | null;
  canonical_doc_path: string | null;
  share_id: string | null;
  archived_at: string | null;
  archived_reason: string | null;
};

function deserializeKnowledgeUnit(row: KnowledgeUnitRow): StoredKnowledgeUnit {
  return {
    ...row,
    entities: row.entities ? JSON.parse(row.entities) : [],
    files: row.files ? JSON.parse(row.files) : [],
    line_ranges: row.line_ranges ? JSON.parse(row.line_ranges) : [],
    tier: row.tier as "segmented" | "canonical" | "archived",
  };
}

/**
 * Insert a Stage-1 knowledge unit if its content hash isn't already stored.
 * Returns true if inserted, false if it was a duplicate (caller distinguishes
 * "stored" from "skipped" the same way shareSegmentedKnowledge does for shares).
 */
export function insertKnowledgeUnit(
  db: Database,
  unit: KnowledgeUnit,
  sessionId: string,
  projectId: string | null,
  contentHash: string
): boolean {
  const exists = db
    .prepare(`SELECT 1 FROM smriti_knowledge_units WHERE content_hash = ?`)
    .get(contentHash);
  if (exists) return false;

  db.prepare(
    `INSERT INTO smriti_knowledge_units
      (id, session_id, project_id, topic, category, relevance, entities, files, plain_text, line_ranges, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    unit.id,
    sessionId,
    projectId,
    unit.topic,
    unit.category,
    unit.relevance,
    JSON.stringify(unit.entities || []),
    JSON.stringify(unit.files || []),
    unit.plainText,
    JSON.stringify(unit.lineRanges || []),
    contentHash
  );
  return true;
}

/** Dense sessions (by density_score) that haven't been segmented into knowledge units yet. */
export function findUnsegmentedDenseSessions(
  db: Database,
  minDensity: number,
  limit?: number
): Array<{ session_id: string; project_id: string | null; density_score: number }> {
  const query = `
    SELECT sm.session_id, sm.project_id, sm.density_score
    FROM smriti_session_meta sm
    WHERE sm.density_score >= ?
      AND NOT EXISTS (SELECT 1 FROM smriti_knowledge_units ku WHERE ku.session_id = sm.session_id)
    ORDER BY sm.density_score DESC
    ${limit ? "LIMIT ?" : ""}
  `;
  const rows = limit
    ? db.prepare(query).all(minDensity, limit)
    : db.prepare(query).all(minDensity);
  return rows as Array<{ session_id: string; project_id: string | null; density_score: number }>;
}

/** Segmented units that have proven reuse (via recall) or scored high relevance at extraction time. */
export function findPromotableUnits(
  db: Database,
  minRetrievals: number,
  minRelevance: number,
  minEntityReach?: number
): StoredKnowledgeUnit[] {
  // minEntityReach: a unit is promotable if one of its entities is
  // independently mentioned by >= minEntityReach OTHER units — a structural
  // reuse signal (cross-session recurrence) that doesn't depend on recall()
  // ever having been called on this particular unit.
  const entityReachClause = minEntityReach
    ? `OR id IN (
         SELECT r1.subject_id FROM smriti_relationships r1
         JOIN smriti_relationships r2
           ON r1.object_id = r2.object_id AND r2.predicate = 'mentions'
          AND r1.predicate = 'mentions' AND r1.subject_id != r2.subject_id
         WHERE r1.subject_type = 'knowledge_unit'
         GROUP BY r1.subject_id
         HAVING COUNT(DISTINCT r2.subject_id) >= ?
       )`
    : "";
  const params = minEntityReach
    ? [minRetrievals, minRelevance, minEntityReach]
    : [minRetrievals, minRelevance];

  const rows = db
    .prepare(
      `SELECT * FROM smriti_knowledge_units
       WHERE tier = 'segmented' AND (retrieval_count >= ? OR relevance >= ? ${entityReachClause})`
    )
    .all(...params) as KnowledgeUnitRow[];
  return rows.map(deserializeKnowledgeUnit);
}

/** Bump retrieval_count for any knowledge units belonging to a recalled session. No-op if none exist yet. */
export function incrementRetrievalCount(db: Database, sessionId: string): void {
  db.prepare(
    `UPDATE smriti_knowledge_units
     SET retrieval_count = retrieval_count + 1,
         last_recalled_at = datetime('now'),
         updated_at = datetime('now')
     WHERE session_id = ?`
  ).run(sessionId);
}

export function promoteKnowledgeUnit(
  db: Database,
  unitId: string,
  canonicalDocPath: string,
  shareId: string
): void {
  db.prepare(
    `UPDATE smriti_knowledge_units
     SET tier = 'canonical', promoted_at = datetime('now'),
         canonical_doc_path = ?, share_id = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(canonicalDocPath, shareId, unitId);
}

export function listKnowledgeUnits(
  db: Database,
  options: { tier?: "segmented" | "canonical" | "archived"; minRetrievals?: number; limit?: number } = {}
): StoredKnowledgeUnit[] {
  const conditions: string[] = [];
  const params: any[] = [];

  if (options.tier) {
    conditions.push("tier = ?");
    params.push(options.tier);
  }
  if (options.minRetrievals !== undefined) {
    conditions.push("retrieval_count >= ?");
    params.push(options.minRetrievals);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limitClause = options.limit ? "LIMIT ?" : "";
  if (options.limit) params.push(options.limit);

  const rows = db
    .prepare(
      `SELECT * FROM smriti_knowledge_units ${where}
       ORDER BY retrieval_count DESC, relevance DESC
       ${limitClause}`
    )
    .all(...params) as KnowledgeUnitRow[];
  return rows.map(deserializeKnowledgeUnit);
}

/** Cascade-delete relationship edges where this knowledge unit is subject or object. */
function deleteKnowledgeUnitRelationships(db: Database, unitId: string): void {
  db.prepare(
    `DELETE FROM smriti_relationships WHERE subject_type = 'knowledge_unit' AND subject_id = ?`
  ).run(unitId);
  db.prepare(
    `DELETE FROM smriti_relationships WHERE object_type = 'knowledge_unit' AND object_id = ?`
  ).run(unitId);
}

/**
 * Hard-delete a knowledge unit and its relationship edges. Shared by
 * forgetSession (removing unpromoted units of a forgotten session) and
 * pruneKnowledge (removing stale segmented units) — safe in both cases
 * because a 'segmented' unit was never promoted, so nothing external
 * (canonical doc, smriti_shares row) references it.
 */
export function deleteKnowledgeUnit(db: Database, unitId: string): void {
  deleteKnowledgeUnitRelationships(db, unitId);
  db.prepare(`DELETE FROM smriti_knowledge_units WHERE id = ?`).run(unitId);
}

/**
 * Segmented units that failed both promotion paths — the relevance escape
 * hatch mirrors findPromotableUnits' own minRelevance, so a unit one
 * `consolidate` run away from promoting is never a prune candidate — and are
 * old enough that they're unlikely to ever clear the bar.
 */
export function findStaleSegmentedUnits(
  db: Database,
  maxAgeDays: number,
  minRelevance: number
): StoredKnowledgeUnit[] {
  const rows = db
    .prepare(
      `SELECT * FROM smriti_knowledge_units
       WHERE tier = 'segmented' AND retrieval_count = 0 AND relevance < ?
         AND created_at < datetime('now', '-' || ? || ' days')`
    )
    .all(minRelevance, maxAgeDays) as KnowledgeUnitRow[];
  return rows.map(deserializeKnowledgeUnit);
}

/** Canonical units with an incoming `supersedes` edge (some other unit supersedes them) that aren't already archived. */
export function findSupersededCanonicalUnits(
  db: Database
): Array<StoredKnowledgeUnit & { supersededByUnitId: string; supersededByTopic: string }> {
  const rows = db
    .prepare(
      `SELECT ku.*, r.subject_id AS supersededByUnitId, super_ku.topic AS supersededByTopic
       FROM smriti_knowledge_units ku
       JOIN smriti_relationships r
         ON r.object_type = 'knowledge_unit' AND r.object_id = ku.id AND r.predicate = 'supersedes'
       JOIN smriti_knowledge_units super_ku ON super_ku.id = r.subject_id
       WHERE ku.tier = 'canonical'`
    )
    .all() as Array<KnowledgeUnitRow & { supersededByUnitId: string; supersededByTopic: string }>;
  return rows.map((r) => ({ ...deserializeKnowledgeUnit(r), supersededByUnitId: r.supersededByUnitId, supersededByTopic: r.supersededByTopic }));
}

/** Soft-archive a canonical unit — tier -> 'archived', archived_at/reason set. The unit's relationship edges (including the supersedes edge that justified this) are left untouched as the audit trail. */
export function archiveKnowledgeUnit(db: Database, unitId: string, reason: string): void {
  db.prepare(
    `UPDATE smriti_knowledge_units
     SET tier = 'archived', archived_at = datetime('now'), archived_reason = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(reason, unitId);
}

// =============================================================================
// Forget (session deletion)
// =============================================================================

export type ForgetOptions = {
  /** Permanently delete instead of the default soft delete (active = 0). */
  hard?: boolean;
  /** Only meaningful with hard: true. Also delete canonical (promoted) units, their smriti_shares row, and their .smriti/knowledge/*.md doc — normally kept since they've already been shared. */
  purgeShared?: boolean;
  /** Where canonical docs live, for purgeShared's file deletion. Defaults to the same convention consolidateKnowledge uses. */
  outputDir?: string;
};

export type ForgetResult = {
  sessionId: string;
  hard: boolean;
  unitsDeleted: number; // unpromoted (segmented) knowledge units removed
  unitsPurged: number; // canonical units removed, only when purgeShared
  canonicalKept: number; // canonical units left in place
};

/**
 * Forget a session. Soft delete (default) just flips memory_sessions.active
 * to 0 — reversible, and already understood by `list --all`/`listSessions`.
 * Hard delete removes messages, all sidecar rows, unpromoted knowledge
 * units, and orphaned vector embeddings; canonical (promoted) units are kept
 * unless purgeShared is set, since they may already be referenced outside
 * this session (team sync, a committed .smriti/knowledge/ doc).
 */
export function forgetSession(
  db: Database,
  sessionId: string,
  options: ForgetOptions = {}
): ForgetResult {
  const hard = options.hard ?? false;
  const purgeShared = options.purgeShared ?? false;
  const result: ForgetResult = {
    sessionId,
    hard,
    unitsDeleted: 0,
    unitsPurged: 0,
    canonicalKept: 0,
  };

  if (!hard) {
    deleteSession(db as any, sessionId, false);
    return result;
  }

  const units = db
    .prepare(
      `SELECT id, tier, canonical_doc_path FROM smriti_knowledge_units WHERE session_id = ?`
    )
    .all(sessionId) as Array<{ id: string; tier: string; canonical_doc_path: string | null }>;

  const outputDir = options.outputDir || join(process.cwd(), SMRITI_DIR);

  for (const u of units) {
    if (u.tier !== "canonical") {
      deleteKnowledgeUnit(db, u.id);
      result.unitsDeleted++;
      continue;
    }
    if (!purgeShared) {
      result.canonicalKept++;
      continue;
    }
    deleteKnowledgeUnit(db, u.id);
    db.prepare(`DELETE FROM smriti_shares WHERE unit_id = ?`).run(u.id);
    if (u.canonical_doc_path) {
      try {
        unlinkSync(join(outputDir, u.canonical_doc_path));
      } catch {
        // Doc already gone or never written under this outputDir — fine.
      }
    }
    result.unitsPurged++;
  }

  deleteAllSidecarRows(db, sessionId);
  deleteSession(db as any, sessionId, true);
  cleanupOrphanedMemoryVectors(db as any);

  return result;
}

// =============================================================================
// Session Query Labels (#60)
// =============================================================================

export function insertSessionQueries(
  db: Database,
  sessionId: string,
  queries: string[],
  source: string = "enrich"
): number {
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO smriti_session_queries(session_id, query, source, created_at)
     VALUES (?, ?, ?, ?)`
  );
  let inserted = 0;
  for (const q of queries) {
    const trimmed = q.trim();
    if (trimmed) {
      const result = stmt.run(sessionId, trimmed, source, now);
      inserted += result.changes;
    }
  }
  return inserted;
}

export function getSessionQueryCount(db: Database, sessionId: string): number {
  return (db.prepare(
    `SELECT COUNT(*) as n FROM smriti_session_queries WHERE session_id = ?`
  ).get(sessionId) as { n: number }).n;
}

// =============================================================================
// QMD Document Index (#59 Phase 4)
// =============================================================================

export function getSessionDocPath(sessionId: string): string {
  const { join } = require("path");
  const { SMRITI_SESSIONS_DIR: dir } = require("./config");
  return join(dir, `${sessionId}.md`);
}

export function buildSessionDocument(
  sessionId: string,
  title: string,
  agentId: string | null,
  projectId: string | null,
  createdAt: string,
  messages: { role: string; content: string }[]
): string {
  const lines: string[] = [
    `# ${title || sessionId}`,
    "",
    `agent: ${agentId || "unknown"}`,
    `project: ${projectId || "unknown"}`,
    `date: ${createdAt.split("T")[0]}`,
    `session_id: ${sessionId}`,
    "",
  ];
  for (const msg of messages) {
    lines.push(`**${msg.role}**: ${msg.content}`);
    lines.push("");
  }
  return lines.join("\n");
}

export async function writeSessionDocument(
  db: Database,
  sessionId: string,
  agentId: string | null,
  projectId: string | null
): Promise<void> {
  const { SMRITI_SESSIONS_DIR: dir } = await import("./config");
  const { mkdirSync: mkDir, writeFileSync } = await import("fs");
  mkDir(dir, { recursive: true });

  const session = db.prepare(
    `SELECT title, created_at FROM memory_sessions WHERE id = ?`
  ).get(sessionId) as { title: string; created_at: string } | null;
  if (!session) return;

  const messages = db.prepare(
    `SELECT role, content FROM memory_messages WHERE session_id = ? ORDER BY created_at ASC`
  ).all(sessionId) as { role: string; content: string }[];

  const content = buildSessionDocument(sessionId, session.title, agentId, projectId, session.created_at, messages);
  const { join } = await import("path");
  writeFileSync(join(dir, `${sessionId}.md`), content, "utf-8");
}

export function getUnenrichedSessionIds(db: Database, projectId?: string): string[] {
  const baseQuery = `
    SELECT sm.session_id
    FROM smriti_session_meta sm
    LEFT JOIN smriti_session_queries sq ON sq.session_id = sm.session_id
    WHERE sq.session_id IS NULL
    ${projectId ? "AND sm.project_id = ?" : ""}
  `;
  const rows = projectId
    ? db.prepare(baseQuery).all(projectId) as { session_id: string }[]
    : db.prepare(baseQuery).all() as { session_id: string }[];
  return rows.map(r => r.session_id);
}
