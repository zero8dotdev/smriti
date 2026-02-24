import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeMemoryTables } from "../src/qmd";
import { initializeSmritiTables, seedDefaults, upsertSessionMeta, upsertProject, tagSession } from "../src/db";
import { listSessions } from "../src/search/index";

let db: Database;

beforeAll(() => {
  db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");

  // Create core QMD tables
  initializeMemoryTables(db);

  initializeSmritiTables(db);
  seedDefaults(db);

  // Seed test data
  const now = new Date().toISOString();
  db.exec(`
    INSERT INTO memory_sessions (id, title, created_at, updated_at) VALUES
      ('s1', 'Auth Setup', '${now}', '${now}'),
      ('s2', 'Database Design', '${now}', '${now}'),
      ('s3', 'Bug Fix Login', '${now}', '${now}');
  `);

  db.exec(`
    INSERT INTO memory_messages (session_id, role, content, hash, created_at) VALUES
      ('s1', 'user', 'How should we handle authentication?', 'h1', '${now}'),
      ('s1', 'assistant', 'Use JWT tokens with refresh mechanism', 'h2', '${now}'),
      ('s2', 'user', 'Design the database schema for users', 'h3', '${now}'),
      ('s2', 'assistant', 'Here is the schema with users and roles tables', 'h4', '${now}'),
      ('s3', 'user', 'The login page has an error when submitting', 'h5', '${now}'),
      ('s3', 'assistant', 'Fixed the login bug by validating input', 'h6', '${now}');
  `);

  upsertProject(db, "myapp", "/path/to/myapp");
  upsertProject(db, "other", "/path/to/other");

  upsertSessionMeta(db, "s1", "claude-code", "myapp");
  upsertSessionMeta(db, "s2", "claude-code", "myapp");
  upsertSessionMeta(db, "s3", "codex", "other");

  tagSession(db, "s1", "decision", 0.8, "auto");
  tagSession(db, "s2", "architecture", 0.8, "auto");
  tagSession(db, "s3", "bug", 0.8, "auto");
});

afterAll(() => {
  db.close();
});

test("listSessions returns all active sessions", () => {
  const sessions = listSessions(db);
  expect(sessions.length).toBe(3);
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
