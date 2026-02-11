/**
 * db.ts - Database schema, migrations, and connection for Smriti
 *
 * Uses the shared QMD SQLite database. All Smriti tables are prefixed with
 * `smriti_` to avoid collisions. Does NOT alter existing QMD tables.
 */

import { Database } from "bun:sqlite";
import { QMD_DB_PATH } from "./config";

// =============================================================================
// Connection
// =============================================================================

let _db: Database | null = null;

/** Get or create the shared database connection */
export function getDb(path?: string): Database {
  if (_db) return _db;
  _db = new Database(path || QMD_DB_PATH);
  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec("PRAGMA foreign_keys = ON");
  return _db;
}

/** Close the database connection */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
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
      content_hash TEXT
    );

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

    -- Token/cost tracking per session
    CREATE TABLE IF NOT EXISTS smriti_session_costs (
      session_id TEXT PRIMARY KEY,
      model TEXT,
      total_input_tokens INTEGER DEFAULT 0,
      total_output_tokens INTEGER DEFAULT 0,
      total_cache_tokens INTEGER DEFAULT 0,
      estimated_cost_usd REAL DEFAULT 0,
      turn_count INTEGER DEFAULT 0,
      total_duration_ms INTEGER DEFAULT 0
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
  `);
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
    `INSERT OR IGNORE INTO smriti_agents (id, display_name, log_pattern, parser)
     VALUES (?, ?, ?, ?)`
  );
  for (const agent of DEFAULT_AGENTS) {
    insertAgent.run(agent.id, agent.display_name, agent.log_pattern, agent.parser);
  }

  const insertCategory = db.prepare(
    `INSERT OR IGNORE INTO smriti_categories (id, name, parent_id, description)
     VALUES (?, ?, ?, ?)`
  );
  for (const cat of DEFAULT_CATEGORIES) {
    insertCategory.run(cat.id, cat.name, cat.parent_id, cat.description);
  }
}

// =============================================================================
// Convenience
// =============================================================================

/** Initialize DB, create tables, seed defaults. Returns the DB instance. */
export function initSmriti(dbPath?: string): Database {
  const db = getDb(dbPath);
  initializeSmritiTables(db);
  seedDefaults(db);
  return db;
}

// =============================================================================
// CRUD Helpers
// =============================================================================

export function upsertProject(
  db: Database,
  id: string,
  path?: string,
  description?: string
): void {
  db.prepare(
    `INSERT INTO smriti_projects (id, path, description) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       path = COALESCE(excluded.path, path),
       description = COALESCE(excluded.description, description)`
  ).run(id, path || null, description || null);
}

export function upsertSessionMeta(
  db: Database,
  sessionId: string,
  agentId?: string,
  projectId?: string
): void {
  db.prepare(
    `INSERT INTO smriti_session_meta (session_id, agent_id, project_id) VALUES (?, ?, ?)
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
    `INSERT OR REPLACE INTO smriti_message_tags (message_id, category_id, confidence, source)
     VALUES (?, ?, ?, ?)`
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
    `INSERT OR REPLACE INTO smriti_session_tags (session_id, category_id, confidence, source)
     VALUES (?, ?, ?, ?)`
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
        `SELECT id, name, parent_id, description FROM smriti_categories WHERE parent_id = ?`
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
    `INSERT INTO smriti_categories (id, name, parent_id, description) VALUES (?, ?, ?, ?)`
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
    `INSERT INTO smriti_tool_usage (message_id, session_id, tool_name, input_summary, success, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
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
    `INSERT INTO smriti_file_operations (message_id, session_id, operation, file_path, project_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
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
    `INSERT INTO smriti_commands (message_id, session_id, command, exit_code, cwd, is_git, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
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
    `INSERT INTO smriti_errors (message_id, session_id, error_type, message, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(messageId, sessionId, errorType, message, createdAt);
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
  db.prepare(
    `INSERT INTO smriti_session_costs (session_id, model, total_input_tokens, total_output_tokens, total_cache_tokens, turn_count, total_duration_ms)
     VALUES (?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       model = COALESCE(excluded.model, model),
       total_input_tokens = total_input_tokens + excluded.total_input_tokens,
       total_output_tokens = total_output_tokens + excluded.total_output_tokens,
       total_cache_tokens = total_cache_tokens + excluded.total_cache_tokens,
       turn_count = turn_count + 1,
       total_duration_ms = total_duration_ms + excluded.total_duration_ms`
  ).run(sessionId, model, inputTokens, outputTokens, cacheTokens, durationMs);
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
    `INSERT INTO smriti_git_operations (message_id, session_id, operation, branch, pr_url, pr_number, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(messageId, sessionId, operation, branch, prUrl, prNumber, details, createdAt);
}
