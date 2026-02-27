import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeMemoryTables } from "../src/qmd";
import { initializeSmritiTables, seedDefaults } from "../src/db";
import { storeMessage, storeBlocks, storeSession, storeCosts } from "../src/ingest/store-gateway";
import type { MessageBlock } from "../src/ingest/types";

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

test("storeSession upserts project and session meta", () => {
  storeSession(db, "s1", "codex", "proj-1", "/tmp/proj-1");

  const p = db
    .prepare("SELECT id, path FROM smriti_projects WHERE id = ?")
    .get("proj-1") as { id: string; path: string } | null;
  expect(p).not.toBeNull();
  expect(p!.path).toBe("/tmp/proj-1");

  const sm = db
    .prepare("SELECT session_id, agent_id, project_id FROM smriti_session_meta WHERE session_id = ?")
    .get("s1") as { session_id: string; agent_id: string; project_id: string } | null;
  expect(sm).not.toBeNull();
  expect(sm!.agent_id).toBe("codex");
  expect(sm!.project_id).toBe("proj-1");
});

test("storeMessage writes memory message", async () => {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO memory_sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(
    "s-msg",
    "msg session",
    now,
    now
  );

  const r = await storeMessage(db, "s-msg", "user", "hello world", { source: "test" });
  expect(r.success).toBe(true);
  expect(r.messageId).toBeGreaterThan(0);

  const row = db
    .prepare("SELECT session_id, role, content FROM memory_messages WHERE id = ?")
    .get(r.messageId) as { session_id: string; role: string; content: string } | null;

  expect(row).not.toBeNull();
  expect(row!.session_id).toBe("s-msg");
  expect(row!.role).toBe("user");
  expect(row!.content).toBe("hello world");
});

test("storeBlocks writes sidecar rows by block type", () => {
  const now = new Date().toISOString();
  const sessionId = "s-side";
  db.prepare(`INSERT INTO memory_sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(
    sessionId,
    "sidecar session",
    now,
    now
  );
  db.prepare(
    `INSERT INTO memory_messages (id, session_id, role, content, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(100, sessionId, "assistant", "sidecar payload", "h-side", now);
  const msgId = 100;

  const blocks: MessageBlock[] = [
    { type: "tool_call", toolId: "t1", toolName: "Read", input: { file_path: "a.ts" } },
    { type: "file_op", operation: "write", path: "src/a.ts" },
    { type: "command", command: "git status", isGit: true },
    { type: "git", operation: "commit", message: "feat: add" },
    { type: "error", errorType: "tool_failure", message: "boom" },
  ];

  storeBlocks(db, msgId, sessionId, "proj-x", blocks, now);

  const toolRows = db.prepare("SELECT COUNT(*) as c FROM smriti_tool_usage WHERE message_id = ?").get(msgId) as { c: number };
  const fileRows = db.prepare("SELECT COUNT(*) as c FROM smriti_file_operations WHERE message_id = ?").get(msgId) as { c: number };
  const cmdRows = db.prepare("SELECT COUNT(*) as c FROM smriti_commands WHERE message_id = ?").get(msgId) as { c: number };
  const gitRows = db.prepare("SELECT COUNT(*) as c FROM smriti_git_operations WHERE message_id = ?").get(msgId) as { c: number };
  const errRows = db.prepare("SELECT COUNT(*) as c FROM smriti_errors WHERE message_id = ?").get(msgId) as { c: number };

  expect(toolRows.c).toBe(1);
  expect(fileRows.c).toBe(1);
  expect(cmdRows.c).toBe(1);
  expect(gitRows.c).toBe(1);
  expect(errRows.c).toBe(1);
});

test("storeCosts accumulates into smriti_session_costs", () => {
  storeCosts(db, "s-cost", "model-a", 10, 5, 2, 1000);
  storeCosts(db, "s-cost", "model-a", 20, 10, 0, 500);

  const row = db
    .prepare(
      `SELECT total_input_tokens, total_output_tokens, total_cache_tokens, turn_count, total_duration_ms
       FROM smriti_session_costs
       WHERE session_id = ? AND model = ?`
    )
    .get("s-cost", "model-a") as {
    total_input_tokens: number;
    total_output_tokens: number;
    total_cache_tokens: number;
    turn_count: number;
    total_duration_ms: number;
  } | null;

  expect(row).not.toBeNull();
  expect(row!.total_input_tokens).toBe(30);
  expect(row!.total_output_tokens).toBe(15);
  expect(row!.total_cache_tokens).toBe(2);
  expect(row!.turn_count).toBe(2);
  expect(row!.total_duration_ms).toBe(1500);
});
