import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeSmritiTables, seedDefaults } from "../src/db";
import {
  detectProject,
  gatherContext,
  renderContext,
  spliceContext,
  generateContext,
  resolveSessionId,
  gatherSessionMetrics,
  compareSessions,
  formatCompare,
} from "../src/context";

// =============================================================================
// Setup — in-memory DB with QMD + Smriti tables
// =============================================================================

let db: Database;

beforeAll(() => {
  db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");

  // Minimal QMD tables
  db.exec(`
    CREATE TABLE memory_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      summary TEXT,
      summary_at TEXT,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE memory_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      metadata TEXT,
      FOREIGN KEY (session_id) REFERENCES memory_sessions(id) ON DELETE CASCADE
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      session_title, role, content,
      content='memory_messages',
      content_rowid='id'
    );
  `);

  initializeSmritiTables(db);
  seedDefaults(db);
});

afterAll(() => {
  db.close();
});

// =============================================================================
// detectProject
// =============================================================================

test("detectProject returns null for unknown cwd", () => {
  const result = detectProject(db, "/nonexistent/path");
  expect(result).toBeNull();
});

test("detectProject returns correct ID when path matches", () => {
  // Register a project
  db.prepare(
    `INSERT OR IGNORE INTO smriti_projects (id, path) VALUES (?, ?)`
  ).run("test-proj", "/Users/test/myproject");

  const result = detectProject(db, "/Users/test/myproject");
  expect(result).toBe("test-proj");
});

// =============================================================================
// gatherContext
// =============================================================================

test("gatherContext returns empty sections for project with no data", () => {
  db.prepare(
    `INSERT OR IGNORE INTO smriti_projects (id, path) VALUES (?, ?)`
  ).run("empty-proj", "/Users/test/empty");

  const ctx = gatherContext(db, "empty-proj", 7);
  expect(ctx.sessions).toHaveLength(0);
  expect(ctx.hotFiles).toHaveLength(0);
  expect(ctx.gitActivity).toHaveLength(0);
  expect(ctx.errors).toHaveLength(0);
  expect(ctx.usage).toBeNull();
});

test("gatherContext populates all sections when data exists", () => {
  const now = new Date().toISOString();
  const projId = "full-proj";

  // Create project
  db.prepare(
    `INSERT OR IGNORE INTO smriti_projects (id, path) VALUES (?, ?)`
  ).run(projId, "/Users/test/fullproject");

  // Create session
  db.prepare(
    `INSERT INTO memory_sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`
  ).run("ctx-s1", "Implement context command", now, now);

  db.prepare(
    `INSERT INTO smriti_session_meta (session_id, agent_id, project_id) VALUES (?, ?, ?)`
  ).run("ctx-s1", "claude-code", projId);

  // Create message
  db.prepare(
    `INSERT INTO memory_messages (session_id, role, content, hash, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run("ctx-s1", "assistant", "test content", "hash-ctx1", now);
  const msgId = Number(
    (db.prepare("SELECT last_insert_rowid() as id").get() as any).id
  );

  // Session costs
  db.prepare(
    `INSERT INTO smriti_session_costs (session_id, model, total_input_tokens, total_output_tokens, total_cache_tokens, turn_count, total_duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run("ctx-s1", "claude-opus-4-6", 50000, 15000, 5000, 12, 60000);

  // Session tags
  db.prepare(
    `INSERT OR IGNORE INTO smriti_session_tags (session_id, category_id, confidence, source) VALUES (?, ?, ?, ?)`
  ).run("ctx-s1", "code", 0.9, "auto");

  // File operations
  db.prepare(
    `INSERT INTO smriti_file_operations (message_id, session_id, operation, file_path, project_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(msgId, "ctx-s1", "read", "src/db.ts", projId, now);
  db.prepare(
    `INSERT INTO smriti_file_operations (message_id, session_id, operation, file_path, project_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(msgId, "ctx-s1", "write", "src/db.ts", projId, now);
  db.prepare(
    `INSERT INTO smriti_file_operations (message_id, session_id, operation, file_path, project_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(msgId, "ctx-s1", "read", "src/index.ts", projId, now);

  // Git operations
  db.prepare(
    `INSERT INTO smriti_git_operations (message_id, session_id, operation, branch, pr_url, pr_number, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    msgId, "ctx-s1", "commit", "main", null, null,
    JSON.stringify({ message: "Fix auth token refresh" }), now
  );

  // Errors
  db.prepare(
    `INSERT INTO smriti_errors (message_id, session_id, error_type, message, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(msgId, "ctx-s1", "tool_failure", "File not found", now);
  db.prepare(
    `INSERT INTO smriti_errors (message_id, session_id, error_type, message, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(msgId, "ctx-s1", "tool_failure", "Permission denied", now);

  const ctx = gatherContext(db, projId, 7);

  expect(ctx.sessions.length).toBeGreaterThan(0);
  expect(ctx.sessions[0].title).toBe("Implement context command");
  expect(ctx.sessions[0].turnCount).toBe(12);
  expect(ctx.sessions[0].categories).toContain("code");

  expect(ctx.hotFiles.length).toBeGreaterThan(0);
  expect(ctx.hotFiles[0].filePath).toBe("src/db.ts");
  expect(ctx.hotFiles[0].ops).toBe(2);

  expect(ctx.gitActivity.length).toBeGreaterThan(0);
  expect(ctx.gitActivity[0].operation).toBe("commit");
  expect(ctx.gitActivity[0].branch).toBe("main");

  expect(ctx.errors.length).toBeGreaterThan(0);
  expect(ctx.errors[0].errorType).toBe("tool_failure");
  expect(ctx.errors[0].count).toBe(2);

  expect(ctx.usage).not.toBeNull();
  expect(ctx.usage!.sessions).toBe(1);
  expect(ctx.usage!.turns).toBe(12);
  expect(ctx.usage!.inputTokens).toBe(50000);
  expect(ctx.usage!.outputTokens).toBe(15000);
});

// =============================================================================
// renderContext
// =============================================================================

test("renderContext omits empty sections gracefully", () => {
  const emptyCtx = {
    sessions: [],
    hotFiles: [],
    gitActivity: [],
    errors: [],
    usage: null,
  };

  const result = renderContext(emptyCtx, "some-proj");
  expect(result).toBe("");
});

test("renderContext output is under 1000 tokens estimate", () => {
  const ctx = {
    sessions: [
      { id: "s1", title: "Fix auth bug", updatedAt: new Date().toISOString(), turnCount: 12, categories: "code" },
      { id: "s2", title: "Add search", updatedAt: new Date(Date.now() - 86400000).toISOString(), turnCount: 8, categories: "feature" },
    ],
    hotFiles: [
      { filePath: "src/db.ts", ops: 14, lastOp: "write", lastAt: new Date().toISOString() },
      { filePath: "src/search/index.ts", ops: 8, lastOp: "read", lastAt: new Date().toISOString() },
    ],
    gitActivity: [
      { operation: "commit", branch: "main", details: JSON.stringify({ message: "Fix auth" }), createdAt: new Date().toISOString() },
    ],
    errors: [
      { errorType: "tool_failure", count: 3 },
    ],
    usage: { sessions: 5, turns: 48, inputTokens: 125000, outputTokens: 35000 },
  };

  const result = renderContext(ctx, "myapp", 7);
  expect(result).toContain("## Project Context");
  expect(result).toContain("### Recent Sessions");
  expect(result).toContain("### Hot Files");
  expect(result).toContain("### Git Activity");
  expect(result).toContain("### Recent Errors");
  expect(result).toContain("### Usage");

  const tokenEstimate = Math.ceil(result.length / 4);
  expect(tokenEstimate).toBeLessThan(1000);
});

// =============================================================================
// spliceContext
// =============================================================================

test("spliceContext inserts into empty file", () => {
  const existing = "# Team Knowledge\n\nGenerated by smriti.\n";
  const block = "## Project Context\n\n> Auto-generated.\n\n### Usage\n5 sessions";

  const result = spliceContext(existing, block);
  expect(result).toContain("# Team Knowledge");
  expect(result).toContain("## Project Context");
  expect(result).toContain("### Usage");
});

test("spliceContext replaces existing context section", () => {
  const existing = [
    "# Team Knowledge",
    "",
    "## Project Context",
    "",
    "> Old context",
    "",
    "### Old Section",
    "old data",
    "",
    "## code",
    "",
    "- [some-file](knowledge/code/file.md)",
    "",
  ].join("\n");

  const newBlock = "## Project Context\n\n> New context\n\n### Usage\nnew data";

  const result = spliceContext(existing, newBlock);

  // Should have the new context
  expect(result).toContain("> New context");
  expect(result).toContain("### Usage");
  expect(result).toContain("new data");

  // Should NOT have old context
  expect(result).not.toContain("> Old context");
  expect(result).not.toContain("### Old Section");

  // Should preserve knowledge index
  expect(result).toContain("## code");
  expect(result).toContain("some-file");
});

test("spliceContext preserves knowledge index sections", () => {
  const existing = [
    "# Team Knowledge",
    "",
    "This directory contains shared knowledge.",
    "",
    "## architecture",
    "",
    "- [arch-doc](knowledge/architecture/doc.md)",
    "",
    "## code",
    "",
    "- [code-doc](knowledge/code/doc.md)",
    "",
  ].join("\n");

  const block = "## Project Context\n\n> Auto-generated.\n\n### Sessions\n- session 1";

  const result = spliceContext(existing, block);

  // Context should come before knowledge sections
  const ctxIdx = result.indexOf("## Project Context");
  const archIdx = result.indexOf("## architecture");
  const codeIdx = result.indexOf("## code");

  expect(ctxIdx).toBeGreaterThan(-1);
  expect(archIdx).toBeGreaterThan(ctxIdx);
  expect(codeIdx).toBeGreaterThan(ctxIdx);

  // All knowledge sections preserved
  expect(result).toContain("## architecture");
  expect(result).toContain("arch-doc");
  expect(result).toContain("## code");
  expect(result).toContain("code-doc");
});

// =============================================================================
// generateContext (integration)
// =============================================================================

test("generateContext --dry-run does not write to disk", async () => {
  // Use the project we already set up
  const result = await generateContext(db, {
    project: "full-proj",
    dryRun: true,
  });

  expect(result.written).toBe(false);
  expect(result.path).toBeNull();
  expect(result.context).toContain("## Project Context");
  expect(result.tokenEstimate).toBeGreaterThan(0);
});

// =============================================================================
// Session Comparison
// =============================================================================

test("resolveSessionId returns null for unknown session", () => {
  expect(resolveSessionId(db, "nonexistent-id")).toBeNull();
});

test("resolveSessionId resolves exact and prefix matches", () => {
  expect(resolveSessionId(db, "ctx-s1")).toBe("ctx-s1");
  // Prefix match (unique prefix)
  expect(resolveSessionId(db, "ctx-s")).toBe("ctx-s1");
});

test("gatherSessionMetrics returns correct metrics", () => {
  const metrics = gatherSessionMetrics(db, "ctx-s1");

  expect(metrics.id).toBe("ctx-s1");
  expect(metrics.title).toBe("Implement context command");
  expect(metrics.turnCount).toBe(12);
  expect(metrics.inputTokens).toBe(50000);
  expect(metrics.outputTokens).toBe(15000);
  expect(metrics.totalTokens).toBe(65000);
  expect(metrics.errors).toBe(2);
});

test("compareSessions computes correct diffs", () => {
  // Create a second session to compare against
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO memory_sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`
  ).run("ctx-s2", "Second session", now, now);
  db.prepare(
    `INSERT INTO smriti_session_meta (session_id, agent_id, project_id) VALUES (?, ?, ?)`
  ).run("ctx-s2", "claude-code", "full-proj");
  db.prepare(
    `INSERT INTO smriti_session_costs (session_id, model, total_input_tokens, total_output_tokens, total_cache_tokens, turn_count, total_duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run("ctx-s2", "claude-opus-4-6", 30000, 10000, 2000, 6, 30000);

  const result = compareSessions(db, "ctx-s1", "ctx-s2");

  expect(result.a.turnCount).toBe(12);
  expect(result.b.turnCount).toBe(6);
  expect(result.diff.turns).toBe(-6);
  expect(result.diff.tokens).toBeLessThan(0); // B used fewer tokens

  // formatCompare should produce readable output
  const formatted = formatCompare(result);
  expect(formatted).toContain("Session A:");
  expect(formatted).toContain("Session B:");
  expect(formatted).toContain("Turns");
  expect(formatted).toContain("Total tokens");
});
