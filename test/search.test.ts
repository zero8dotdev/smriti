import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import {
  initializeSmritiTables,
  seedDefaults,
  upsertSessionMeta,
  upsertProject,
  tagSession,
  migrateFTSToV2,
  insertArtifact,
  insertThinking,
  insertAttachment,
  insertVoiceNote,
} from "../src/db";
import { searchFiltered, listSessions } from "../src/search/index";
import { buildMemoryFTS5Query } from "../src/memory";

let db: Database;

beforeAll(() => {
  db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");

  // Create QMD tables with old 3-column FTS (pre-migration)
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

  // Seed test data
  const now = new Date().toISOString();
  db.exec(`
    INSERT INTO memory_sessions (id, title, created_at, updated_at) VALUES
      ('s1', 'Auth Setup', '${now}', '${now}'),
      ('s2', 'Database Design', '${now}', '${now}'),
      ('s3', 'Bug Fix Login', '${now}', '${now}'),
      ('s4', 'Claude Web Chat', '${now}', '${now}');
  `);

  db.exec(`
    INSERT INTO memory_messages (session_id, role, content, hash, created_at) VALUES
      ('s1', 'user', 'How should we handle authentication?', 'h1', '${now}'),
      ('s1', 'assistant', 'Use JWT tokens with refresh mechanism', 'h2', '${now}'),
      ('s2', 'user', 'Design the database schema for users', 'h3', '${now}'),
      ('s2', 'assistant', 'Here is the schema with users and roles tables', 'h4', '${now}'),
      ('s3', 'user', 'The login page has an error when submitting', 'h5', '${now}'),
      ('s3', 'assistant', 'Fixed the login bug by validating input', 'h6', '${now}'),
      ('s4', 'user', 'Help me build a tax calculator', 'h7', '${now}'),
      ('s4', 'assistant', 'Here is a tax calculator implementation', 'h8', '${now}'),
      ('s1', 'user', 'Bumped qmd to 2026.4.10 using node-llama-cpp and sqlite-vec', 'h9', '${now}');
  `);

  // Insert sidecar content for s4 (claude-web session)
  // message_id 8 = the assistant response in s4
  insertArtifact(db, 8, "s4", "art-1", "code", "Tax Calculator", "create", "typescript",
    "function calculateTax(income: number): number { return income * 0.3; }", now);
  insertThinking(db, 8, "s4",
    "Let me think step by step about the marginal tax bracket calculation", now);
  insertAttachment(db, 7, "s4", "tax-rules.pdf", "application/pdf", 1024,
    "Withholding tables for employers: standard deduction amounts and exemption thresholds", now);
  insertVoiceNote(db, 7, "s4", "Tax requirements",
    "I need a calculator that handles progressive tax brackets for US federal income tax", now);

  upsertProject(db, "myapp", "/path/to/myapp");
  upsertProject(db, "other", "/path/to/other");
  upsertProject(db, "taxapp", "/path/to/taxapp");

  upsertSessionMeta(db, "s1", "claude-code", "myapp");
  upsertSessionMeta(db, "s2", "claude-code", "myapp");
  upsertSessionMeta(db, "s3", "codex", "other");
  upsertSessionMeta(db, "s4", "claude-web", "taxapp");

  tagSession(db, "s1", "decision", 0.8, "auto");
  tagSession(db, "s2", "architecture", 0.8, "auto");
  tagSession(db, "s3", "bug", 0.8, "auto");

  // Run migration to v2 FTS (adds sidecar columns and rebuilds index)
  migrateFTSToV2(db);
});

afterAll(() => {
  db.close();
});

test("listSessions returns all active sessions", () => {
  const sessions = listSessions(db);
  expect(sessions.length).toBe(4);
});

test("listSessions filters by project", () => {
  const sessions = listSessions(db, { project: "myapp" });
  expect(sessions.length).toBe(2);
  expect(sessions.every((s) => s.project_id === "myapp")).toBe(true);
});

test("listSessions filters by agent", () => {
  const sessions = listSessions(db, { agent: "codex" });
  expect(sessions.length).toBe(1);
  expect(sessions[0].agent_id).toBe("codex");
});

test("listSessions filters by category", () => {
  const sessions = listSessions(db, { category: "bug" });
  expect(sessions.length).toBe(1);
  expect(sessions[0].id).toBe("s3");
});

test("listSessions combines filters", () => {
  const sessions = listSessions(db, {
    agent: "claude-code",
    project: "myapp",
  });
  expect(sessions.length).toBe(2);
});

test("listSessions respects limit", () => {
  const sessions = listSessions(db, { limit: 1 });
  expect(sessions.length).toBe(1);
});

// =============================================================================
// FTS v2: Sidecar Content Search
// =============================================================================

test("FTS v2 migration adds sidecar columns", () => {
  const cols = db.prepare("PRAGMA table_info(memory_fts)").all() as { name: string }[];
  const colNames = cols.map((c) => c.name);
  expect(colNames).toContain("thinking");
  expect(colNames).toContain("artifacts");
  expect(colNames).toContain("attachments");
  expect(colNames).toContain("voice_notes");
});

test("searchFiltered finds artifact content", () => {
  const results = searchFiltered(db, "calculateTax");
  expect(results.length).toBeGreaterThan(0);
  expect(results[0].session_id).toBe("s4");
});

test("searchFiltered finds attachment content", () => {
  const results = searchFiltered(db, "withholding employers");
  expect(results.length).toBeGreaterThan(0);
  expect(results.some((r) => r.session_id === "s4")).toBe(true);
});

test("searchFiltered finds voice note content", () => {
  const results = searchFiltered(db, "progressive tax");
  expect(results.length).toBeGreaterThan(0);
  expect(results.some((r) => r.session_id === "s4")).toBe(true);
});

test("searchFiltered excludes thinking by default", () => {
  // "marginal tax bracket" only appears in thinking blocks
  const results = searchFiltered(db, "marginal bracket");
  expect(results.length).toBe(0);
});

test("searchFiltered includes thinking when opted in", () => {
  const results = searchFiltered(db, "marginal bracket", {
    includeThinking: true,
  });
  expect(results.length).toBeGreaterThan(0);
  expect(results[0].session_id).toBe("s4");
});

test("searchFiltered respects --no-artifacts", () => {
  // "calculateTax" only appears in artifact content
  const results = searchFiltered(db, "calculateTax", {
    includeArtifacts: false,
  });
  expect(results.length).toBe(0);
});

test("searchFiltered respects --no-attachments", () => {
  // "withholding" only appears in attachment content
  const results = searchFiltered(db, "withholding", {
    includeAttachments: false,
  });
  expect(results.length).toBe(0);
});

test("searchFiltered respects --no-voice-notes", () => {
  // "progressive" only appears in voice note transcript
  const results = searchFiltered(db, "progressive", {
    includeVoiceNotes: false,
  });
  expect(results.length).toBe(0);
});

test("searchFiltered still finds regular content", () => {
  const results = searchFiltered(db, "JWT tokens");
  expect(results.length).toBeGreaterThan(0);
  expect(results[0].session_id).toBe("s1");
});

test("searchFiltered combines sidecar + metadata filters", () => {
  const results = searchFiltered(db, "calculateTax", {
    agent: "claude-web",
  });
  expect(results.length).toBeGreaterThan(0);

  const noResults = searchFiltered(db, "calculateTax", {
    agent: "claude-code",
  });
  expect(noResults.length).toBe(0);
});

test("migrateFTSToV2 is idempotent", () => {
  // Running migration again should be a no-op
  migrateFTSToV2(db);
  const cols = db.prepare("PRAGMA table_info(memory_fts)").all() as { name: string }[];
  expect(cols.some((c) => c.name === "thinking")).toBe(true);

  // Data should still be intact
  const results = searchFiltered(db, "calculateTax");
  expect(results.length).toBeGreaterThan(0);
});

// Regression: user queries were interpolated into the FTS5 MATCH expression
// verbatim, so punctuation was parsed as FTS5 grammar rather than tokenized.
// "node-llama-cpp" raised `no such column: llama` and "2026.4.10" raised
// `fts5: syntax error near "."`. Mirrors QMD upstream #563.

test("searchFiltered matches hyphenated terms instead of erroring", () => {
  const results = searchFiltered(db, "node-llama-cpp", { limit: 10 });
  expect(results.length).toBeGreaterThan(0);
  expect(results.some((r) => r.session_id === "s1")).toBe(true);
});

test("searchFiltered matches dotted version strings", () => {
  const results = searchFiltered(db, "2026.4.10", { limit: 10 });
  expect(results.length).toBeGreaterThan(0);
  expect(results.some((r) => r.session_id === "s1")).toBe(true);
});

test("searchFiltered still narrows — punctuated queries are ANDed, not dropped", () => {
  expect(searchFiltered(db, "sqlite-vec", { limit: 10 }).length).toBeGreaterThan(0);
  expect(searchFiltered(db, "nothing-here-xyz", { limit: 10 }).length).toBe(0);
});

test("buildMemoryFTS5Query tokenizes on the same boundaries as the index", () => {
  expect(buildMemoryFTS5Query("node-llama-cpp")).toBe('"node"* AND "llama"* AND "cpp"*');
  expect(buildMemoryFTS5Query("2026.4.10")).toBe('"2026"* AND "4"* AND "10"*');
  expect(buildMemoryFTS5Query("plain")).toBe('"plain"*');
  expect(buildMemoryFTS5Query("   ")).toBe(null);
  expect(buildMemoryFTS5Query("!!!")).toBe(null);
});
