import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeMemoryTables } from "../src/qmd";
import {
  initializeSmritiTables,
  seedDefaults,
  getCategories,
  getCategoryTree,
  addCategory,
  upsertProject,
  upsertSessionMeta,
  tagMessage,
  tagSession,
  listProjects,
  listAgents,
} from "../src/db";

let db: Database;

beforeAll(() => {
  db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");

  // Create core QMD tables
  initializeMemoryTables(db);

  // Create Smriti-specific tables
  initializeSmritiTables(db);
  seedDefaults(db);
});

afterAll(() => {
  db.close();
});

test("creates all smriti tables", () => {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'smriti_%' ORDER BY name`
    )
    .all() as { name: string }[];

  const names = tables.map((t) => t.name);
  expect(names).toContain("smriti_agents");
  expect(names).toContain("smriti_projects");
  expect(names).toContain("smriti_session_meta");
  expect(names).toContain("smriti_categories");
  expect(names).toContain("smriti_message_tags");
  expect(names).toContain("smriti_session_tags");
  expect(names).toContain("smriti_shares");
});

test("seeds default agents", () => {
  const agents = listAgents(db);
  expect(agents.length).toBeGreaterThanOrEqual(3);

  const ids = agents.map((a) => a.id);
  expect(ids).toContain("claude-code");
  expect(ids).toContain("codex");
  expect(ids).toContain("cursor");
});

test("seeds default categories", () => {
  const categories = getCategories(db);
  expect(categories.length).toBeGreaterThanOrEqual(28); // 7 top + 21 children

  // Check top-level
  const topLevel = categories.filter((c) => !c.parent_id);
  expect(topLevel.length).toBe(7);

  // Check a child
  const bugFix = categories.find((c) => c.id === "bug/fix");
  expect(bugFix).toBeDefined();
  expect(bugFix!.parent_id).toBe("bug");
});

test("getCategoryTree returns hierarchical structure", () => {
  const tree = getCategoryTree(db);
  expect(tree.size).toBe(7); // 7 top-level

  const code = tree.get("code");
  expect(code).toBeDefined();
  expect(code!.children.length).toBe(4);
  expect(code!.children).toContain("code/pattern");
});

test("addCategory creates custom category", () => {
  addCategory(db, "custom/test", "Test Category", "code", "A test category");
  const cats = getCategories(db, "code");
  const custom = cats.find((c) => c.id === "custom/test");
  expect(custom).toBeDefined();
  expect(custom!.name).toBe("Test Category");
});

test("upsertProject creates and updates projects", () => {
  upsertProject(db, "myapp", "/path/to/myapp", "My App");
  let projects = listProjects(db);
  let p = projects.find((p) => p.id === "myapp");
  expect(p).toBeDefined();
  expect(p!.path).toBe("/path/to/myapp");

  // Update
  upsertProject(db, "myapp", "/new/path");
  projects = listProjects(db);
  p = projects.find((p) => p.id === "myapp");
  expect(p!.path).toBe("/new/path");
});

test("upsertSessionMeta links session to agent and project", () => {
  // Create a session first
  db.prepare(
    `INSERT INTO memory_sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`
  ).run("test-session-1", "Test Session", new Date().toISOString(), new Date().toISOString());

  upsertProject(db, "testproj");
  upsertSessionMeta(db, "test-session-1", "claude-code", "testproj");

  const meta = db
    .prepare(`SELECT * FROM smriti_session_meta WHERE session_id = ?`)
    .get("test-session-1") as any;
  expect(meta.agent_id).toBe("claude-code");
  expect(meta.project_id).toBe("testproj");
});

test("tagMessage and tagSession work correctly", () => {
  // Create a message
  db.prepare(
    `INSERT INTO memory_messages (session_id, role, content, hash, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run("test-session-1", "user", "Fix the auth bug", "hash1", new Date().toISOString());

  const msgId = Number(
    (db.prepare(`SELECT last_insert_rowid() as id`).get() as any).id
  );

  tagMessage(db, msgId, "bug/fix", 0.9, "auto");
  tagSession(db, "test-session-1", "bug", 0.8, "auto");

  const msgTags = db
    .prepare(`SELECT * FROM smriti_message_tags WHERE message_id = ?`)
    .all(msgId) as any[];
  expect(msgTags.length).toBe(1);
  expect(msgTags[0].category_id).toBe("bug/fix");
  expect(msgTags[0].confidence).toBe(0.9);

  const sessionTags = db
    .prepare(`SELECT * FROM smriti_session_tags WHERE session_id = ?`)
    .all("test-session-1") as any[];
  expect(sessionTags.length).toBe(1);
  expect(sessionTags[0].category_id).toBe("bug");
});

test("seedDefaults is idempotent", () => {
  const countBefore = (
    db.prepare(`SELECT COUNT(*) as c FROM smriti_categories`).get() as any
  ).c;
  seedDefaults(db);
  const countAfter = (
    db.prepare(`SELECT COUNT(*) as c FROM smriti_categories`).get() as any
  ).c;
  // Should be same (INSERT OR IGNORE) except for the custom one we added
  expect(countAfter).toBe(countBefore);
});
