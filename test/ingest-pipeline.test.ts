import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { initializeMemoryTables } from "../src/qmd";
import { initializeSmritiTables, seedDefaults } from "../src/db";
import { ingestCodex } from "../src/ingest/codex";
import { ingestCursor } from "../src/ingest/cursor";
import { ingestCline } from "../src/ingest/cline";
import { ingestGeneric } from "../src/ingest/generic";

let db: Database;
let root: string;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  initializeMemoryTables(db);
  initializeSmritiTables(db);
  seedDefaults(db);
  root = mkdtempSync(join(tmpdir(), "smriti-ingest-"));
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test("ingestCodex ingests jsonl sessions and writes session meta", async () => {
  const logsDir = join(root, "codex");
  mkdirSync(join(logsDir, "team"), { recursive: true });
  writeFileSync(
    join(logsDir, "team", "chat.jsonl"),
    [
      JSON.stringify({ role: "user", content: "How do we cache this?" }),
      JSON.stringify({ role: "assistant", content: "Use a short TTL." }),
    ].join("\n")
  );

  const result = await ingestCodex({ db, logsDir });

  expect(result.sessionsFound).toBe(1);
  expect(result.sessionsIngested).toBe(1);
  expect(result.messagesIngested).toBe(2);

  const meta = db
    .prepare("SELECT session_id, agent_id, project_id FROM smriti_session_meta")
    .all() as Array<{ session_id: string; agent_id: string; project_id: string | null }>;

  expect(meta).toHaveLength(1);
  expect(meta[0].session_id).toBe("codex-team-chat");
  expect(meta[0].agent_id).toBe("codex");
  expect(meta[0].project_id).toBeNull();
});

test("ingestCursor ingests sessions and associates basename project id", async () => {
  const projectPath = join(root, "my-app");
  mkdirSync(join(projectPath, ".cursor"), { recursive: true });
  writeFileSync(
    join(projectPath, ".cursor", "conv.json"),
    JSON.stringify({
      messages: [
        { role: "user", content: "Implement auth" },
        { role: "assistant", content: "Added middleware" },
      ],
    })
  );

  const result = await ingestCursor({ db, projectPath });

  expect(result.sessionsFound).toBe(1);
  expect(result.sessionsIngested).toBe(1);
  expect(result.messagesIngested).toBe(2);

  const project = db
    .prepare("SELECT id, path FROM smriti_projects WHERE id = ?")
    .get("my-app") as { id: string; path: string } | null;
  expect(project).not.toBeNull();
  expect(project!.path).toBe(projectPath);

  const meta = db
    .prepare("SELECT project_id FROM smriti_session_meta")
    .get() as { project_id: string };
  expect(meta.project_id).toBe("my-app");
});

test("ingestCline ingests task history and derives project from cwd", async () => {
  const logsDir = join(root, "cline");
  mkdirSync(logsDir, { recursive: true });

  writeFileSync(
    join(logsDir, "task-1.json"),
    JSON.stringify({
      id: "task-1",
      name: "Fix tests",
      timestamp: new Date().toISOString(),
      cwd: join(root, "repo-alpha"),
      history: [
        { ts: new Date().toISOString(), type: "say", text: "I can fix this." },
        { ts: new Date().toISOString(), type: "ask", question: "Proceed?", options: "yes,no" },
      ],
    })
  );

  const result = await ingestCline({ db, logsDir });

  expect(result.sessionsFound).toBe(1);
  expect(result.sessionsIngested).toBe(1);
  expect(result.messagesIngested).toBe(2);

  const project = db
    .prepare("SELECT id FROM smriti_projects WHERE id = ?")
    .get("repo-alpha") as { id: string } | null;
  expect(project).not.toBeNull();

  const meta = db
    .prepare("SELECT agent_id, project_id FROM smriti_session_meta WHERE session_id = ?")
    .get("task-1") as { agent_id: string; project_id: string };
  expect(meta.agent_id).toBe("cline");
  expect(meta.project_id).toBe("repo-alpha");
});

test("ingestGeneric stores transcript and preserves explicit project id", async () => {
  const transcriptPath = join(root, "transcript.chat");
  writeFileSync(
    transcriptPath,
    [
      JSON.stringify({ role: "user", content: "How should we version this API?" }),
      JSON.stringify({ role: "assistant", content: "Start with v1 and a deprecation policy." }),
    ].join("\n")
  );

  const result = await ingestGeneric({
    db,
    filePath: transcriptPath,
    format: "jsonl",
    sessionId: "manual-session-1",
    projectId: "manual-project",
    title: "API Versioning",
    agentName: "codex",
  });

  expect(result.sessionsIngested).toBe(1);
  expect(result.messagesIngested).toBeGreaterThan(0);

  const project = db
    .prepare("SELECT id FROM smriti_projects WHERE id = ?")
    .get("manual-project") as { id: string } | null;
  expect(project).not.toBeNull();

  const meta = db
    .prepare("SELECT project_id FROM smriti_session_meta WHERE session_id = ?")
    .get("manual-session-1") as { project_id: string };
  expect(meta.project_id).toBe("manual-project");
});
