import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { PROJECTS_ROOT } from "../src/config";
import { initializeSmritiTables, seedDefaults } from "../src/db";
import { ingest } from "../src/ingest/index";
import { parseGrokUpdates } from "../src/ingest/parsers/grok";
import { initializeMemoryTables } from "../src/qmd";

const SESSION_ID = "01a0cd14-65e2-7b63-ae30-6482c6171842";

function event(update: Record<string, unknown>, timestamp = 1788936758): string {
  return JSON.stringify({
    timestamp,
    method: "session/update",
    params: {
      sessionId: SESSION_ID,
      update,
      _meta: { agentTimestampMs: timestamp * 1000 },
    },
  });
}

function fixtureLines(): string {
  return [
    event({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "<user_query>\nHow do we ship this?\n</user_query>" },
      _meta: { modelId: "grok-4.6", promptIndex: 0 },
    }),
    event({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "hidden wake" },
      _meta: { hideFromScrollback: true, promptIndex: 1 },
    }),
    event({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Check the tag. " },
    }),
    event({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Then the notes." },
    }),
    event({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Ship the tag. " },
    }),
    event({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Notes stay short." },
    }),
    event({
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      title: "read_file",
      rawInput: { target_file: "README.md" },
      _meta: { "x.ai/tool": { name: "read_file", kind: "read" } },
    }),
    event({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      status: "in_progress",
      content: [{ type: "content", content: { type: "text", text: "partial" } }],
    }),
    event({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      status: "completed",
      _meta: { "x.ai/tool": { name: "read_file", kind: "read" } },
      content: [{ type: "content", content: { type: "text", text: "# Smriti\n" } }],
    }),
    event({
      sessionUpdate: "tool_call",
      toolCallId: "call-2",
      title: "run_terminal_command",
      rawInput: { command: "git status", description: "status" },
      _meta: { "x.ai/tool": { name: "run_terminal_command", kind: "execute" } },
    }),
    event({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-2",
      status: "failed",
      _meta: { "x.ai/tool": { name: "run_terminal_command", kind: "execute" } },
      content: [{ type: "content", content: { type: "text", text: "not a repo" } }],
    }),
    event({
      sessionUpdate: "turn_completed",
      stop_reason: "end_turn",
      elapsed_ms: 1200,
      usage: { inputTokens: 10, outputTokens: 4, cachedReadTokens: 2, cacheCreationTokens: 0 },
    }),
  ].join("\n");
}

test("parseGrokUpdates concatenates chunks and keeps final tool results", () => {
  const messages = parseGrokUpdates(fixtureLines(), SESSION_ID, {
    generated_title: "Ship it",
    current_model_id: "grok-4.6",
  });

  const users = messages.filter((m) => m.role === "user");
  expect(users).toHaveLength(1);
  expect(users[0].plainText).toBe("How do we ship this?");

  const assistant = messages.find((m) => m.role === "assistant" && m.plainText.includes("Ship the tag"));
  expect(assistant?.plainText).toBe("Ship the tag. Notes stay short.");
  expect(assistant?.blocks.some((b) => b.type === "thinking")).toBe(true);
  expect(assistant?.plainText.includes("Check the tag")).toBe(false);

  const read = messages.find((m) => m.blocks.some((b) => b.type === "tool_call" && b.toolName === "read_file"));
  expect(read?.blocks.some((b) => b.type === "file_op" && b.operation === "read")).toBe(true);

  const results = messages.filter((m) => m.role === "tool");
  expect(results).toHaveLength(2);
  expect(results[0].plainText).toContain("# Smriti");
  expect(results[1].blocks.some((b) => b.type === "tool_result" && b.success === false)).toBe(true);

  const withUsage = messages.find((m) => m.metadata.tokenUsage);
  expect(withUsage?.metadata.tokenUsage).toEqual({
    input: 10,
    output: 4,
    cacheCreate: 0,
    cacheRead: 2,
  });
  expect(withUsage?.blocks.some((b) => b.type === "system_event" && b.eventType === "turn_duration")).toBe(true);
});

let db: Database;
let root: string;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  initializeMemoryTables(db);
  initializeSmritiTables(db);
  seedDefaults(db);
  root = mkdtempSync(join(tmpdir(), "smriti-grok-"));
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function writeSession(cwd: string) {
  const encoded = encodeURIComponent(cwd);
  const dir = join(root, encoded, SESSION_ID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "summary.json"),
    JSON.stringify({
      info: { id: SESSION_ID, cwd },
      generated_title: "Ship it",
      created_at: "2026-09-23T07:00:00.000Z",
      current_model_id: "grok-4.6",
    })
  );
  writeFileSync(join(dir, "updates.jsonl"), fixtureLines());
  const sub = join(root, encoded, "01a0cd14-65e2-7b63-ae30-6482c6171999");
  mkdirSync(sub, { recursive: true });
  writeFileSync(
    join(sub, "summary.json"),
    JSON.stringify({
      info: { id: "01a0cd14-65e2-7b63-ae30-6482c6171999", cwd },
      session_kind: "subagent",
    })
  );
  writeFileSync(join(sub, "updates.jsonl"), fixtureLines());
}

test("ingest(grok) stores the session and skips subagents", async () => {
  const cwd = join(PROJECTS_ROOT, "smriti");
  writeSession(cwd);

  const result = await ingest(db, "grok", { logsDir: root });
  expect(result.errors).toHaveLength(0);
  expect(result.sessionsFound).toBe(1);
  expect(result.sessionsIngested).toBe(1);
  expect(result.messagesIngested).toBeGreaterThan(0);

  const meta = db
    .prepare("SELECT agent_id, project_id FROM smriti_session_meta WHERE session_id = ?")
    .get(SESSION_ID) as { agent_id: string; project_id: string };
  expect(meta.agent_id).toBe("grok");
  expect(meta.project_id).toBe("smriti");

  const calls = db
    .prepare("SELECT tool_name, success FROM smriti_tool_usage WHERE session_id = ? ORDER BY tool_name")
    .all(SESSION_ID) as Array<{ tool_name: string; success: number }>;
  expect(calls.map((c) => c.tool_name).sort()).toEqual(["read_file", "run_terminal_command"]);
  expect(calls.find((c) => c.tool_name === "run_terminal_command")?.success).toBe(0);
});

test("ingest(grok) --dry-run writes nothing", async () => {
  writeSession(join(PROJECTS_ROOT, "smriti"));
  const result = await ingest(db, "grok", { logsDir: root, dryRun: true });
  expect(result.dryRun).toBe(true);
  expect(result.sessionsIngested).toBe(1);
  const row = db.prepare("SELECT COUNT(*) as n FROM smriti_session_meta").get() as { n: number };
  expect(row.n).toBe(0);
});

test("ingest(grok) appends only new messages on a second run", async () => {
  const cwd = join(PROJECTS_ROOT, "smriti");
  writeSession(cwd);
  const first = await ingest(db, "grok", { logsDir: root });
  expect(first.sessionsIngested).toBe(1);

  const updates = join(root, encodeURIComponent(cwd), SESSION_ID, "updates.jsonl");
  writeFileSync(
    updates,
    fixtureLines() +
      "\n" +
      event({
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "One more question" },
        _meta: { promptIndex: 2 },
      })
  );

  const second = await ingest(db, "grok", { logsDir: root });
  expect(second.errors).toHaveLength(0);
  expect(second.sessionsIngested).toBe(1);
  expect(second.messagesIngested).toBe(1);

  const count = db
    .prepare("SELECT COUNT(*) as n FROM memory_messages WHERE session_id = ?")
    .get(SESSION_ID) as { n: number };
  expect(count.n).toBe(first.messagesIngested + 1);
});
