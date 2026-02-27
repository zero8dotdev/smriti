import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeMemoryTables } from "../src/qmd";
import { initializeSmritiTables, seedDefaults, upsertSessionMeta } from "../src/db";
import { resolveSession } from "../src/ingest/session-resolver";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  initializeMemoryTables(db);
  initializeSmritiTables(db);
  seedDefaults(db);
});

afterEach(() => {
  db.close();
});

test("resolveSession marks new session and counts zero existing messages", () => {
  const r = resolveSession({
    db,
    sessionId: "s-new",
    agentId: "codex",
  });

  expect(r.isNew).toBe(true);
  expect(r.existingMessageCount).toBe(0);
  expect(r.projectId).toBeNull();
});

test("resolveSession marks existing session and counts existing messages", () => {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO memory_sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`
  ).run("s1", "Session 1", now, now);

  db.prepare(
    `INSERT INTO memory_messages (session_id, role, content, hash, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run("s1", "user", "hello", "h1", now);

  db.prepare(
    `INSERT INTO memory_messages (session_id, role, content, hash, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run("s1", "assistant", "world", "h2", now);

  upsertSessionMeta(db, "s1", "codex");

  const r = resolveSession({
    db,
    sessionId: "s1",
    agentId: "codex",
  });

  expect(r.isNew).toBe(false);
  expect(r.existingMessageCount).toBe(2);
});

test("resolveSession uses explicit project id over derived project", () => {
  const r = resolveSession({
    db,
    sessionId: "s2",
    agentId: "cursor",
    projectDir: "/tmp/projects/my-app",
    explicitProjectId: "team/core-app",
    explicitProjectPath: "/opt/work/core-app",
  });

  expect(r.projectId).toBe("team/core-app");
  expect(r.projectPath).toBe("/opt/work/core-app");
});

test("resolveSession derives cursor project from basename", () => {
  const r = resolveSession({
    db,
    sessionId: "s3",
    agentId: "cursor",
    projectDir: "/Users/test/work/my-repo",
  });

  expect(r.projectId).toBe("my-repo");
  expect(r.projectPath).toBe("/Users/test/work/my-repo");
});
