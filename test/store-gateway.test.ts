import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeMemoryTables } from "../src/qmd";
import { initializeSmritiTables, seedDefaults, estimateCost } from "../src/db";
import { storeMessage, storeBlocks, storeSession, storeCosts } from "../src/ingest/store-gateway";
import type { ToolCorrelationMap } from "../src/ingest/store-gateway";
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

// =============================================================================
// Correlation map — tool_result updates tool_call success
// =============================================================================

test("correlation map updates tool_usage success on tool_result", () => {
  const now = new Date().toISOString();
  const sessionId = "s-corr";
  db.prepare(`INSERT INTO memory_sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(
    sessionId, "corr session", now, now
  );
  db.prepare(
    `INSERT INTO memory_messages (id, session_id, role, content, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(200, sessionId, "assistant", "call payload", "h-corr-call", now);
  db.prepare(
    `INSERT INTO memory_messages (id, session_id, role, content, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(201, sessionId, "user", "result payload", "h-corr-result", now);

  const correlationMap: ToolCorrelationMap = new Map();

  // Store tool_call blocks (assistant turn)
  const callBlocks: MessageBlock[] = [
    { type: "tool_call", toolId: "tc-1", toolName: "Bash", input: { command: "ls" }, description: "list files" },
    { type: "command", command: "ls", isGit: false },
  ];
  storeBlocks(db, 200, sessionId, null, callBlocks, now, correlationMap);

  // Verify tool_usage initially has success=1
  const before = db.prepare(
    `SELECT success FROM smriti_tool_usage WHERE message_id = 200 AND session_id = ?`
  ).get(sessionId) as { success: number };
  expect(before.success).toBe(1);

  // Store tool_result blocks (user turn) — mark as failed
  const resultBlocks: MessageBlock[] = [
    { type: "tool_result", toolId: "tc-1", success: false, output: "ls: error", error: "ls: error" },
  ];
  storeBlocks(db, 201, sessionId, null, resultBlocks, now, correlationMap);

  // Verify tool_usage success was updated to 0
  const after = db.prepare(
    `SELECT success FROM smriti_tool_usage WHERE message_id = 200 AND session_id = ?`
  ).get(sessionId) as { success: number };
  expect(after.success).toBe(0);

  // Verify error row was inserted
  const errRow = db.prepare(
    `SELECT error_type, message FROM smriti_errors WHERE session_id = ?`
  ).get(sessionId) as { error_type: string; message: string } | null;
  expect(errRow).not.toBeNull();
  expect(errRow!.error_type).toBe("tool_failure");
  expect(errRow!.message).toContain("Bash");
});

test("correlation map backfills exit code on Bash commands", () => {
  const now = new Date().toISOString();
  const sessionId = "s-exit";
  db.prepare(`INSERT INTO memory_sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(
    sessionId, "exit session", now, now
  );
  db.prepare(
    `INSERT INTO memory_messages (id, session_id, role, content, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(300, sessionId, "assistant", "bash call", "h-exit-call", now);
  db.prepare(
    `INSERT INTO memory_messages (id, session_id, role, content, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(301, sessionId, "user", "bash result", "h-exit-result", now);

  const correlationMap: ToolCorrelationMap = new Map();

  // Store tool_call + command
  const callBlocks: MessageBlock[] = [
    { type: "tool_call", toolId: "tc-bash", toolName: "Bash", input: { command: "bun test" } },
    { type: "command", command: "bun test", isGit: false },
  ];
  storeBlocks(db, 300, sessionId, null, callBlocks, now, correlationMap);

  // Initially exit_code is NULL
  const before = db.prepare(
    `SELECT exit_code FROM smriti_commands WHERE message_id = 300 AND session_id = ?`
  ).get(sessionId) as { exit_code: number | null };
  expect(before.exit_code).toBeNull();

  // Store tool_result with exit code
  const resultBlocks: MessageBlock[] = [
    { type: "tool_result", toolId: "tc-bash", success: false, output: "Exit code: 1", exitCode: 1 },
  ];
  storeBlocks(db, 301, sessionId, null, resultBlocks, now, correlationMap);

  // Exit code should be backfilled
  const after = db.prepare(
    `SELECT exit_code FROM smriti_commands WHERE message_id = 300 AND session_id = ?`
  ).get(sessionId) as { exit_code: number | null };
  expect(after.exit_code).toBe(1);
});

// =============================================================================
// Cost estimation
// =============================================================================

test("estimateCost calculates opus pricing", () => {
  const cost = estimateCost("claude-opus-4-20250514", 1_000_000, 100_000, 500_000);
  // 1M * 15/1M + 100K * 75/1M + 500K * 1.5/1M = 15 + 7.5 + 0.75 = 23.25
  expect(cost).toBeCloseTo(23.25, 2);
});

test("estimateCost calculates sonnet pricing", () => {
  const cost = estimateCost("claude-sonnet-4-20250514", 1_000_000, 100_000, 0);
  // 1M * 3/1M + 100K * 15/1M = 3 + 1.5 = 4.5
  expect(cost).toBeCloseTo(4.5, 2);
});

test("estimateCost calculates haiku pricing", () => {
  const cost = estimateCost("claude-haiku-4.5-20251001", 1_000_000, 100_000, 0);
  // 1M * 0.8/1M + 100K * 4/1M = 0.8 + 0.4 = 1.2
  expect(cost).toBeCloseTo(1.2, 2);
});

test("estimateCost falls back to default pricing for unknown models", () => {
  const cost = estimateCost("unknown-model", 1_000_000, 100_000, 0);
  // default = sonnet pricing: 1M * 3/1M + 100K * 15/1M = 3 + 1.5 = 4.5
  expect(cost).toBeCloseTo(4.5, 2);
});

test("storeCosts accumulates estimated_cost_usd", () => {
  storeCosts(db, "s-cost-usd", "claude-sonnet-4-20250514", 100_000, 10_000, 0, 1000);
  storeCosts(db, "s-cost-usd", "claude-sonnet-4-20250514", 100_000, 10_000, 0, 500);

  const row = db
    .prepare(
      `SELECT estimated_cost_usd FROM smriti_session_costs WHERE session_id = ? AND model = ?`
    )
    .get("s-cost-usd", "claude-sonnet-4-20250514") as { estimated_cost_usd: number } | null;

  expect(row).not.toBeNull();
  // Each call: 100K * 3/1M + 10K * 15/1M = 0.3 + 0.15 = 0.45, x2 = 0.9
  expect(row!.estimated_cost_usd).toBeCloseTo(0.9, 4);
});
