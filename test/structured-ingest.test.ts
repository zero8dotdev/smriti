import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import {
  parseClaudeJsonlStructured,
  parseClaudeJsonl,
} from "../src/ingest/claude";
import { initializeSmritiTables, seedDefaults } from "../src/db";

// =============================================================================
// parseClaudeJsonlStructured — full block extraction
// =============================================================================

test("parseClaudeJsonlStructured extracts text blocks from user and assistant", () => {
  const jsonl = [
    JSON.stringify({
      type: "user",
      sessionId: "s1",
      uuid: "u1",
      timestamp: "2026-02-10T12:00:00Z",
      message: { role: "user", content: "Fix the auth bug" },
    }),
    JSON.stringify({
      type: "assistant",
      sessionId: "s1",
      uuid: "u2",
      timestamp: "2026-02-10T12:00:01Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "I'll fix it now." }],
        model: "claude-opus-4-6",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 5,
        },
        stop_reason: "end_turn",
      },
      requestId: "req_123",
      gitBranch: "main",
      cwd: "/Users/test/project",
      version: "2.1.39",
    }),
  ].join("\n");

  const messages = parseClaudeJsonlStructured(jsonl);
  expect(messages.length).toBe(2);

  // User message
  expect(messages[0].role).toBe("user");
  expect(messages[0].blocks.length).toBe(1);
  expect(messages[0].blocks[0].type).toBe("text");
  expect(messages[0].plainText).toBe("Fix the auth bug");
  expect(messages[0].agent).toBe("claude-code");
  expect(messages[0].sequence).toBe(0);

  // Assistant message
  expect(messages[1].role).toBe("assistant");
  expect(messages[1].blocks[0].type).toBe("text");
  expect(messages[1].metadata.model).toBe("claude-opus-4-6");
  expect(messages[1].metadata.stopReason).toBe("end_turn");
  expect(messages[1].metadata.tokenUsage?.input).toBe(100);
  expect(messages[1].metadata.tokenUsage?.output).toBe(50);
  expect(messages[1].metadata.tokenUsage?.cacheCreate).toBe(10);
  expect(messages[1].metadata.requestId).toBe("req_123");
  expect(messages[1].metadata.gitBranch).toBe("main");
  expect(messages[1].metadata.cwd).toBe("/Users/test/project");
  expect(messages[1].metadata.agentVersion).toBe("2.1.39");
});

test("parseClaudeJsonlStructured extracts tool_use blocks", () => {
  const jsonl = JSON.stringify({
    type: "assistant",
    sessionId: "s1",
    uuid: "u3",
    timestamp: "2026-02-10T12:00:02Z",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Let me read the file." },
        {
          type: "tool_use",
          id: "tool_abc",
          name: "Read",
          input: { file_path: "/src/auth.ts" },
        },
      ],
    },
  });

  const messages = parseClaudeJsonlStructured(jsonl);
  expect(messages.length).toBe(1);

  const blocks = messages[0].blocks;
  expect(blocks.length).toBe(3); // text + tool_call + file_op
  expect(blocks[0].type).toBe("text");
  expect(blocks[1].type).toBe("tool_call");
  expect(blocks[2].type).toBe("file_op");

  if (blocks[1].type === "tool_call") {
    expect(blocks[1].toolName).toBe("Read");
    expect(blocks[1].toolId).toBe("tool_abc");
  }
  if (blocks[2].type === "file_op") {
    expect(blocks[2].operation).toBe("read");
    expect(blocks[2].path).toBe("/src/auth.ts");
  }
});

test("parseClaudeJsonlStructured extracts thinking blocks", () => {
  const jsonl = JSON.stringify({
    type: "assistant",
    sessionId: "s1",
    uuid: "u4",
    timestamp: "2026-02-10T12:00:03Z",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "The user wants me to fix the bug in auth.ts" },
        { type: "text", text: "I see the issue." },
      ],
    },
  });

  const messages = parseClaudeJsonlStructured(jsonl);
  expect(messages.length).toBe(1);

  const blocks = messages[0].blocks;
  expect(blocks.length).toBe(2);
  expect(blocks[0].type).toBe("thinking");
  if (blocks[0].type === "thinking") {
    expect(blocks[0].thinking).toContain("fix the bug");
  }
  expect(blocks[1].type).toBe("text");

  // Thinking should NOT appear in plainText (FTS)
  expect(messages[0].plainText).not.toContain("fix the bug");
  expect(messages[0].plainText).toContain("I see the issue");
});

test("parseClaudeJsonlStructured extracts Bash commands with git detection", () => {
  const jsonl = JSON.stringify({
    type: "assistant",
    sessionId: "s1",
    uuid: "u5",
    timestamp: "2026-02-10T12:00:04Z",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tool_bash1",
          name: "Bash",
          input: {
            command: 'git commit -m "Fix auth"',
            description: "Commit the fix",
          },
        },
      ],
    },
  });

  const messages = parseClaudeJsonlStructured(jsonl);
  expect(messages.length).toBe(1);

  const blocks = messages[0].blocks;
  // tool_call + command + git = 3 blocks
  expect(blocks.length).toBe(3);
  expect(blocks[0].type).toBe("tool_call");
  expect(blocks[1].type).toBe("command");
  expect(blocks[2].type).toBe("git");

  if (blocks[1].type === "command") {
    expect(blocks[1].isGit).toBe(true);
    expect(blocks[1].description).toBe("Commit the fix");
  }
  if (blocks[2].type === "git") {
    expect(blocks[2].operation).toBe("commit");
    expect(blocks[2].message).toBe("Fix auth");
  }
});

test("parseClaudeJsonlStructured handles system turn_duration events", () => {
  const jsonl = JSON.stringify({
    type: "system",
    subtype: "turn_duration",
    sessionId: "s1",
    durationMs: 5000,
    timestamp: "2026-02-10T12:00:05Z",
  });

  const messages = parseClaudeJsonlStructured(jsonl);
  expect(messages.length).toBe(1);
  expect(messages[0].role).toBe("system");
  expect(messages[0].blocks[0].type).toBe("system_event");
  if (messages[0].blocks[0].type === "system_event") {
    expect(messages[0].blocks[0].eventType).toBe("turn_duration");
    expect(messages[0].blocks[0].data.durationMs).toBe(5000);
  }
});

test("parseClaudeJsonlStructured handles pr-link events", () => {
  const jsonl = JSON.stringify({
    type: "pr-link",
    sessionId: "s1",
    prNumber: 42,
    prUrl: "https://github.com/org/repo/pull/42",
    prRepository: "org/repo",
    timestamp: "2026-02-10T12:00:06Z",
  });

  const messages = parseClaudeJsonlStructured(jsonl);
  expect(messages.length).toBe(1);
  expect(messages[0].role).toBe("system");

  // Should have system_event + git blocks
  const gitBlock = messages[0].blocks.find((b) => b.type === "git");
  expect(gitBlock).toBeDefined();
  if (gitBlock?.type === "git") {
    expect(gitBlock.operation).toBe("pr_create");
    expect(gitBlock.prNumber).toBe(42);
    expect(gitBlock.prUrl).toBe("https://github.com/org/repo/pull/42");
  }

  expect(messages[0].plainText).toContain("PR #42");
});

test("parseClaudeJsonlStructured skips meta and command entries", () => {
  const jsonl = [
    JSON.stringify({
      type: "user",
      isMeta: true,
      message: { role: "user", content: "<command-name>test</command-name>" },
    }),
    JSON.stringify({
      type: "user",
      message: { role: "user", content: "<local-command-stdout>ok</local-command-stdout>" },
    }),
    JSON.stringify({
      type: "file-history-snapshot",
      data: {},
    }),
    JSON.stringify({
      type: "user",
      uuid: "real",
      message: { role: "user", content: "Real question" },
      timestamp: "2026-02-10T12:00:00Z",
    }),
  ].join("\n");

  const messages = parseClaudeJsonlStructured(jsonl);
  expect(messages.length).toBe(1);
  expect(messages[0].plainText).toBe("Real question");
});

test("parseClaudeJsonlStructured captures sidechain metadata", () => {
  const jsonl = JSON.stringify({
    type: "user",
    sessionId: "s1",
    uuid: "u10",
    parentUuid: "u9",
    isSidechain: true,
    permissionMode: "plan",
    slug: "fix-auth-bug",
    timestamp: "2026-02-10T12:00:00Z",
    message: { role: "user", content: "Check this" },
  });

  const messages = parseClaudeJsonlStructured(jsonl);
  expect(messages.length).toBe(1);
  expect(messages[0].metadata.isSidechain).toBe(true);
  expect(messages[0].metadata.parentId).toBe("u9");
  expect(messages[0].metadata.permissionMode).toBe("plan");
  expect(messages[0].metadata.slug).toBe("fix-auth-bug");
});

// =============================================================================
// Backward compatibility — parseClaudeJsonl still works
// =============================================================================

test("parseClaudeJsonl still returns ParsedMessage format", () => {
  const jsonl = [
    JSON.stringify({
      type: "user",
      sessionId: "abc",
      message: { role: "user", content: "How do I fix this bug?" },
      timestamp: "2026-02-10T12:00:00Z",
      uuid: "u1",
    }),
    JSON.stringify({
      type: "assistant",
      sessionId: "abc",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "You can fix it by..." },
          { type: "thinking", thinking: "Let me think..." },
        ],
      },
      timestamp: "2026-02-10T12:00:01Z",
      uuid: "u2",
    }),
  ].join("\n");

  const messages = parseClaudeJsonl(jsonl);
  expect(messages.length).toBe(2);
  expect(messages[0].role).toBe("user");
  expect(messages[0].content).toBe("How do I fix this bug?");
  expect(messages[1].role).toBe("assistant");
  expect(messages[1].content).toBe("You can fix it by...");
});

// =============================================================================
// Sidecar table population (integration test with in-memory DB)
// =============================================================================

let db: Database;

beforeAll(() => {
  db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");

  // Create minimal QMD tables
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

test("sidecar tables are created", () => {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'smriti_%' ORDER BY name`
    )
    .all() as { name: string }[];

  const names = tables.map((t) => t.name);
  expect(names).toContain("smriti_tool_usage");
  expect(names).toContain("smriti_file_operations");
  expect(names).toContain("smriti_commands");
  expect(names).toContain("smriti_errors");
  expect(names).toContain("smriti_session_costs");
  expect(names).toContain("smriti_git_operations");
});

test("insertToolUsage writes to sidecar table", () => {
  const { insertToolUsage } = require("../src/db");

  // Create a test session and message
  db.prepare(
    `INSERT INTO memory_sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`
  ).run("test-s1", "Test", new Date().toISOString(), new Date().toISOString());
  db.prepare(
    `INSERT INTO memory_messages (session_id, role, content, hash, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run("test-s1", "assistant", "test content", "hash1", new Date().toISOString());
  const msgId = Number(
    (db.prepare("SELECT last_insert_rowid() as id").get() as any).id
  );

  insertToolUsage(db, msgId, "test-s1", "Read", "Read /src/index.ts", true, null, new Date().toISOString());

  const rows = db
    .prepare("SELECT * FROM smriti_tool_usage WHERE session_id = ?")
    .all("test-s1") as any[];
  expect(rows.length).toBe(1);
  expect(rows[0].tool_name).toBe("Read");
  expect(rows[0].input_summary).toBe("Read /src/index.ts");
  expect(rows[0].success).toBe(1);
});

test("insertFileOperation writes to sidecar table", () => {
  const { insertFileOperation } = require("../src/db");
  const msgId = Number(
    (db.prepare("SELECT id FROM memory_messages LIMIT 1").get() as any).id
  );

  insertFileOperation(db, msgId, "test-s1", "read", "/src/index.ts", "myproj", new Date().toISOString());

  const rows = db
    .prepare("SELECT * FROM smriti_file_operations WHERE session_id = ?")
    .all("test-s1") as any[];
  expect(rows.length).toBe(1);
  expect(rows[0].operation).toBe("read");
  expect(rows[0].file_path).toBe("/src/index.ts");
  expect(rows[0].project_id).toBe("myproj");
});

test("insertCommand writes to sidecar table", () => {
  const { insertCommand } = require("../src/db");
  const msgId = Number(
    (db.prepare("SELECT id FROM memory_messages LIMIT 1").get() as any).id
  );

  insertCommand(db, msgId, "test-s1", "bun test", 0, "/src", false, new Date().toISOString());

  const rows = db
    .prepare("SELECT * FROM smriti_commands WHERE session_id = ?")
    .all("test-s1") as any[];
  expect(rows.length).toBe(1);
  expect(rows[0].command).toBe("bun test");
  expect(rows[0].exit_code).toBe(0);
  expect(rows[0].is_git).toBe(0);
});

test("insertGitOperation writes to sidecar table", () => {
  const { insertGitOperation } = require("../src/db");
  const msgId = Number(
    (db.prepare("SELECT id FROM memory_messages LIMIT 1").get() as any).id
  );

  insertGitOperation(
    db, msgId, "test-s1", "commit", "main", null, null,
    JSON.stringify({ message: "Fix bug" }), new Date().toISOString()
  );

  const rows = db
    .prepare("SELECT * FROM smriti_git_operations WHERE session_id = ?")
    .all("test-s1") as any[];
  expect(rows.length).toBe(1);
  expect(rows[0].operation).toBe("commit");
  expect(rows[0].branch).toBe("main");
  expect(JSON.parse(rows[0].details).message).toBe("Fix bug");
});

test("upsertSessionCosts accumulates tokens across turns", () => {
  const { upsertSessionCosts } = require("../src/db");

  upsertSessionCosts(db, "test-s1", "claude-opus-4-6", 100, 50, 10, 5000);
  upsertSessionCosts(db, "test-s1", "claude-opus-4-6", 200, 80, 20, 3000);

  const row = db
    .prepare("SELECT * FROM smriti_session_costs WHERE session_id = ?")
    .get("test-s1") as any;
  expect(row).toBeDefined();
  expect(row.model).toBe("claude-opus-4-6");
  expect(row.total_input_tokens).toBe(300);
  expect(row.total_output_tokens).toBe(130);
  expect(row.total_cache_tokens).toBe(30);
  expect(row.turn_count).toBe(2);
  expect(row.total_duration_ms).toBe(8000);
});

test("insertError writes to sidecar table", () => {
  const { insertError } = require("../src/db");
  const msgId = Number(
    (db.prepare("SELECT id FROM memory_messages LIMIT 1").get() as any).id
  );

  insertError(db, msgId, "test-s1", "tool_failure", "File not found", new Date().toISOString());

  const rows = db
    .prepare("SELECT * FROM smriti_errors WHERE session_id = ?")
    .all("test-s1") as any[];
  expect(rows.length).toBe(1);
  expect(rows[0].error_type).toBe("tool_failure");
  expect(rows[0].message).toBe("File not found");
});
