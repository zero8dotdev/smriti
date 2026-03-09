import { test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeMemoryTables } from "../src/qmd";
import { initializeSmritiTables, seedDefaults } from "../src/db";
import { ingestClaudeWeb, ingestClaudeWebMemories } from "../src/ingest/claude-web";
import { getExistingSessionIds } from "../src/ingest/index";
import { tmpdir } from "os";
import { join } from "path";
import { writeFileSync, mkdirSync, rmSync } from "fs";

// =============================================================================
// Test Helpers
// =============================================================================

let db: Database;
let tmpDir: string;

function setupDb(): Database {
  const d = new Database(":memory:");
  d.exec("PRAGMA journal_mode = WAL");
  d.exec("PRAGMA foreign_keys = ON");
  initializeMemoryTables(d);
  initializeSmritiTables(d);
  seedDefaults(d);
  return d;
}

function writeTmpJson(name: string, data: unknown): string {
  const path = join(tmpDir, name);
  writeFileSync(path, JSON.stringify(data));
  return path;
}

function makeConversation(overrides: Record<string, unknown> = {}) {
  return {
    uuid: "test-conv-001",
    name: "Test Conversation",
    summary: "A test summary",
    created_at: "2025-06-01T10:00:00Z",
    updated_at: "2025-06-01T11:00:00Z",
    account: { uuid: "acc-1" },
    chat_messages: [
      {
        uuid: "msg-001",
        text: "Hello, can you help me?",
        content: [{ type: "text", text: "Hello, can you help me?" }],
        sender: "human",
        created_at: "2025-06-01T10:00:00Z",
        updated_at: "2025-06-01T10:00:00Z",
        attachments: [],
        files: [],
      },
      {
        uuid: "msg-002",
        text: "",
        content: [
          { type: "text", text: "Sure, I can help!" },
        ],
        sender: "assistant",
        created_at: "2025-06-01T10:00:05Z",
        updated_at: "2025-06-01T10:00:05Z",
        attachments: [],
        files: [],
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  db = setupDb();
  tmpDir = join(tmpdir(), `smriti-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
});

// =============================================================================
// Basic Parsing
// =============================================================================

test("ingestClaudeWeb ingests conversations and creates sessions", async () => {
  const conversations = [makeConversation()];
  const filePath = writeTmpJson("conversations.json", conversations);

  const result = await ingestClaudeWeb(db, filePath, { db });
  expect(result.agent).toBe("claude-web");
  expect(result.sessionsFound).toBe(1);
  expect(result.sessionsIngested).toBe(1);
  expect(result.messagesIngested).toBe(2);
  expect(result.errors).toHaveLength(0);

  // Verify session metadata
  const meta = db
    .prepare("SELECT * FROM smriti_session_meta WHERE session_id = ?")
    .get("test-conv-001") as any;
  expect(meta).toBeTruthy();
  expect(meta.agent_id).toBe("claude-web");
});

test("ingestClaudeWeb stores messages in QMD memory_messages", async () => {
  const conversations = [makeConversation()];
  const filePath = writeTmpJson("conversations.json", conversations);

  await ingestClaudeWeb(db, filePath, { db });

  const messages = db
    .prepare("SELECT * FROM memory_messages WHERE session_id = ? ORDER BY id")
    .all("test-conv-001") as any[];
  expect(messages.length).toBe(2);
  expect(messages[0].role).toBe("user");
  expect(messages[0].content).toContain("Hello, can you help me?");
  expect(messages[1].role).toBe("assistant");
  expect(messages[1].content).toContain("Sure, I can help!");
});

// =============================================================================
// Artifact Extraction
// =============================================================================

test("ingestClaudeWeb extracts artifacts from tool_use blocks", async () => {
  const conversations = [
    makeConversation({
      chat_messages: [
        {
          uuid: "msg-art",
          text: "",
          content: [
            {
              type: "tool_use",
              name: "artifacts",
              id: null,
              input: {
                id: "tax-calculator",
                type: "application/vnd.ant.code",
                title: "Tax Calculator",
                command: "create",
                content: "function calcTax(salary) { return salary * 0.3; }",
                language: "javascript",
                version_uuid: "v1",
              },
            },
          ],
          sender: "assistant",
          created_at: "2025-06-01T10:00:05Z",
          updated_at: "2025-06-01T10:00:05Z",
          attachments: [],
          files: [],
        },
      ],
    }),
  ];
  const filePath = writeTmpJson("conversations.json", conversations);

  await ingestClaudeWeb(db, filePath, { db });

  const artifacts = db
    .prepare("SELECT * FROM smriti_artifacts WHERE session_id = ?")
    .all("test-conv-001") as any[];
  expect(artifacts).toHaveLength(1);
  expect(artifacts[0].artifact_id).toBe("tax-calculator");
  expect(artifacts[0].type).toBe("application/vnd.ant.code");
  expect(artifacts[0].title).toBe("Tax Calculator");
  expect(artifacts[0].command).toBe("create");
  expect(artifacts[0].language).toBe("javascript");
  expect(artifacts[0].content).toContain("calcTax");
});

test("ingestClaudeWeb handles artifact updates (no type field)", async () => {
  const conversations = [
    makeConversation({
      chat_messages: [
        {
          uuid: "msg-update",
          text: "",
          content: [
            {
              type: "tool_use",
              name: "artifacts",
              id: null,
              input: {
                id: "tax-calculator",
                command: "update",
                old_str: "salary * 0.3",
                new_str: "salary * 0.25",
                version_uuid: "v2",
              },
            },
          ],
          sender: "assistant",
          created_at: "2025-06-01T10:01:00Z",
          updated_at: "2025-06-01T10:01:00Z",
          attachments: [],
          files: [],
        },
      ],
    }),
  ];
  const filePath = writeTmpJson("conversations.json", conversations);

  await ingestClaudeWeb(db, filePath, { db });

  const artifacts = db
    .prepare("SELECT * FROM smriti_artifacts WHERE session_id = ?")
    .all("test-conv-001") as any[];
  expect(artifacts).toHaveLength(1);
  expect(artifacts[0].command).toBe("update");
  expect(artifacts[0].type).toBeNull();
});

// =============================================================================
// Thinking Block Extraction
// =============================================================================

test("ingestClaudeWeb extracts thinking blocks", async () => {
  const conversations = [
    makeConversation({
      chat_messages: [
        {
          uuid: "msg-think",
          text: "",
          content: [
            {
              type: "thinking",
              thinking: "Let me analyze this step by step. First, the user wants...",
            },
            { type: "text", text: "Here is my analysis." },
          ],
          sender: "assistant",
          created_at: "2025-06-01T10:00:05Z",
          updated_at: "2025-06-01T10:00:05Z",
          attachments: [],
          files: [],
        },
      ],
    }),
  ];
  const filePath = writeTmpJson("conversations.json", conversations);

  await ingestClaudeWeb(db, filePath, { db });

  const thinking = db
    .prepare("SELECT * FROM smriti_thinking WHERE session_id = ?")
    .all("test-conv-001") as any[];
  expect(thinking).toHaveLength(1);
  expect(thinking[0].thinking).toContain("step by step");
});

// =============================================================================
// Attachment Extraction
// =============================================================================

test("ingestClaudeWeb extracts attachments with content", async () => {
  const conversations = [
    makeConversation({
      chat_messages: [
        {
          uuid: "msg-att",
          text: "Here is my config file",
          content: [{ type: "text", text: "Here is my config file" }],
          sender: "human",
          created_at: "2025-06-01T10:00:00Z",
          updated_at: "2025-06-01T10:00:00Z",
          attachments: [
            {
              file_name: "eslint.config.ts",
              file_type: "txt",
              file_size: 4531,
              extracted_content:
                "import { defineConfig } from 'eslint/config';",
            },
          ],
          files: [{ file_name: "eslint.config.ts" }],
        },
      ],
    }),
  ];
  const filePath = writeTmpJson("conversations.json", conversations);

  await ingestClaudeWeb(db, filePath, { db });

  const attachments = db
    .prepare("SELECT * FROM smriti_attachments WHERE session_id = ?")
    .all("test-conv-001") as any[];
  expect(attachments).toHaveLength(1);
  expect(attachments[0].file_name).toBe("eslint.config.ts");
  expect(attachments[0].file_type).toBe("txt");
  expect(attachments[0].file_size).toBe(4531);
  expect(attachments[0].content).toContain("defineConfig");
});

// =============================================================================
// Voice Note Extraction
// =============================================================================

test("ingestClaudeWeb extracts voice notes", async () => {
  const conversations = [
    makeConversation({
      chat_messages: [
        {
          uuid: "msg-voice",
          text: "",
          content: [
            {
              type: "voice_note",
              title: "Clarification Needed",
              text: "\nNeed more context\n\nAbout a person?\n",
            },
          ],
          sender: "human",
          created_at: "2025-06-01T10:00:00Z",
          updated_at: "2025-06-01T10:00:00Z",
          attachments: [],
          files: [],
        },
      ],
    }),
  ];
  const filePath = writeTmpJson("conversations.json", conversations);

  await ingestClaudeWeb(db, filePath, { db });

  const voiceNotes = db
    .prepare("SELECT * FROM smriti_voice_notes WHERE session_id = ?")
    .all("test-conv-001") as any[];
  expect(voiceNotes).toHaveLength(1);
  expect(voiceNotes[0].title).toBe("Clarification Needed");
  expect(voiceNotes[0].transcript).toContain("Need more context");
});

// =============================================================================
// Deduplication
// =============================================================================

test("ingestClaudeWeb skips already-ingested sessions by UUID", async () => {
  const conversations = [makeConversation()];
  const filePath = writeTmpJson("conversations.json", conversations);

  // First ingest
  const r1 = await ingestClaudeWeb(db, filePath, { db });
  expect(r1.sessionsIngested).toBe(1);

  // Second ingest — should skip
  const existingSessionIds = getExistingSessionIds(db);
  const r2 = await ingestClaudeWeb(db, filePath, { db, existingSessionIds });
  expect(r2.sessionsIngested).toBe(0);
  expect(r2.skipped).toBe(1);
});

// =============================================================================
// Edge Cases
// =============================================================================

test("ingestClaudeWeb skips empty conversations", async () => {
  const conversations = [
    makeConversation({ chat_messages: [] }),
    makeConversation({ uuid: "test-conv-002" }),
  ];
  const filePath = writeTmpJson("conversations.json", conversations);

  const result = await ingestClaudeWeb(db, filePath, { db });
  expect(result.sessionsFound).toBe(2);
  expect(result.sessionsIngested).toBe(1);
  expect(result.skipped).toBe(1);
});

test("ingestClaudeWeb handles invalid JSON file", async () => {
  const filePath = join(tmpDir, "bad.json");
  writeFileSync(filePath, "not json");

  const result = await ingestClaudeWeb(db, filePath, { db });
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toContain("Failed to read");
});

test("ingestClaudeWeb handles multiple content block types in one message", async () => {
  const conversations = [
    makeConversation({
      chat_messages: [
        {
          uuid: "msg-mixed",
          text: "",
          content: [
            {
              type: "thinking",
              thinking: "Let me think about this...",
            },
            { type: "text", text: "Here is a calculator:" },
            {
              type: "tool_use",
              name: "artifacts",
              id: null,
              input: {
                id: "calc",
                type: "application/vnd.ant.code",
                title: "Calculator",
                command: "create",
                content: "const add = (a, b) => a + b;",
                language: "typescript",
              },
            },
          ],
          sender: "assistant",
          created_at: "2025-06-01T10:00:05Z",
          updated_at: "2025-06-01T10:00:05Z",
          attachments: [],
          files: [],
        },
      ],
    }),
  ];
  const filePath = writeTmpJson("conversations.json", conversations);

  await ingestClaudeWeb(db, filePath, { db });

  const artifacts = db
    .prepare("SELECT * FROM smriti_artifacts WHERE session_id = ?")
    .all("test-conv-001") as any[];
  const thinking = db
    .prepare("SELECT * FROM smriti_thinking WHERE session_id = ?")
    .all("test-conv-001") as any[];

  expect(artifacts).toHaveLength(1);
  expect(thinking).toHaveLength(1);
  expect(artifacts[0].title).toBe("Calculator");
  expect(thinking[0].thinking).toContain("think about this");
});

// =============================================================================
// Memory Import
// =============================================================================

test("ingestClaudeWebMemories imports conversation and project memories", async () => {
  const memories = [
    {
      conversations_memory: "User is a frontend engineer based in Goa.",
      project_memories: {
        "project-1": "Working on HRMS platform.",
        "project-2": "Building AI memory layer.",
      },
      account_uuid: "test-account",
    },
  ];
  const filePath = writeTmpJson("memories.json", memories);

  const result = await ingestClaudeWebMemories(db, filePath, { db });
  expect(result.sessionsIngested).toBe(1);
  expect(result.messagesIngested).toBe(3); // 1 conversation + 2 project

  const messages = db
    .prepare(
      "SELECT * FROM memory_messages WHERE session_id = ? ORDER BY id"
    )
    .all("claude-web-memory-test-account") as any[];
  expect(messages).toHaveLength(3);
  expect(messages[0].content).toContain("frontend engineer");
  expect(messages[1].content).toContain("HRMS");
  expect(messages[2].content).toContain("AI memory");
});

test("ingestClaudeWebMemories skips if already imported", async () => {
  const memories = [
    {
      conversations_memory: "Test memory",
      project_memories: {},
      account_uuid: "test-account",
    },
  ];
  const filePath = writeTmpJson("memories.json", memories);

  await ingestClaudeWebMemories(db, filePath, { db });

  const existingSessionIds = getExistingSessionIds(db);
  const r2 = await ingestClaudeWebMemories(db, filePath, {
    db,
    existingSessionIds,
  });
  expect(r2.skipped).toBe(1);
  expect(r2.sessionsIngested).toBe(0);
});
