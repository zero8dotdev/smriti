/**
 * test/learn-entities-sync.test.ts - Team/org propagation of the entities +
 * relationships layer via the existing share/sync git round-trip.
 *
 * This is the test that directly answers "how does this reach the org/team
 * level": two independent in-memory DBs stand in for two teammates' machines,
 * connected only through a shared tmp `.smriti/` directory (config.json +
 * knowledge/*.md), exactly like real git-committed team knowledge.
 */

import { test, expect, beforeAll, afterAll, mock } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { initSmriti, closeDb, insertKnowledgeUnit, upsertProject } from "../src/db";
import { readConfig, writeConfig, exportEntities } from "../src/team/config";
import { syncTeamKnowledge } from "../src/team/sync";
import { consolidateKnowledge } from "../src/learn/consolidate";
import { getEntity, resolveEntity, insertRelationship, getRelationships } from "../src/learn/entities";
import type { KnowledgeUnit } from "../src/team/types";

// Two independent :memory: databases (via separate initSmriti calls) stand in
// for two teammates' machines. initSmriti's underlying store singleton is
// process-wide, but every call site below threads the returned `db` handle
// explicitly rather than going through the singleton getDb(), so the two
// stay genuinely isolated for everything this test touches.
let dbA: Database;
let dbB: Database;
let sharedDir: string;

beforeAll(async () => {
  dbA = await initSmriti(":memory:");
  dbB = await initSmriti(":memory:");
  sharedDir = join(tmpdir(), `smriti-propagation-test-${Date.now()}`);
  mkdirSync(sharedDir, { recursive: true });

  // Pre-existing FK requirement of syncTeamKnowledge/upsertSessionMeta,
  // unrelated to the entities/relationships work: the importing machine
  // must already have the project registered locally (smriti_session_meta
  // FKs to smriti_projects). Both "teammates" in this test are in the same project.
  upsertProject(dbA, "propproj");
  upsertProject(dbB, "propproj");
});

afterAll(async () => {
  await closeDb();
  try { rmSync(sharedDir, { recursive: true }); } catch {}
});

test("entity canonical id and unit-relationship edges converge across two machines via share -> sync", async () => {
  // --- Machine A: create + promote a unit that mentions "Redis" ---
  const unit: KnowledgeUnit = {
    id: "prop-unit-a",
    topic: "Redis TTL guidance",
    category: "architecture/decision",
    relevance: 9,
    entities: ["Redis"],
    files: [],
    plainText: "Use a 5-minute TTL for API response caching.",
    lineRanges: [],
  };
  insertKnowledgeUnit(dbA, unit, "prop-session-a", "propproj", "prop-hash-a");
  const redisIdOnA = resolveEntity(dbA, "Redis")!;
  insertRelationship(dbA, "knowledge_unit", "prop-unit-a", "mentions", "entity", redisIdOnA);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async () =>
    new Response(JSON.stringify({ response: "# Redis TTL Guidance\n\nUse a 5-minute TTL." }), { status: 200 })
  ) as any;

  try {
    const result = await consolidateKnowledge(dbA, {
      minDensity: 999, // no segment-phase sessions on A — isolates the promote phase
      minRetrievals: 999,
      minRelevance: 8, // unit's relevance (9) qualifies
      outputDir: sharedDir,
    });
    expect(result.unitsPromoted).toBe(1);
    expect(result.errors).toEqual([]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  // --- Machine A "shares": publish its canonical entity registry to the shared config.json ---
  // (this is the exact operation writeManifest performs in src/team/share.ts, just called
  // directly here to isolate propagation from the rest of the share pipeline's session-querying)
  const existingConfig = readConfig(sharedDir);
  await writeConfig(sharedDir, { ...existingConfig, version: 2, entities: exportEntities(dbA) });

  // --- Machine B has never seen "Redis" before ---
  expect(getEntity(dbB, "redis")).toBeNull();

  const syncResult = await syncTeamKnowledge(dbB, { inputDir: sharedDir });

  expect(syncResult.errors).toEqual([]);
  expect(syncResult.entitiesImported).toBeGreaterThanOrEqual(1);
  expect(syncResult.imported).toBeGreaterThanOrEqual(1);

  // The entity converged onto the SAME canonical id — not an independently re-slugified duplicate.
  const redisOnB = getEntity(dbB, "redis");
  expect(redisOnB).toBeTruthy();
  expect(redisOnB!.id).toBe(redisIdOnA);
  expect(redisOnB!.aliases).toContain("Redis");

  // The unit's "mentions" edge was re-created on B, referencing that same entity id.
  const bMentions = getRelationships(dbB, {
    subjectType: "knowledge_unit",
    subjectId: "prop-unit-a",
    predicate: "mentions",
    objectType: "entity",
  });
  expect(bMentions.map((r) => r.object_id)).toContain(redisIdOnA);
});

test("supersedes edges between shared units survive the round-trip with no canonicalization needed", async () => {
  // Machine A: an existing unit, and a new one that supersedes it — both promoted.
  const existing: KnowledgeUnit = {
    id: "prop-superseded-unit", topic: "Old Redis TTL", category: "architecture/decision", relevance: 8,
    entities: ["Redis"], files: [], plainText: "Use a 1-minute TTL.", lineRanges: [],
  };
  const superseding: KnowledgeUnit = {
    id: "prop-superseding-unit", topic: "New Redis TTL", category: "architecture/decision", relevance: 9,
    entities: ["Redis"], files: [], plainText: "Use a 5-minute TTL instead.", lineRanges: [],
  };
  insertKnowledgeUnit(dbA, existing, "prop-session-b1", "propproj", "prop-hash-existing");
  insertKnowledgeUnit(dbA, superseding, "prop-session-b2", "propproj", "prop-hash-superseding");
  const redisId = resolveEntity(dbA, "Redis")!;
  insertRelationship(dbA, "knowledge_unit", "prop-superseded-unit", "mentions", "entity", redisId);
  insertRelationship(dbA, "knowledge_unit", "prop-superseding-unit", "mentions", "entity", redisId);
  // Simulate what promote-phase LLM relationship inference would have discovered:
  insertRelationship(dbA, "knowledge_unit", "prop-superseding-unit", "supersedes", "knowledge_unit", "prop-superseded-unit", { source: "llm" });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async () =>
    new Response(JSON.stringify({ response: "# Doc\n\nContent." }), { status: 200 })
  ) as any;

  try {
    // Only "prop-superseding-unit" clears the bar this round (existing unit stays at relevance 8
    // < minRelevance 8.5, so we promote exactly the one whose frontmatter should carry the edge).
    const result = await consolidateKnowledge(dbA, {
      minDensity: 999,
      minRetrievals: 999,
      minRelevance: 8.5,
      outputDir: sharedDir,
    });
    expect(result.unitsPromoted).toBe(1);
  } finally {
    globalThis.fetch = originalFetch;
  }

  await writeConfig(sharedDir, { ...readConfig(sharedDir), version: 2, entities: exportEntities(dbA) });

  const syncResult = await syncTeamKnowledge(dbB, { inputDir: sharedDir });
  expect(syncResult.errors).toEqual([]);

  const bEdges = getRelationships(dbB, {
    subjectType: "knowledge_unit",
    subjectId: "prop-superseding-unit",
    predicate: "supersedes",
  });
  // No entity-style canonicalization needed here: unit ids are portable UUIDs,
  // so the edge lands referencing the exact same object id on both machines.
  expect(bEdges.map((r) => r.object_id)).toContain("prop-superseded-unit");
});
