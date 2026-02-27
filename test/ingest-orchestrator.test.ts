import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
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
  root = mkdtempSync(join(tmpdir(), "smriti-orch-"));
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test("ingest(codex) uses parser+resolver+gateway flow", async () => {
  const logsDir = join(root, "codex");
  mkdirSync(join(logsDir, "team"), { recursive: true });
  writeFileSync(
    join(logsDir, "team", "chat.jsonl"),
    [
      JSON.stringify({ role: "user", content: "How do we shard this?" }),
      JSON.stringify({ role: "assistant", content: "Use tenant hash." }),
    ].join("\n")
  );

  const result = await ingest(db, "codex", { logsDir });
  expect(result.errors).toHaveLength(0);
  expect(result.sessionsFound).toBe(1);
  expect(result.sessionsIngested).toBe(1);
  expect(result.messagesIngested).toBe(2);

  const meta = db
    .prepare("SELECT agent_id, project_id FROM smriti_session_meta")
    .get() as { agent_id: string; project_id: string | null };
  expect(meta.agent_id).toBe("codex");
  expect(meta.project_id).toBeNull();
});

test("ingest(file) accepts explicit project without FK failure", async () => {
  const filePath = join(root, "transcript.jsonl");
  writeFileSync(
    filePath,
    [
      JSON.stringify({ role: "user", content: "Set rollout plan" }),
      JSON.stringify({ role: "assistant", content: "Canary then full rollout" }),
    ].join("\n")
  );

  const result = await ingest(db, "file", {
    filePath,
    format: "jsonl",
    sessionId: "file-1",
    projectId: "proj-file",
  });

  expect(result.errors).toHaveLength(0);
  expect(result.sessionsIngested).toBe(1);
  expect(result.messagesIngested).toBe(2);

  const project = db
    .prepare("SELECT id FROM smriti_projects WHERE id = ?")
    .get("proj-file") as { id: string } | null;
  expect(project).not.toBeNull();

  const meta = db
    .prepare("SELECT session_id, agent_id, project_id FROM smriti_session_meta WHERE session_id = ?")
    .get("file-1") as { session_id: string; agent_id: string | null; project_id: string };
  expect(meta.project_id).toBe("proj-file");
  expect(meta.agent_id === null || meta.agent_id === "generic").toBe(true);
});
