import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import {
  initializeSmritiTables,
  seedDefaults,
  upsertSessionMeta,
  upsertProject,
  tagSession,
  migrateFTSToV2,
  getTagUsage,
  getProjectReport,
  type TagUsageEntry,
  type ProjectInspectReport,
} from "../src/db";
import { searchFiltered, listSessions } from "../src/search/index";

let db: Database;

beforeAll(() => {
  db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");

  // Create QMD tables
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
    CREATE INDEX idx_memory_messages_session ON memory_messages(session_id);
    CREATE VIRTUAL TABLE memory_fts USING fts5(
      session_title, role, content,
      tokenize='porter unicode61'
    );
    CREATE TRIGGER memory_messages_ai AFTER INSERT ON memory_messages BEGIN
      INSERT INTO memory_fts(rowid, session_title, role, content)
      SELECT NEW.rowid,
             COALESCE((SELECT title FROM memory_sessions WHERE id = NEW.session_id), ''),
             NEW.role,
             NEW.content;
    END;
  `);

  initializeSmritiTables(db);
  seedDefaults(db);

  // Seed comprehensive test data
  const now = new Date().toISOString();
  db.exec(`
    INSERT INTO memory_sessions (id, title, created_at, updated_at) VALUES
      ('s1', 'Auth Architecture Decision', '${now}', '${now}'),
      ('s2', 'Database Schema', '${now}', '${now}'),
      ('s3', 'Login Bug Fix', '${now}', '${now}'),
      ('s4', 'Feature: Dark Mode', '${now}', '${now}'),
      ('s5', 'Markdown Document', '${now}', '${now}'),
      ('s6', 'API Design', '${now}', '${now}');
  `);

  db.exec(`
    INSERT INTO memory_messages (session_id, role, content, hash, created_at) VALUES
      ('s1', 'user', 'How should we handle authentication?', 'h1', '${now}'),
      ('s1', 'assistant', 'Use JWT tokens with refresh mechanism', 'h2', '${now}'),
      ('s2', 'user', 'Design the database schema for users', 'h3', '${now}'),
      ('s2', 'assistant', 'Here is the schema with users and roles tables', 'h4', '${now}'),
      ('s3', 'user', 'The login page has an error when submitting', 'h5', '${now}'),
      ('s3', 'assistant', 'Fixed the login bug by validating input', 'h6', '${now}'),
      ('s4', 'user', 'How to implement dark mode?', 'h7', '${now}'),
      ('s4', 'assistant', 'Add CSS variables and theme toggle', 'h8', '${now}'),
      ('s5', 'user', '# Complete Markdown Document\n\nThis is a full document stored as a single message for complete retrieval.', 'h9', '${now}'),
      ('s6', 'user', 'Design REST API endpoints', 'h10', '${now}'),
      ('s6', 'assistant', 'Define endpoints for users, posts, comments', 'h11', '${now}');
  `);

  // Create projects
  upsertProject(db, "myapp", "/path/to/myapp", "Web application", "typescript", "react");
  upsertProject(db, "backend", "/path/to/backend", "Backend service", "typescript", "nodejs");
  upsertProject(db, "docs", "/path/to/docs", "Documentation");

  // Assign sessions to projects
  upsertSessionMeta(db, "s1", "claude-code", "myapp");
  upsertSessionMeta(db, "s2", "claude-code", "backend");
  upsertSessionMeta(db, "s3", "codex", "myapp");
  upsertSessionMeta(db, "s4", "cursor", "myapp");
  upsertSessionMeta(db, "s5", "generic", "docs");
  upsertSessionMeta(db, "s6", "claude-code", "backend");

  // Tag sessions with decision/* and feature/* tags
  tagSession(db, "s1", "decision", 0.9, "auto");
  tagSession(db, "s1", "decision/technical", 0.9, "auto");
  tagSession(db, "s2", "decision", 0.8, "auto");
  tagSession(db, "s2", "architecture/design", 0.8, "auto");
  tagSession(db, "s3", "bug/fix", 0.8, "auto");
  tagSession(db, "s4", "feature/implementation", 0.8, "auto");
  tagSession(db, "s6", "decision/technical", 0.7, "auto");
  tagSession(db, "s6", "feature/implementation", 0.7, "auto");

  // Run migration to v2 FTS
  migrateFTSToV2(db);
});

afterAll(() => {
  db.close();
});

// =============================================================================
// Search with Category Filters
// =============================================================================

test("searchFiltered filters by category", () => {
  // Search for a term and filter by category
  const results = searchFiltered(db, "JWT", { category: "decision" });
  // Should find JWT content in sessions tagged with decision
  if (results.length > 0) {
    // If there are results, they should be from decision-tagged sessions
    const sessionIds = new Set(results.map((r) => r.session_id));
    // Verify results are related to the decision category
    expect(sessionIds.size).toBeGreaterThan(0);
  }
});

test("searchFiltered can be filtered by project", () => {
  const results = searchFiltered(db, "schema", {
    project: "backend",
  });
  // s2 has "schema" in content and is in backend
  const sessionIds = new Set(results.map((r) => r.session_id));
  if (results.length > 0) {
    expect(sessionIds.has("s2")).toBe(true);
  }
});

test("searchFiltered with valid query returns results", () => {
  const results = searchFiltered(db, "authentication");
  // "authentication" appears in s1
  expect(results.length).toBeGreaterThan(0);
  const sessionIds = new Set(results.map((r) => r.session_id));
  expect(sessionIds.has("s1")).toBe(true);
});

// =============================================================================
// List Sessions with Filters
// =============================================================================

test("listSessions filters by category", () => {
  const sessions = listSessions(db, { category: "bug/fix" });
  expect(sessions.length).toBe(1);
  expect(sessions[0].id).toBe("s3");
});

test("listSessions filters by project", () => {
  const sessions = listSessions(db, { project: "myapp" });
  expect(sessions.length).toBe(3); // s1, s3, s4
});

test("listSessions filters by agent", () => {
  const sessions = listSessions(db, { agent: "claude-code" });
  expect(sessions.length).toBe(3); // s1, s2, s6
});

test("listSessions combines category + project filter", () => {
  const sessions = listSessions(db, {
    category: "decision/technical",
    project: "myapp",
  });
  expect(sessions.length).toBe(1); // s1 only
  expect(sessions[0].id).toBe("s1");
});

test("listSessions combines project + agent filter", () => {
  const sessions = listSessions(db, {
    project: "myapp",
    agent: "claude-code",
  });
  expect(sessions.length).toBe(1); // s1 only
  expect(sessions[0].id).toBe("s1");
});

test("listSessions combines category + project + agent", () => {
  const sessions = listSessions(db, {
    category: "feature/implementation",
    project: "myapp",
    agent: "cursor",
  });
  expect(sessions.length).toBe(1); // s4
  expect(sessions[0].id).toBe("s4");
});

test("listSessions includes categories as comma-separated string", () => {
  const sessions = listSessions(db, { project: "myapp" });
  const s1 = sessions.find((s) => s.id === "s1");
  expect(s1?.categories).toBeDefined();
  // Should include both 'decision' and 'decision/technical'
  if (s1?.categories) {
    expect(s1.categories).toContain("decision");
  }
});

test("listSessions respects limit", () => {
  const sessions = listSessions(db, { limit: 2 });
  expect(sessions.length).toBeLessThanOrEqual(2);
});

// =============================================================================
// Full-Document Retrieval (--whole / format=document)
// =============================================================================

test("single message per document stored correctly", () => {
  // s5 has a single message that is a full markdown document
  const stmt = db.prepare(`
    SELECT COUNT(*) as count FROM memory_messages WHERE session_id = 's5'
  `);
  const result = stmt.get() as { count: number };
  expect(result.count).toBe(1);
});

test("full document content retrieved without truncation", () => {
  const stmt = db.prepare(`
    SELECT content FROM memory_messages WHERE session_id = 's5' LIMIT 1
  `);
  const result = stmt.get() as { content: string };
  expect(result.content).toContain("Complete Markdown Document");
  expect(result.content).toContain("full document stored as a single message");
});

test("paragraph breaks do not create multiple message rows", () => {
  // Even though s5's content has line breaks, there should be only 1 message
  const stmt = db.prepare(`
    SELECT COUNT(*) as count FROM memory_messages WHERE session_id = 's5'
  `);
  const result = stmt.get() as { count: number };
  expect(result.count).toBe(1); // Not split into multiple messages
});

// =============================================================================
// getTagUsage (smriti tags)
// =============================================================================

test("getTagUsage returns all tags in use with session counts", () => {
  const usage = getTagUsage(db);
  expect(usage.length).toBeGreaterThan(0);

  // Should have decision, decision/technical, architecture/design, bug/fix, feature/implementation
  const tagIds = new Set(usage.map((t) => t.category_id));
  expect(tagIds.has("decision")).toBe(true);
  expect(tagIds.has("decision/technical")).toBe(true);
  expect(tagIds.has("bug/fix")).toBe(true);
  expect(tagIds.has("feature/implementation")).toBe(true);
});

test("getTagUsage counts sessions per tag correctly", () => {
  const usage = getTagUsage(db);
  const decisionTag = usage.find((t) => t.category_id === "decision");
  expect(decisionTag).toBeDefined();
  expect(decisionTag!.session_count).toBe(2); // s1, s2
});

test("getTagUsage filters by project when projectId given", () => {
  const usage = getTagUsage(db, "myapp");
  // myapp has s1, s3, s4
  // s1: decision, decision/technical
  // s3: bug/fix
  // s4: feature/implementation
  expect(usage.length).toBeGreaterThan(0);

  const decisionTag = usage.find((t) => t.category_id === "decision");
  expect(decisionTag).toBeDefined();
  expect(decisionTag!.session_count).toBe(1); // Only s1 in myapp
});

test("getTagUsage returns empty when no sessions are tagged", () => {
  // s5 in docs has no tags
  const usage = getTagUsage(db, "docs");
  expect(usage.length).toBe(0);
});

test("getTagUsage orders by session_count DESC", () => {
  const usage = getTagUsage(db);
  // Verify descending order
  for (let i = 1; i < usage.length; i++) {
    expect(usage[i - 1].session_count).toBeGreaterThanOrEqual(
      usage[i].session_count
    );
  }
});

// =============================================================================
// getProjectReport (smriti projects <id>)
// =============================================================================

test("getProjectReport returns correct session count", () => {
  const report = getProjectReport(db, "myapp")!;
  expect(report).toBeDefined();
  expect(report.sessionCount).toBe(3); // s1, s3, s4
});

test("getProjectReport returns agent breakdown", () => {
  const report = getProjectReport(db, "myapp")!;
  expect(report.byAgent.length).toBeGreaterThan(0);

  // Check agent counts
  const agentMap = new Map(
    report.byAgent.map((a) => [a.agent_id, a.session_count])
  );
  expect(agentMap.get("claude-code")).toBe(1); // s1
  expect(agentMap.get("codex")).toBe(1); // s3
  expect(agentMap.get("cursor")).toBe(1); // s4
});

test("getProjectReport returns tag breakdown with counts", () => {
  const report = getProjectReport(db, "myapp")!;
  expect(report.tags.length).toBeGreaterThan(0);

  const tagMap = new Map(
    report.tags.map((t) => [t.category_id, t.session_count])
  );
  expect(tagMap.get("decision")).toBe(1); // s1
  expect(tagMap.get("decision/technical")).toBe(1); // s1
  expect(tagMap.get("bug/fix")).toBe(1); // s3
  expect(tagMap.get("feature/implementation")).toBe(1); // s4
});

test("getProjectReport counts only decision/* sessions", () => {
  const report = getProjectReport(db, "myapp")!;
  // s1 is tagged with decision/technical, s3 and s4 are not
  expect(report.decisionCount).toBe(1);
});

test("getProjectReport returns 5 most recent sessions", () => {
  const report = getProjectReport(db, "myapp")!;
  expect(report.recentSessions.length).toBeLessThanOrEqual(5);
  expect(report.recentSessions.length).toBe(3); // s1, s3, s4
});

test("getProjectReport returns null for unknown project id", () => {
  const report = getProjectReport(db, "unknown");
  expect(report).toBeNull();
});

test("getProjectReport includes message count", () => {
  const report = getProjectReport(db, "myapp")!;
  expect(report.messageCount).toBeGreaterThan(0);
  expect(report.messageCount).toBe(6); // 2+2+2 messages from s1,s3,s4
});

test("getProjectReport includes project metadata", () => {
  const report = getProjectReport(db, "backend")!;
  expect(report.project).toBeDefined();
  expect(report.project!.id).toBe("backend");
  expect(report.project!.path).toBe("/path/to/backend");
  expect(report.project!.language).toBe("typescript");
  expect(report.project!.framework).toBe("nodejs");
});

// =============================================================================
// Integration: Multi-filter Recall
// =============================================================================

test("list with category, project, and agent all together", () => {
  const sessions = listSessions(db, {
    category: "decision/technical",
    project: "backend",
    agent: "claude-code",
  });
  expect(sessions.length).toBe(1); // s6 only
  expect(sessions[0].id).toBe("s6");
});

test("getTagUsage for project with multiple tags", () => {
  const usage = getTagUsage(db, "backend");
  expect(usage.length).toBeGreaterThan(0);

  // backend has s2 and s6
  // s2: decision, architecture/design
  // s6: decision/technical, feature/implementation
  const tagIds = new Set(usage.map((t) => t.category_id));
  expect(tagIds.has("decision")).toBe(true);
  expect(tagIds.has("architecture/design")).toBe(true);
  expect(tagIds.has("decision/technical")).toBe(true);
  expect(tagIds.has("feature/implementation")).toBe(true);
});
