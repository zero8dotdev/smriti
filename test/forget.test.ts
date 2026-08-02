/**
 * test/forget.test.ts - Tests for the smriti forget (session deletion) layer
 *
 * Mirrors test/learn-consolidate.test.ts's style: initSmriti(":memory:") so
 * QMD's full schema (documents, content_vectors, vectors_vec) exists, a
 * seedSession() helper for real message rows, and closeDb() teardown.
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  initSmriti,
  closeDb,
  upsertProject,
  upsertSessionMeta,
  insertKnowledgeUnit,
  promoteKnowledgeUnit,
  listKnowledgeUnits,
  forgetSession,
} from "../src/db";
import { listSessions } from "../src/qmd";
import type { KnowledgeUnit } from "../src/team/types";

let db: Database;

beforeAll(async () => {
  db = await initSmriti(":memory:");
});

afterAll(async () => {
  await closeDb();
});

function seedSession(
  sessionId: string,
  projectId: string,
  messages: Array<{ role: string; content: string }>
) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO memory_sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`
  ).run(sessionId, `Session ${sessionId}`, now, now);

  const insertMsg = db.prepare(
    `INSERT INTO memory_messages (session_id, role, content, hash, created_at) VALUES (?, ?, ?, ?, ?)`
  );
  for (const [i, m] of messages.entries()) {
    insertMsg.run(sessionId, m.role, m.content, `${sessionId}-h${i}`, now);
  }

  upsertProject(db, projectId);
  upsertSessionMeta(db, sessionId, "claude-code", projectId);
}

const SAMPLE_MESSAGES = [
  { role: "user", content: "What's our rate limiting strategy?" },
  { role: "assistant", content: "Token bucket, 100 req/min per API key." },
];

// =============================================================================
// Soft delete
// =============================================================================

test("forgetSession soft-deletes by default: hidden from list, kept with includeInactive", () => {
  seedSession("soft-s1", "forgetproj", SAMPLE_MESSAGES);

  const result = forgetSession(db, "soft-s1");
  expect(result.hard).toBe(false);

  const active = listSessions(db as any, { includeInactive: false });
  expect(active.map((s: any) => s.id)).not.toContain("soft-s1");

  const all = listSessions(db as any, { includeInactive: true });
  expect(all.map((s: any) => s.id)).toContain("soft-s1");

  // Messages are untouched by a soft delete.
  const msgs = db
    .prepare(`SELECT COUNT(*) as c FROM memory_messages WHERE session_id = ?`)
    .get("soft-s1") as { c: number };
  expect(msgs.c).toBe(SAMPLE_MESSAGES.length);
});

// =============================================================================
// Hard delete
// =============================================================================

test("forgetSession --hard removes messages, sidecar rows, and unpromoted knowledge units", () => {
  seedSession("hard-s1", "forgetproj", SAMPLE_MESSAGES);

  db.prepare(
    `INSERT INTO smriti_session_tags (session_id, category_id, confidence, source) VALUES (?, ?, ?, ?)`
  ).run("hard-s1", "bug/fix", 0.9, "auto");

  const segmented: KnowledgeUnit = {
    id: "hard-unit-segmented",
    topic: "Never promoted",
    category: "code/pattern",
    relevance: 2,
    entities: [],
    files: [],
    plainText: "Low relevance, never promoted.",
    lineRanges: [{ start: 0, end: 1 }],
  };
  insertKnowledgeUnit(db, segmented, "hard-s1", "forgetproj", "hard-hash-1");
  db.prepare(
    `INSERT INTO smriti_relationships (subject_type, subject_id, predicate, object_type, object_id) VALUES ('knowledge_unit', ?, 'mentions', 'entity', 'rate-limiting')`
  ).run("hard-unit-segmented");

  const result = forgetSession(db, "hard-s1", { hard: true });
  expect(result.hard).toBe(true);
  expect(result.unitsDeleted).toBe(1);

  const msgs = db
    .prepare(`SELECT COUNT(*) as c FROM memory_messages WHERE session_id = ?`)
    .get("hard-s1") as { c: number };
  expect(msgs.c).toBe(0);

  const sessionRow = db.prepare(`SELECT 1 FROM memory_sessions WHERE id = ?`).get("hard-s1");
  expect(sessionRow).toBeNull();

  const tags = db
    .prepare(`SELECT COUNT(*) as c FROM smriti_session_tags WHERE session_id = ?`)
    .get("hard-s1") as { c: number };
  expect(tags.c).toBe(0);

  const meta = db.prepare(`SELECT 1 FROM smriti_session_meta WHERE session_id = ?`).get("hard-s1");
  expect(meta).toBeNull();

  const unit = db.prepare(`SELECT 1 FROM smriti_knowledge_units WHERE id = ?`).get("hard-unit-segmented");
  expect(unit).toBeNull();

  const edges = db
    .prepare(`SELECT COUNT(*) as c FROM smriti_relationships WHERE subject_id = ?`)
    .get("hard-unit-segmented") as { c: number };
  expect(edges.c).toBe(0);
});

test("forgetSession --hard keeps canonical units and their doc/share unless --purge-shared", () => {
  seedSession("hard-s2", "forgetproj", SAMPLE_MESSAGES);

  const canonical: KnowledgeUnit = {
    id: "hard-unit-canonical",
    topic: "Already shared decision",
    category: "architecture/decision",
    relevance: 9,
    entities: [],
    files: [],
    plainText: "Already promoted and shared.",
    lineRanges: [{ start: 0, end: 1 }],
  };
  insertKnowledgeUnit(db, canonical, "hard-s2", "forgetproj", "hard-hash-2");
  promoteKnowledgeUnit(db, "hard-unit-canonical", "knowledge/architecture-decision/doc.md", "share-1");
  db.prepare(
    `INSERT INTO smriti_shares (id, session_id, unit_id) VALUES (?, ?, ?)`
  ).run("share-1", "hard-s2", "hard-unit-canonical");

  const result = forgetSession(db, "hard-s2", { hard: true });
  expect(result.canonicalKept).toBe(1);
  expect(result.unitsPurged).toBe(0);

  const kept = listKnowledgeUnits(db, { tier: "canonical" }).find(
    (u) => u.id === "hard-unit-canonical"
  );
  expect(kept).toBeDefined();

  const share = db.prepare(`SELECT 1 FROM smriti_shares WHERE id = ?`).get("share-1");
  expect(share).toBeTruthy();
});

test("forgetSession --hard --purge-shared removes canonical units and their share row", () => {
  seedSession("hard-s3", "forgetproj", SAMPLE_MESSAGES);

  const canonical: KnowledgeUnit = {
    id: "purge-unit-canonical",
    topic: "Purge me too",
    category: "architecture/decision",
    relevance: 9,
    entities: [],
    files: [],
    plainText: "Promoted, but this session is being fully purged.",
    lineRanges: [{ start: 0, end: 1 }],
  };
  insertKnowledgeUnit(db, canonical, "hard-s3", "forgetproj", "hard-hash-3");
  promoteKnowledgeUnit(db, "purge-unit-canonical", "knowledge/architecture-decision/purge-me.md", "share-2");
  db.prepare(
    `INSERT INTO smriti_shares (id, session_id, unit_id) VALUES (?, ?, ?)`
  ).run("share-2", "hard-s3", "purge-unit-canonical");

  const result = forgetSession(db, "hard-s3", { hard: true, purgeShared: true });
  expect(result.unitsPurged).toBe(1);
  expect(result.canonicalKept).toBe(0);

  const unit = db.prepare(`SELECT 1 FROM smriti_knowledge_units WHERE id = ?`).get("purge-unit-canonical");
  expect(unit).toBeNull();

  const share = db.prepare(`SELECT 1 FROM smriti_shares WHERE id = ?`).get("share-2");
  expect(share).toBeNull();
});
