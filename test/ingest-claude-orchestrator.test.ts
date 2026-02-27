import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { initializeMemoryTables } from "../src/qmd";
import { initializeSmritiTables, seedDefaults } from "../src/db";
import { ingest } from "../src/ingest/index";

let db: Database;
let root: string;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  initializeMemoryTables(db);
  initializeSmritiTables(db);
  seedDefaults(db);
  root = mkdtempSync(join(tmpdir(), "smriti-claude-orch-"));
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function writeClaudeSession(filePath: string, sessionId: string, userText: string, assistantText: string) {
  writeFileSync(
    filePath,
    [
      JSON.stringify({
        type: "user",
        sessionId,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: userText },
      }),
      JSON.stringify({
        type: "assistant",
        sessionId,
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: assistantText }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }),
    ].join("\n")
  );
}

test("ingest(claude) ingests new session through orchestrator", async () => {
  const projectDir = "-Users-zero8-zero8.dev-smriti";
  const logsDir = join(root, "claude-logs");
  const sessionId = "claude-session-1";
  mkdirSync(join(logsDir, projectDir), { recursive: true });

  const filePath = join(logsDir, projectDir, `${sessionId}.jsonl`);
  writeClaudeSession(filePath, sessionId, "How should we deploy?", "Use blue/green.");

  const result = await ingest(db, "claude", { logsDir });

  expect(result.errors).toHaveLength(0);
  expect(result.sessionsFound).toBe(1);
  expect(result.sessionsIngested).toBe(1);
  expect(result.messagesIngested).toBe(2);

  const meta = db
    .prepare("SELECT agent_id, project_id FROM smriti_session_meta WHERE session_id = ?")
    .get(sessionId) as { agent_id: string; project_id: string | null };

  expect(meta.agent_id).toBe("claude-code");
  expect(meta.project_id).toBe("smriti");
});

test("ingest(claude) is incremental for append-only jsonl sessions", async () => {
  const projectDir = "-Users-zero8-zero8.dev-smriti";
  const logsDir = join(root, "claude-logs");
  const sessionId = "claude-session-2";
  mkdirSync(join(logsDir, projectDir), { recursive: true });

  const filePath = join(logsDir, projectDir, `${sessionId}.jsonl`);
  writeClaudeSession(filePath, sessionId, "Initial question", "Initial answer");

  const first = await ingest(db, "claude", { logsDir });
  expect(first.sessionsIngested).toBe(1);
  expect(first.messagesIngested).toBe(2);

  appendFileSync(
    filePath,
    "\n" +
      JSON.stringify({
        type: "user",
        sessionId,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "Follow-up question" },
      }) +
      "\n" +
      JSON.stringify({
        type: "assistant",
        sessionId,
        timestamp: new Date().toISOString(),
        message: { role: "assistant", content: [{ type: "text", text: "Follow-up answer" }] },
      })
  );

  const second = await ingest(db, "claude", { logsDir });

  expect(second.errors).toHaveLength(0);
  expect(second.sessionsFound).toBe(1);
  expect(second.sessionsIngested).toBe(1);
  expect(second.messagesIngested).toBe(2);

  const count = db
    .prepare("SELECT COUNT(*) as c FROM memory_messages WHERE session_id = ?")
    .get(sessionId) as { c: number };
  expect(count.c).toBe(4);
});
