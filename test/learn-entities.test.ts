/**
 * test/learn-entities.test.ts - Tests for canonical entity resolution and
 * relationship triples (RDF-inspired knowledge graph layer).
 *
 * Mirrors test/learn-consolidate.test.ts's style: initSmriti(":memory:"),
 * mocked global.fetch standing in for Ollama, scratch tmpDir for output.
 */

import { test, expect, beforeAll, afterAll, mock } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  initSmriti,
  closeDb,
  upsertSessionMeta,
  upsertProject,
  updateDensityScore,
  insertKnowledgeUnit,
  findPromotableUnits,
} from "../src/db";
import {
  resolveEntity,
  getEntity,
  findEntity,
  insertRelationship,
  getRelationships,
  findRelatedCandidates,
  getUnitsForEntity,
} from "../src/learn/entities";
import { consolidateKnowledge } from "../src/learn/consolidate";
import type { KnowledgeUnit } from "../src/team/types";

let db: Database;
let tmpDir: string;

beforeAll(async () => {
  db = await initSmriti(":memory:");
  tmpDir = join(tmpdir(), `smriti-entities-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterAll(async () => {
  await closeDb();
  try { rmSync(tmpDir, { recursive: true }); } catch {}
});

function seedSession(sessionId: string, projectId: string, messages: Array<{ role: string; content: string }>) {
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

function mockOllamaFetch(handlers: { stage1?: () => object; relation?: () => string; stage2?: () => string }) {
  return mock(async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    const prompt = body.prompt as string;
    if (prompt.includes("Knowledge Unit Segmentation")) {
      return new Response(
        JSON.stringify({ response: "```json\n" + JSON.stringify((handlers.stage1 ?? (() => ({ units: [] })))()) + "\n```" }),
        { status: 200 }
      );
    }
    if (prompt.includes("CANDIDATES")) {
      return new Response(JSON.stringify({ response: (handlers.relation ?? (() => ""))() }), { status: 200 });
    }
    return new Response(
      JSON.stringify({ response: (handlers.stage2 ?? (() => "# Doc\n\nContent."))() }),
      { status: 200 }
    );
  });
}

// =============================================================================
// Entity resolution
// =============================================================================

test("resolveEntity merges exact-normalize variants (case/whitespace) onto one canonical id", () => {
  const id1 = resolveEntity(db, "JWT")!;
  const id2 = resolveEntity(db, " jwt ")!;
  const id3 = resolveEntity(db, "JWT.");

  expect(id1).toBe(id2);
  expect(id1).toBe(id3);

  const entity = getEntity(db, id1)!;
  expect(entity.label).toBe("JWT"); // first-seen label wins
  expect(entity.aliases).toContain("JWT");
  expect(entity.aliases).toContain("jwt");
  expect(entity.mention_count).toBe(3);
});

test("resolveEntity does not merge genuinely different wordings for the same concept", () => {
  const jwtId = resolveEntity(db, "distinct-jwt-test")!;
  const fullFormId = resolveEntity(db, "distinct-json-web-token-test")!;

  expect(jwtId).not.toBe(fullFormId);
});

test("resolveEntity returns null for blank labels", () => {
  expect(resolveEntity(db, "   ")).toBeNull();
});

test("findEntity looks up by exact id or by label", () => {
  resolveEntity(db, "Redis");
  expect(findEntity(db, "Redis")?.id).toBe("redis");
  expect(findEntity(db, "redis")?.id).toBe("redis");
  expect(findEntity(db, "nonexistent-entity-xyz")).toBeNull();
});

// =============================================================================
// Relationship triples
// =============================================================================

test("insertRelationship dedups via the UNIQUE constraint", () => {
  insertRelationship(db, "knowledge_unit", "unit-a", "mentions", "entity", "redis");
  insertRelationship(db, "knowledge_unit", "unit-a", "mentions", "entity", "redis");

  const rows = getRelationships(db, { subjectType: "knowledge_unit", subjectId: "unit-a", predicate: "mentions" });
  expect(rows.length).toBe(1);
});

test("getRelationships supports single-triple-pattern lookup", () => {
  insertRelationship(db, "knowledge_unit", "unit-b", "supersedes", "knowledge_unit", "unit-a", { source: "llm" });

  const bySubject = getRelationships(db, { subjectId: "unit-b" });
  expect(bySubject.some((r) => r.predicate === "supersedes" && r.object_id === "unit-a")).toBe(true);

  const byPredicate = getRelationships(db, { predicate: "supersedes" });
  expect(byPredicate.length).toBeGreaterThanOrEqual(1);
});

// =============================================================================
// Segment phase: mentions edges created with no extra LLM calls
// =============================================================================

test("consolidate segment phase creates mentions edges for every stored entity, no extra LLM calls", async () => {
  seedSession("ent-s1", "entproj", [
    { role: "user", content: "We need to decide on a caching strategy for the API. Considering Redis vs in-memory caching." },
    { role: "assistant", content: "Redis is better — it's external state, handles multi-instance, fast, and proven." },
  ]);
  updateDensityScore(db, "ent-s1", 0.9);

  let fetchCallCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async (_url: string, init: any) => {
    fetchCallCount++;
    const body = JSON.parse(init.body);
    const isStage1 = (body.prompt as string).includes("Knowledge Unit Segmentation");
    if (isStage1) {
      // relevance kept low (1) deliberately: this unit stays in the shared
      // test DB as tier='segmented' after this test, and must never satisfy
      // a later test's minRelevance threshold (e.g. 8) via leftover state.
      return new Response(
        JSON.stringify({
          response: "```json\n" + JSON.stringify({
            units: [{ topic: "Redis caching decision", category: "architecture/decision", relevance: 1, entities: ["Redis", "Caching"] }],
          }) + "\n```",
        }),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify({ response: "unexpected call" }), { status: 200 });
  }) as any;

  try {
    const result = await consolidateKnowledge(db, {
      minDensity: 0.5,
      minRetrievals: 999,
      minRelevance: 999, // nothing promotable — isolates the segment phase
      outputDir: join(tmpDir, "ent-output"),
    });

    expect(result.unitsStored).toBe(1);
    expect(fetchCallCount).toBe(1); // segmentation only, no promote-time LLM calls

    const unitRow = db
      .prepare(`SELECT id FROM smriti_knowledge_units WHERE session_id = 'ent-s1'`)
      .get() as { id: string };

    const mentions = getRelationships(db, {
      subjectType: "knowledge_unit",
      subjectId: unitRow.id,
      predicate: "mentions",
    });
    expect(mentions.length).toBe(2);
    const objectIds = mentions.map((m) => m.object_id).sort();
    expect(objectIds).toEqual(["caching", "redis"]);

    const unitsForRedis = getUnitsForEntity(db, "redis");
    expect(unitsForRedis.map((u) => u.id)).toContain(unitRow.id);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// =============================================================================
// minEntityReach promotion criterion
// =============================================================================

test("minEntityReach promotes a unit whose entity is shared by >= K other units, even at 0 retrievals", () => {
  const shared: KnowledgeUnit = {
    id: "reach-unit-1", topic: "Topic A", category: "code/pattern", relevance: 2,
    entities: [], files: [], plainText: "content A", lineRanges: [],
  };
  const sharedOther1: KnowledgeUnit = {
    id: "reach-unit-2", topic: "Topic B", category: "code/pattern", relevance: 2,
    entities: [], files: [], plainText: "content B", lineRanges: [],
  };
  const sharedOther2: KnowledgeUnit = {
    id: "reach-unit-3", topic: "Topic C", category: "code/pattern", relevance: 2,
    entities: [], files: [], plainText: "content C", lineRanges: [],
  };

  insertKnowledgeUnit(db, shared, "reach-s1", "reachproj", "reach-hash-1");
  insertKnowledgeUnit(db, sharedOther1, "reach-s2", "reachproj", "reach-hash-2");
  insertKnowledgeUnit(db, sharedOther2, "reach-s3", "reachproj", "reach-hash-3");

  const entityId = resolveEntity(db, "shared-webhook-retries")!;
  insertRelationship(db, "knowledge_unit", "reach-unit-1", "mentions", "entity", entityId);
  insertRelationship(db, "knowledge_unit", "reach-unit-2", "mentions", "entity", entityId);
  insertRelationship(db, "knowledge_unit", "reach-unit-3", "mentions", "entity", entityId);

  // Below scalar thresholds (relevance=2, retrieval_count=0) but 2 OTHER units share the entity.
  const promotableWithReach = findPromotableUnits(db, 999, 999, 2);
  expect(promotableWithReach.map((u) => u.id)).toContain("reach-unit-1");

  // Without minEntityReach, the same unit is not promotable.
  const promotableWithoutReach = findPromotableUnits(db, 999, 999);
  expect(promotableWithoutReach.map((u) => u.id)).not.toContain("reach-unit-1");
});

// =============================================================================
// Promote-phase relationship inference (LLM-gated, bounded)
// =============================================================================

test("promote phase persists LLM-inferred relatesTo/supersedes/contradicts edges", async () => {
  const existing: KnowledgeUnit = {
    id: "infer-existing", topic: "Old Redis TTL guidance", category: "architecture/decision", relevance: 5,
    entities: [], files: [], plainText: "Use a 1-minute TTL.", lineRanges: [],
  };
  insertKnowledgeUnit(db, existing, "infer-s1", "inferproj", "infer-hash-existing");
  const redisId = resolveEntity(db, "infer-redis")!;
  insertRelationship(db, "knowledge_unit", "infer-existing", "mentions", "entity", redisId);

  const promoted: KnowledgeUnit = {
    id: "infer-new", topic: "New Redis TTL guidance", category: "architecture/decision", relevance: 9,
    entities: ["infer-redis"], files: [], plainText: "Use a 5-minute TTL instead.", lineRanges: [],
  };
  insertKnowledgeUnit(db, promoted, "infer-s2", "inferproj", "infer-hash-new");
  insertRelationship(db, "knowledge_unit", "infer-new", "mentions", "entity", redisId);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockOllamaFetch({ relation: () => "RELATION [0]: supersedes" }) as any;

  try {
    const result = await consolidateKnowledge(db, {
      minDensity: 999, // no segment-phase sessions
      minRetrievals: 999,
      minRelevance: 8, // only infer-new (relevance 9) qualifies
      outputDir: join(tmpDir, "infer-output"),
    });

    expect(result.unitsPromoted).toBe(1);
    expect(result.errors).toEqual([]);

    const edges = getRelationships(db, { subjectType: "knowledge_unit", subjectId: "infer-new", predicate: "supersedes" });
    expect(edges.length).toBe(1);
    expect(edges[0].object_id).toBe("infer-existing");
    expect(edges[0].source).toBe("llm");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("promote phase never asserts a directional predicate in both directions for the same pair", async () => {
  // Two units sharing an entity, BOTH clearing the promotion bar in the same
  // run — each independently asks "do I supersede the other" and (with a
  // naive LLM/mock that doesn't reason about recency) can get "yes" from both
  // sides. Only one direction should end up persisted.
  const unitA: KnowledgeUnit = {
    id: "bidir-unit-a", topic: "Redis TTL: 1 minute", category: "architecture/decision", relevance: 9,
    entities: [], files: [], plainText: "Use a 1-minute TTL.", lineRanges: [],
  };
  const unitB: KnowledgeUnit = {
    id: "bidir-unit-b", topic: "Redis TTL: 15 minutes", category: "architecture/decision", relevance: 9,
    entities: [], files: [], plainText: "Use a 15-minute TTL instead.", lineRanges: [],
  };
  insertKnowledgeUnit(db, unitA, "bidir-s1", "bidirproj", "bidir-hash-a");
  insertKnowledgeUnit(db, unitB, "bidir-s2", "bidirproj", "bidir-hash-b");
  const entityId = resolveEntity(db, "bidir-redis")!;
  insertRelationship(db, "knowledge_unit", "bidir-unit-a", "mentions", "entity", entityId);
  insertRelationship(db, "knowledge_unit", "bidir-unit-b", "mentions", "entity", entityId);

  const originalFetch = globalThis.fetch;
  // Always answers "supersedes" regardless of which side is asking — the
  // worst case for this bug, and realistic for a small/local model given a
  // prompt with no explicit recency signal.
  globalThis.fetch = mockOllamaFetch({ relation: () => "RELATION [0]: supersedes" }) as any;

  try {
    const result = await consolidateKnowledge(db, {
      minDensity: 999,
      minRetrievals: 999,
      minRelevance: 8, // both unitA and unitB qualify
      outputDir: join(tmpDir, "bidir-output"),
    });

    expect(result.unitsPromoted).toBe(2);

    const aToB = getRelationships(db, {
      subjectType: "knowledge_unit", subjectId: "bidir-unit-a", predicate: "supersedes", objectId: "bidir-unit-b",
    });
    const bToA = getRelationships(db, {
      subjectType: "knowledge_unit", subjectId: "bidir-unit-b", predicate: "supersedes", objectId: "bidir-unit-a",
    });
    // Exactly one direction persisted, never both.
    expect(aToB.length + bToA.length).toBe(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("promote phase relationship inference is best-effort: a broken LLM response doesn't block promotion", async () => {
  const existing: KnowledgeUnit = {
    id: "badllm-existing", topic: "Existing", category: "code/pattern", relevance: 5,
    entities: [], files: [], plainText: "content", lineRanges: [],
  };
  insertKnowledgeUnit(db, existing, "badllm-s1", "badllmproj", "badllm-hash-existing");
  const entId = resolveEntity(db, "badllm-entity")!;
  insertRelationship(db, "knowledge_unit", "badllm-existing", "mentions", "entity", entId);

  const promoted: KnowledgeUnit = {
    id: "badllm-new", topic: "New", category: "code/pattern", relevance: 9,
    entities: ["badllm-entity"], files: [], plainText: "content", lineRanges: [],
  };
  insertKnowledgeUnit(db, promoted, "badllm-s2", "badllmproj", "badllm-hash-new");
  insertRelationship(db, "knowledge_unit", "badllm-new", "mentions", "entity", entId);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    const prompt = body.prompt as string;
    if (prompt.includes("CANDIDATES")) throw new Error("connection refused");
    return new Response(JSON.stringify({ response: "# Doc\n\nContent." }), { status: 200 });
  }) as any;

  try {
    const result = await consolidateKnowledge(db, {
      minDensity: 999,
      minRetrievals: 999,
      minRelevance: 8,
      outputDir: join(tmpDir, "badllm-output"),
    });

    // Promotion itself succeeds even though relationship inference failed.
    expect(result.unitsPromoted).toBe(1);
    expect(result.errors).toEqual([]);

    const edges = getRelationships(db, { subjectType: "knowledge_unit", subjectId: "badllm-new" })
      .filter((r) => r.predicate !== "mentions");
    expect(edges.length).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// =============================================================================
// findRelatedCandidates
// =============================================================================

test("findRelatedCandidates finds other units sharing a canonical entity, excluding self", () => {
  const a: KnowledgeUnit = { id: "cand-a", topic: "A", category: "code/pattern", relevance: 5, entities: [], files: [], plainText: "a", lineRanges: [] };
  const b: KnowledgeUnit = { id: "cand-b", topic: "B", category: "code/pattern", relevance: 5, entities: [], files: [], plainText: "b", lineRanges: [] };
  insertKnowledgeUnit(db, a, "cand-s1", "candproj", "cand-hash-a");
  insertKnowledgeUnit(db, b, "cand-s2", "candproj", "cand-hash-b");

  const sharedEntity = resolveEntity(db, "cand-shared-entity")!;
  insertRelationship(db, "knowledge_unit", "cand-a", "mentions", "entity", sharedEntity);
  insertRelationship(db, "knowledge_unit", "cand-b", "mentions", "entity", sharedEntity);

  const candidates = findRelatedCandidates(db, "cand-a", 5);
  expect(candidates.map((c) => c.id)).toEqual(["cand-b"]);
  expect(candidates.map((c) => c.id)).not.toContain("cand-a");
});
