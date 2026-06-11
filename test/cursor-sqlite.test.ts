/**
 * cursor-sqlite.test.ts
 *
 * Tests for the Cursor SQLite-based ingest path.
 * Creates fixture SQLite databases in a temp dir — never touches the real home dir.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  resolveComposerMessages,
  discoverCursorSqliteSessions,
  buildComposerWorkspaceMap,
  parseCursorJson,
} from "../src/ingest/cursor";

import { initializeMemoryTables } from "../src/qmd";
import { initializeSmritiTables, seedDefaults } from "../src/db";
import { ingest } from "../src/ingest/index";

// =============================================================================
// Helpers
// =============================================================================

function createGlobalDb(path: string) {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);
  `);
  return db;
}

function createWorkspaceDb(path: string) {
  const db = new Database(path);
  db.exec(`CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value TEXT);`);
  return db;
}

function insertComposer(
  db: Database,
  composerId: string,
  data: Record<string, unknown>
) {
  db.prepare(
    `INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES (?, ?)`
  ).run(`composerData:${composerId}`, JSON.stringify({ composerId, ...data }));
}

function insertBubble(
  db: Database,
  composerId: string,
  bubbleId: string,
  type: number,
  text: string,
  createdAt?: string
) {
  const data: Record<string, unknown> = { type, bubbleId, text };
  if (createdAt) data.createdAt = createdAt;
  db.prepare(
    `INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES (?, ?)`
  ).run(`bubbleId:${composerId}:${bubbleId}`, JSON.stringify(data));
}

// =============================================================================
// resolveComposerMessages
// =============================================================================

test("resolveComposerMessages: inline conversation (older format)", () => {
  const composer = {
    composerId: "comp1",
    conversation: [
      { bubbleId: "b1", type: 1, text: "Hello from user" },
      { bubbleId: "b2", type: 2, text: "Hello back" },
      { bubbleId: "b3", type: 1, text: "" }, // empty — skip
    ],
  };
  const msgs = resolveComposerMessages(composer, new Map());
  expect(msgs.length).toBe(2);
  expect(msgs[0].role).toBe("user");
  expect(msgs[0].content).toBe("Hello from user");
  expect(msgs[1].role).toBe("assistant");
  expect(msgs[1].content).toBe("Hello back");
});

test("resolveComposerMessages: fullConversationHeadersOnly + bubble lookup (newer format)", () => {
  const bubbleMap = new Map([
    ["b1", { type: 1, text: "User question", bubbleId: "b1" }],
    ["b2", { type: 2, text: "Assistant answer", bubbleId: "b2", createdAt: "2025-11-20T10:00:00Z" }],
  ]);
  const composer = {
    composerId: "comp2",
    fullConversationHeadersOnly: [
      { bubbleId: "b1", type: 1 },
      { bubbleId: "b2", type: 2 },
    ],
  };
  const msgs = resolveComposerMessages(composer, bubbleMap);
  expect(msgs.length).toBe(2);
  expect(msgs[0].role).toBe("user");
  expect(msgs[0].content).toBe("User question");
  expect(msgs[1].role).toBe("assistant");
  expect(msgs[1].content).toBe("Assistant answer");
  expect(msgs[1].timestamp).toBe("2025-11-20T10:00:00Z");
});

test("resolveComposerMessages: inline conversation takes priority over headers", () => {
  const composer = {
    composerId: "comp3",
    conversation: [
      { bubbleId: "b1", type: 1, text: "From inline" },
    ],
    fullConversationHeadersOnly: [
      { bubbleId: "b99", type: 1 }, // would return nothing from empty map
    ],
  };
  const msgs = resolveComposerMessages(composer, new Map());
  expect(msgs.length).toBe(1);
  expect(msgs[0].content).toBe("From inline");
});

test("resolveComposerMessages: skips bubbles not in map", () => {
  const bubbleMap = new Map([
    ["b1", { type: 1, text: "Present bubble", bubbleId: "b1" }],
  ]);
  const composer = {
    composerId: "comp4",
    fullConversationHeadersOnly: [
      { bubbleId: "b1", type: 1 },
      { bubbleId: "b_missing", type: 2 }, // not in map
    ],
  };
  const msgs = resolveComposerMessages(composer, bubbleMap);
  expect(msgs.length).toBe(1);
  expect(msgs[0].content).toBe("Present bubble");
});

test("resolveComposerMessages: skips unknown type numbers", () => {
  const composer = {
    composerId: "comp5",
    conversation: [
      { bubbleId: "b1", type: 99, text: "Unknown type" }, // type 99 = skip
      { bubbleId: "b2", type: 1, text: "Valid user" },
    ],
  };
  const msgs = resolveComposerMessages(composer, new Map());
  expect(msgs.length).toBe(1);
  expect(msgs[0].content).toBe("Valid user");
});

// =============================================================================
// discoverCursorSqliteSessions
// =============================================================================

let tmpDir: string;
let globalDb: Database;
let globalDbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "smriti-cursor-test-"));
  globalDbPath = join(tmpDir, "global.vscdb");
  globalDb = createGlobalDb(globalDbPath);
});

afterEach(() => {
  globalDb.close();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Windows: SQLite file-lock release can lag close(), making rm throw
    // EBUSY. The dir is under tmpdir() on an ephemeral runner — leak is fine.
  }
});

test("discoverCursorSqliteSessions: fullConversationHeadersOnly with 2 bubbles", () => {
  const composerId = "test-composer-headers";
  insertComposer(globalDb, composerId, {
    createdAt: 1700000000000,
    fullConversationHeadersOnly: [
      { bubbleId: "b1", type: 1 },
      { bubbleId: "b2", type: 2 },
    ],
  });
  insertBubble(globalDb, composerId, "b1", 1, "What is TypeScript?");
  insertBubble(globalDb, composerId, "b2", 2, "TypeScript is a typed superset of JavaScript.");
  globalDb.close();

  const sessions = discoverCursorSqliteSessions(globalDbPath, new Map());
  expect(sessions.length).toBe(1);
  expect(sessions[0].meta.sessionId).toBe(`cursor-${composerId}`);
  expect(sessions[0].messages.length).toBe(2);
  expect(sessions[0].messages[0].role).toBe("user");
  expect(sessions[0].messages[1].role).toBe("assistant");
  expect(sessions[0].meta.createdAt).toBe(new Date(1700000000000).toISOString());

  // Re-open for afterEach cleanup
  globalDb = new Database(globalDbPath);
});

test("discoverCursorSqliteSessions: inline conversation format", () => {
  const composerId = "test-composer-inline";
  insertComposer(globalDb, composerId, {
    createdAt: 1700000001000,
    conversation: [
      { bubbleId: "b1", type: 1, text: "Fix my bug please" },
      { bubbleId: "b2", type: 2, text: "I can fix it." },
    ],
  });
  globalDb.close();

  const sessions = discoverCursorSqliteSessions(globalDbPath, new Map());
  expect(sessions.length).toBe(1);
  expect(sessions[0].messages.length).toBe(2);
  expect(sessions[0].messages[0].content).toBe("Fix my bug please");

  globalDb = new Database(globalDbPath);
});

test("discoverCursorSqliteSessions: skips composers with no messages", () => {
  insertComposer(globalDb, "empty-comp", {
    createdAt: 1700000002000,
    fullConversationHeadersOnly: [], // no headers -> no messages
  });
  insertComposer(globalDb, "null-value-comp", {
    createdAt: 1700000003000,
    conversation: [
      { bubbleId: "b1", type: 1, text: "" }, // empty text -> skipped
    ],
  });
  globalDb.close();

  const sessions = discoverCursorSqliteSessions(globalDbPath, new Map());
  expect(sessions.length).toBe(0);

  globalDb = new Database(globalDbPath);
});

test("discoverCursorSqliteSessions: filters by projectPath", () => {
  const composer1 = "comp-proj-a";
  const composer2 = "comp-proj-b";

  insertComposer(globalDb, composer1, {
    createdAt: 1700000004000,
    conversation: [{ bubbleId: "b1", type: 1, text: "For project A" }],
  });
  insertComposer(globalDb, composer2, {
    createdAt: 1700000005000,
    conversation: [{ bubbleId: "b2", type: 1, text: "For project B" }],
  });
  globalDb.close();

  const composerMap = new Map([
    [composer1, "/Users/test/project-a"],
    [composer2, "/Users/test/project-b"],
  ]);
  const sessions = discoverCursorSqliteSessions(globalDbPath, composerMap, {
    projectPath: "/Users/test/project-a",
  });
  expect(sessions.length).toBe(1);
  expect(sessions[0].meta.sessionId).toBe(`cursor-${composer1}`);

  globalDb = new Database(globalDbPath);
});

test("discoverCursorSqliteSessions: maps projectPath from composerWorkspaceMap", () => {
  const composerId = "comp-with-project";
  insertComposer(globalDb, composerId, {
    createdAt: 1700000006000,
    conversation: [{ bubbleId: "b1", type: 1, text: "Question" }],
  });
  globalDb.close();

  const composerMap = new Map([[composerId, "/Users/test/my-project"]]);
  const sessions = discoverCursorSqliteSessions(globalDbPath, composerMap);
  expect(sessions.length).toBe(1);
  expect(sessions[0].meta.projectPath).toBe("/Users/test/my-project");

  globalDb = new Database(globalDbPath);
});

// =============================================================================
// buildComposerWorkspaceMap
// =============================================================================

test("buildComposerWorkspaceMap: reads composerId from workspace state.vscdb", () => {
  // Setup: <tmpDir>/workspaceStorage/<hash>/
  const wsStorageDir = join(tmpDir, "workspaceStorage");
  const hashDir = join(wsStorageDir, "abc123");
  mkdirSync(hashDir, { recursive: true });

  // workspace.json
  writeFileSync(
    join(hashDir, "workspace.json"),
    JSON.stringify({ folder: "file:///Users/test/my-app" })
  );

  // state.vscdb
  const wsDb = createWorkspaceDb(join(hashDir, "state.vscdb"));
  wsDb.prepare(
    `INSERT INTO ItemTable (key, value) VALUES (?, ?)`
  ).run(
    "composer.composerData",
    JSON.stringify({
      allComposers: [
        { composerId: "aaa-111", createdAt: 0 },
        { composerId: "bbb-222", createdAt: 0 },
      ],
    })
  );
  wsDb.close();

  const map = buildComposerWorkspaceMap(tmpDir);
  expect(map.get("aaa-111")).toBe("/Users/test/my-app");
  expect(map.get("bbb-222")).toBe("/Users/test/my-app");
});

test("buildComposerWorkspaceMap: handles missing or malformed DBs gracefully", () => {
  // workspaceStorage dir exists but has no valid DBs
  const wsStorageDir = join(tmpDir, "workspaceStorage");
  mkdirSync(join(wsStorageDir, "bad_hash"), { recursive: true });
  // no state.vscdb, no workspace.json
  const map = buildComposerWorkspaceMap(tmpDir);
  expect(map.size).toBe(0);
});

// =============================================================================
// Legacy parseCursorJson (backward compat)
// =============================================================================

test("parseCursorJson: still works for legacy .cursor/*.json format", () => {
  const json = JSON.stringify({
    messages: [
      { role: "user", content: "Legacy question" },
      { role: "assistant", content: "Legacy answer" },
    ],
  });
  const msgs = parseCursorJson(json);
  expect(msgs.length).toBe(2);
  expect(msgs[0].role).toBe("user");
  expect(msgs[1].role).toBe("assistant");
});

// =============================================================================
// End-to-end: ingest(cursor) via orchestrator with fixture SQLite DB
// =============================================================================

test("ingest(cursor) ingests SQLite sessions without projectPath", async () => {
  // We need a full Cursor user dir structure:
  // <tmpDir>/Cursor/User/globalStorage/state.vscdb
  // <tmpDir>/Cursor/User/workspaceStorage/<hash>/state.vscdb + workspace.json
  const cursorUserRoot = join(tmpDir, "Cursor", "User");
  const globalStorageDir = join(cursorUserRoot, "globalStorage");
  mkdirSync(globalStorageDir, { recursive: true });

  const gPath = join(globalStorageDir, "state.vscdb");
  const gDb = createGlobalDb(gPath);
  const composerId = "e2e-composer-1";
  insertComposer(gDb, composerId, {
    createdAt: 1700000010000,
    conversation: [
      { bubbleId: "b1", type: 1, text: "End to end user message" },
      { bubbleId: "b2", type: 2, text: "End to end assistant message" },
    ],
  });
  gDb.close();

  // Override env to point to our test Cursor root
  const origEnv = Bun.env.CURSOR_STORAGE_DIR;
  Bun.env.CURSOR_STORAGE_DIR = cursorUserRoot;

  // In-memory Smriti DB
  const memDb = new Database(":memory:");
  memDb.exec("PRAGMA foreign_keys = ON");
  const { initializeMemoryTables } = await import("../src/qmd");
  const { initializeSmritiTables, seedDefaults } = await import("../src/db");
  initializeMemoryTables(memDb);
  initializeSmritiTables(memDb);
  seedDefaults(memDb);

  const result = await ingest(memDb, "cursor");

  Bun.env.CURSOR_STORAGE_DIR = origEnv;
  memDb.close();

  expect(result.agent).toBe("cursor");
  expect(result.sessionsFound).toBeGreaterThanOrEqual(1);
  expect(result.sessionsIngested).toBeGreaterThanOrEqual(1);
  expect(result.messagesIngested).toBeGreaterThanOrEqual(2);
  expect(result.errors).toHaveLength(0);
});
