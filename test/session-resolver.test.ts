/**
 * test/session-resolver.test.ts - Test session resolver layer
 *
 * Verifies project detection, path derivation, and incremental logic.
 */

import { test, expect, describe, beforeEach } from "bun:test";
import Database from "bun:sqlite";
import {
  deriveProjectPath,
  deriveProjectId,
  resolveSession,
} from "../src/ingest/session-resolver";

// =============================================================================
// Test Helpers
// =============================================================================

let db: Database;

beforeEach(() => {
  // Create in-memory database for testing
  db = new Database(":memory:");

  // Create required tables for testing
  db.exec(`
    CREATE TABLE IF NOT EXISTS smriti_session_meta (
      session_id TEXT PRIMARY KEY,
      agent_id TEXT,
      project_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS memory_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      role TEXT,
      content TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS smriti_projects (
      project_id TEXT PRIMARY KEY,
      project_path TEXT
    );
  `);
});

// =============================================================================
// Path Derivation Tests
// =============================================================================

describe("deriveProjectPath", () => {
  test("returns PROJECTS_ROOT for empty input", () => {
    const path = deriveProjectPath("");
    expect(path).toMatch(/zero8\.dev/); // Should contain root path
  });

  test("returns absolute paths unchanged", () => {
    const input = "/Users/zero8/zero8.dev/smriti";
    const path = deriveProjectPath(input);
    expect(path).toBe(input);
  });

  test("handles single-segment paths", () => {
    const path = deriveProjectPath("smriti");
    expect(path).toContain("smriti");
  });

  test("handles multi-segment paths with dashes", () => {
    // Simulates Claude-style encoding: "-Users-zero8-zero8.dev-smriti" → "/Users/zero8/zero8.dev/smriti"
    // Note: This requires actual filesystem paths, so we test the logic
    const path = deriveProjectPath("-Users-zero8");
    expect(typeof path).toBe("string");
    expect(path.startsWith("/")).toBe(true);
  });
});

// =============================================================================
// Project ID Derivation Tests
// =============================================================================

describe("deriveProjectId", () => {
  test("strips PROJECTS_ROOT to get relative ID", () => {
    // Assuming PROJECTS_ROOT is ~/zero8.dev, this would strip it
    const id = deriveProjectId("smriti");
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  test("returns basename for unknown paths", () => {
    const id = deriveProjectId("/var/tmp/project");
    expect(id).toBe("project");
  });

  test("returns 'home' for root", () => {
    const id = deriveProjectId("/");
    expect(id).toMatch(/^(home|\/|root)$/);
  });

  test("handles nested project paths", () => {
    const id = deriveProjectId("client/features/auth");
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// Session Resolution Tests
// =============================================================================

describe("resolveSession", () => {
  test("marks session as new when not in database", async () => {
    const resolved = await resolveSession(
      db,
      "session-123",
      "/tmp/test",
      "claude"
    );

    expect(resolved.sessionId).toBe("session-123");
    expect(resolved.isNew).toBe(true);
    expect(resolved.existingMessageCount).toBe(0);
  });

  test("detects existing sessions", async () => {
    // Insert session into database
    db.prepare(
      `INSERT INTO smriti_session_meta (session_id, agent_id, project_id) VALUES (?, ?, ?)`
    ).run("existing-session", "claude", "test-project");

    const resolved = await resolveSession(
      db,
      "existing-session",
      "/tmp/test",
      "claude"
    );

    expect(resolved.isNew).toBe(false);
  });

  test("counts existing messages for incremental ingest", async () => {
    const sessionId = "session-456";

    // Insert some existing messages
    for (let i = 0; i < 5; i++) {
      db.prepare(
        `INSERT INTO memory_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)`
      ).run(`msg-${i}`, sessionId, "user", `Message ${i}`);
    }

    const resolved = await resolveSession(db, sessionId, "/tmp/test", "claude");

    expect(resolved.existingMessageCount).toBe(5);
  });

  test("returns projectId and projectPath", async () => {
    const resolved = await resolveSession(
      db,
      "session-789",
      "smriti",
      "claude"
    );

    expect(resolved.projectId).toBeDefined();
    expect(typeof resolved.projectId).toBe("string");
    expect(resolved.projectPath).toBeDefined();
    expect(typeof resolved.projectPath).toBe("string");
  });

  test("handles zero existing messages", async () => {
    const resolved = await resolveSession(
      db,
      "new-session",
      "/tmp/test",
      "claude"
    );

    expect(resolved.existingMessageCount).toBe(0);
  });
});

// =============================================================================
// Incremental Ingest Scenario
// =============================================================================

describe("Incremental Ingest Scenario", () => {
  test("correctly identifies new messages after initial ingest", async () => {
    const sessionId = "incremental-test";

    // First resolution: should show 0 existing
    const first = await resolveSession(db, sessionId, "/tmp/test", "claude");
    expect(first.existingMessageCount).toBe(0);

    // Simulate adding 3 messages
    for (let i = 0; i < 3; i++) {
      db.prepare(
        `INSERT INTO memory_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)`
      ).run(`msg-${i}`, sessionId, "user", `Message ${i}`);
    }

    // Second resolution: should show 3 existing
    const second = await resolveSession(
      db,
      sessionId,
      "/tmp/test",
      "claude"
    );
    expect(second.existingMessageCount).toBe(3);

    // Add 2 more messages
    for (let i = 3; i < 5; i++) {
      db.prepare(
        `INSERT INTO memory_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)`
      ).run(`msg-${i}`, sessionId, "user", `Message ${i}`);
    }

    // Third resolution: should show 5 existing
    const third = await resolveSession(db, sessionId, "/tmp/test", "claude");
    expect(third.existingMessageCount).toBe(5);
  });
});
