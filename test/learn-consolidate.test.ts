/**
 * test/learn-consolidate.test.ts - Tests for continuous knowledge consolidation
 *
 * Mirrors test/team-segmented.test.ts's style: initSmriti(":memory:"), a
 * mocked global.fetch standing in for Ollama, and a scratch tmpDir for
 * filesystem output (never process.cwd() — consolidateKnowledge writes real
 * files).
 */

import { test, expect, beforeAll, afterAll, mock } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  initSmriti,
  closeDb,
  upsertSessionMeta,
  upsertProject,
  updateDensityScore,
  insertKnowledgeUnit,
  listKnowledgeUnits,
  promoteKnowledgeUnit,
} from "../src/db";
import {
  consolidateKnowledge,
  pruneKnowledge,
  classifyRelationshipsTextFormat,
  classifyRelationshipsToolCall,
} from "../src/learn/consolidate";
import { insertRelationship, getRelationships } from "../src/learn/entities";
import { recall } from "../src/search/recall";
import type { KnowledgeUnit } from "../src/team/types";

// =============================================================================
// Setup
// =============================================================================

let db: Database;
let tmpDir: string;

beforeAll(async () => {
  db = await initSmriti(":memory:");
  tmpDir = join(tmpdir(), `smriti-consolidate-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterAll(async () => {
  await closeDb();
  try { rmSync(tmpDir, { recursive: true }); } catch {}
});

/** Insert a session with real message rows so getSessionMessages() finds content. */
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

const DENSE_CONVERSATION = [
  { role: "user", content: "I'm getting a JWT token expiry issue. Sessions timeout after 1 hour but tests expect 24 hours." },
  { role: "assistant", content: "Let me look at the auth middleware to understand the token expiry logic." },
  { role: "user", content: "Found it — src/auth.ts hardcodes 3600 seconds instead of reading JWT_TTL from the environment." },
  { role: "assistant", content: "Updated it to use process.env.JWT_TTL || 3600. Tests pass now." },
];

/** Mock fetch that distinguishes Stage 1 (segmentation) vs Stage 2 (document) calls by prompt content. */
function mockOllamaFetch(stage1Response: () => object) {
  return mock(async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    const isStage1 = (body.prompt as string).includes("Knowledge Unit Segmentation");
    if (isStage1) {
      return new Response(
        JSON.stringify({ response: "```json\n" + JSON.stringify(stage1Response()) + "\n```" }),
        { status: 200 }
      );
    }
    return new Response(
      JSON.stringify({ response: "# Consolidated Doc\n\nPolished content." }),
      { status: 200 }
    );
  });
}

// =============================================================================
// Segment-phase dedup
// =============================================================================

test("consolidate dedups knowledge units with identical content across sessions", async () => {
  seedSession("dedup-s1", "dedupproj", DENSE_CONVERSATION);
  seedSession("dedup-s2", "dedupproj", DENSE_CONVERSATION);
  updateDensityScore(db, "dedup-s1", 0.9);
  updateDensityScore(db, "dedup-s2", 0.9);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockOllamaFetch(() => ({
    units: [{ topic: "JWT token expiry bug", category: "bug/fix", relevance: 9, entities: ["JWT"] }],
  })) as any;

  try {
    const result = await consolidateKnowledge(db, {
      minDensity: 0.5,
      outputDir: join(tmpDir, "dedup-output"),
    });

    expect(result.sessionsSegmented).toBe(2);
    expect(result.unitsStored).toBe(1);
    expect(result.unitsSkipped).toBe(1);
    expect(result.errors).toEqual([]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// =============================================================================
// Promotion threshold
// =============================================================================

test("promote phase only promotes units clearing the retrieval/relevance bar", async () => {
  const belowThreshold: KnowledgeUnit = {
    id: "unit-below",
    topic: "Minor formatting note",
    category: "code/pattern",
    relevance: 3,
    entities: [],
    files: [],
    plainText: "Use consistent indentation.",
    lineRanges: [{ start: 0, end: 1 }],
  };
  const aboveThreshold: KnowledgeUnit = {
    id: "unit-above",
    topic: "Redis caching decision",
    category: "architecture/decision",
    relevance: 9,
    entities: ["Redis"],
    files: [],
    plainText: "Use Redis with a 5-minute TTL for API responses.",
    lineRanges: [{ start: 0, end: 1 }],
  };

  insertKnowledgeUnit(db, belowThreshold, "promote-s1", "promoteproj", "hash-below");
  insertKnowledgeUnit(db, aboveThreshold, "promote-s2", "promoteproj", "hash-above");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockOllamaFetch(() => ({ units: [] })) as any;

  try {
    const result = await consolidateKnowledge(db, {
      minDensity: 999, // no sessions qualify for the segment phase — isolates promote phase
      minRetrievals: 3,
      minRelevance: 8,
      outputDir: join(tmpDir, "promote-output"),
    });

    expect(result.unitsPromoted).toBe(1);
    expect(result.errors).toEqual([]);

    const canonical = listKnowledgeUnits(db, { tier: "canonical" });
    expect(canonical.map((u) => u.id)).toContain("unit-above");
    expect(canonical.map((u) => u.id)).not.toContain("unit-below");

    const promoted = canonical.find((u) => u.id === "unit-above")!;
    expect(promoted.canonical_doc_path).toContain("architecture-decision");
    expect(promoted.share_id).toBeTruthy();

    const shareRow = db
      .prepare(`SELECT * FROM smriti_shares WHERE unit_id = ?`)
      .get("unit-above") as any;
    expect(shareRow).toBeTruthy();
    expect(shareRow.session_id).toBe("promote-s2");

    const writtenFile = join(tmpDir, "promote-output", promoted.canonical_doc_path!);
    expect(existsSync(writtenFile)).toBe(true);

    const stillSegmented = listKnowledgeUnits(db, { tier: "segmented" });
    expect(stillSegmented.map((u) => u.id)).toContain("unit-below");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// =============================================================================
// Graceful degradation
// =============================================================================

test("promote phase continues past a per-unit failure and records the error", async () => {
  // Pre-create a *file* at the exact path the loop will try to mkdir for
  // category "bug/fix" (slug "bug-fix"), forcing that unit's write to throw.
  const outputDir = join(tmpDir, "degrade-output");
  const knowledgeDir = join(outputDir, "knowledge");
  mkdirSync(knowledgeDir, { recursive: true });
  writeFileSync(join(knowledgeDir, "bug-fix"), "occupied");

  const willFail: KnowledgeUnit = {
    id: "unit-fails",
    topic: "Broken unit",
    category: "bug/fix",
    relevance: 9,
    entities: [],
    files: [],
    plainText: "This unit's category dir collides with a file.",
    lineRanges: [{ start: 0, end: 1 }],
  };
  const willSucceed: KnowledgeUnit = {
    id: "unit-succeeds",
    topic: "Working unit",
    category: "topic/learning",
    relevance: 9,
    entities: [],
    files: [],
    plainText: "This unit writes fine.",
    lineRanges: [{ start: 0, end: 1 }],
  };

  insertKnowledgeUnit(db, willFail, "degrade-s1", "degradeproj", "hash-fails");
  insertKnowledgeUnit(db, willSucceed, "degrade-s2", "degradeproj", "hash-succeeds");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockOllamaFetch(() => ({ units: [] })) as any;

  try {
    const result = await consolidateKnowledge(db, {
      minDensity: 999,
      minRetrievals: 999, // exclude leftover segmented units from earlier tests; only relevance-9 units below qualify
      minRelevance: 8,
      outputDir,
    });

    expect(result.unitsPromoted).toBe(1);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("unit-fails");

    const canonical = listKnowledgeUnits(db, { tier: "canonical" });
    expect(canonical.map((u) => u.id)).toContain("unit-succeeds");
    expect(canonical.map((u) => u.id)).not.toContain("unit-fails");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// =============================================================================
// Retrieval tracking (recall -> incrementRetrievalCount)
// =============================================================================

test("recall increments retrieval_count for knowledge units of the recalled session", async () => {
  seedSession("track-s1", "trackproj", [
    { role: "user", content: "How do we configure the rate limiter for the public API?" },
    { role: "assistant", content: "Use a token bucket with 100 requests per minute per API key." },
  ]);

  const unit: KnowledgeUnit = {
    id: "unit-tracked",
    topic: "Rate limiter config",
    category: "code/pattern",
    relevance: 7,
    entities: [],
    files: [],
    plainText: "Token bucket rate limiting for the public API.",
    lineRanges: [{ start: 0, end: 1 }],
  };
  insertKnowledgeUnit(db, unit, "track-s1", "trackproj", "hash-tracked");

  await recall(db, "rate limiter", { project: "trackproj" });

  const tracked = db
    .prepare(`SELECT retrieval_count FROM smriti_knowledge_units WHERE id = ?`)
    .get("unit-tracked") as { retrieval_count: number };
  expect(tracked).toBeDefined();
  expect(tracked.retrieval_count).toBeGreaterThanOrEqual(1);
});

test("recall does not throw for sessions with no consolidated knowledge units", async () => {
  seedSession("untracked-s1", "untrackedproj", [
    { role: "user", content: "What's our deploy process look like?" },
    { role: "assistant", content: "Push to main triggers the CI pipeline and auto-deploys." },
  ]);

  await expect(recall(db, "deploy process", { project: "untrackedproj" })).resolves.toBeDefined();
});

// =============================================================================
// Relationship classification (text-format vs tool-call)
// =============================================================================

const RELATION_UNIT = { topic: "Post-filtering for vector search", category: "architecture/decision", plainText: "Switched to post-filtering." };
const RELATION_CANDIDATES = [
  { id: "cand-0", topic: "Pre-filtering for vector search", category: "architecture/decision", plain_text: "Decided to pre-filter." },
  { id: "cand-1", topic: "Unrelated CSS fix", category: "bug/fix", plain_text: "Fixed a hover overlay." },
];

test("classifyRelationshipsTextFormat parses RELATION lines even without literal brackets", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async () =>
    new Response(JSON.stringify({ response: "RELATION 0: supersedes\nRELATION [1]: none" }), { status: 200 })
  ) as any;

  try {
    const guesses = await classifyRelationshipsTextFormat(RELATION_UNIT, RELATION_CANDIDATES, "test-model");
    expect(guesses).toEqual([
      { index: 0, predicate: "supersedes" },
      { index: 1, predicate: "none" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("classifyRelationshipsTextFormat returns nothing parseable when the model drifts off-format", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async () =>
    new Response(JSON.stringify({ response: "I think candidate 0 is superseded by the new unit." }), { status: 200 })
  ) as any;

  try {
    const guesses = await classifyRelationshipsTextFormat(RELATION_UNIT, RELATION_CANDIDATES, "test-model");
    expect(guesses).toEqual([]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("classifyRelationshipsToolCall parses structured tool_calls output", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async () =>
    new Response(
      JSON.stringify({
        model: "test-model",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              function: {
                name: "record_relationships",
                arguments: {
                  relationships: [
                    { index: 0, predicate: "supersedes" },
                    { index: 1, predicate: "none" },
                  ],
                },
              },
            },
          ],
        },
        done: true,
      }),
      { status: 200 }
    )
  ) as any;

  try {
    const guesses = await classifyRelationshipsToolCall(RELATION_UNIT, RELATION_CANDIDATES, "test-model");
    expect(guesses).toEqual([
      { index: 0, predicate: "supersedes" },
      { index: 1, predicate: "none" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("classifyRelationshipsToolCall drops entries with out-of-range indices or invalid predicates", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async () =>
    new Response(
      JSON.stringify({
        model: "test-model",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              function: {
                name: "record_relationships",
                arguments: {
                  relationships: [
                    { index: 0, predicate: "supersedes" },
                    { index: 99, predicate: "relatesTo" },
                    { index: 1, predicate: "maybe" },
                  ],
                },
              },
            },
          ],
        },
        done: true,
      }),
      { status: 200 }
    )
  ) as any;

  try {
    const guesses = await classifyRelationshipsToolCall(RELATION_UNIT, RELATION_CANDIDATES, "test-model");
    expect(guesses).toEqual([{ index: 0, predicate: "supersedes" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("classifyRelationshipsToolCall returns nothing when the model answers without calling the tool", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async () =>
    new Response(
      JSON.stringify({
        model: "test-model",
        message: { role: "assistant", content: "Candidate 0 looks superseded." },
        done: true,
      }),
      { status: 200 }
    )
  ) as any;

  try {
    const guesses = await classifyRelationshipsToolCall(RELATION_UNIT, RELATION_CANDIDATES, "test-model");
    expect(guesses).toEqual([]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// =============================================================================
// Prune (stale segmented units, superseded canonical units)
// =============================================================================

function backdateUnit(unitId: string, daysAgo: number) {
  db.prepare(
    `UPDATE smriti_knowledge_units SET created_at = datetime('now', '-' || ? || ' days') WHERE id = ?`
  ).run(daysAgo, unitId);
}

test("pruneKnowledge dry-run reports stale segmented units without deleting them", async () => {
  const stale: KnowledgeUnit = {
    id: "prune-stale-1",
    topic: "Never promoted, never retrieved",
    category: "code/pattern",
    relevance: 3,
    entities: [],
    files: [],
    plainText: "Low relevance, sat unused for weeks.",
    lineRanges: [{ start: 0, end: 1 }],
  };
  insertKnowledgeUnit(db, stale, "prune-s1", "pruneproj", "prune-hash-1");
  backdateUnit("prune-stale-1", 45);

  const result = await pruneKnowledge(db, { dryRun: true, pruneStaleDays: 30, minRelevance: 8 });

  expect(result.unitsPruned).toBe(0);
  expect(result.unitsArchived).toBe(0);
  expect(result.pruneCandidates?.map((c) => c.id)).toContain("prune-stale-1");

  const stillThere = listKnowledgeUnits(db, { tier: "segmented" }).find((u) => u.id === "prune-stale-1");
  expect(stillThere).toBeDefined();
});

test("pruneKnowledge --apply deletes stale segmented units and their relationship edges", async () => {
  const stale: KnowledgeUnit = {
    id: "prune-apply-1",
    topic: "Deletable stale unit",
    category: "code/pattern",
    relevance: 2,
    entities: [],
    files: [],
    plainText: "Stale and about to be deleted.",
    lineRanges: [{ start: 0, end: 1 }],
  };
  insertKnowledgeUnit(db, stale, "prune-s2", "pruneproj", "prune-hash-2");
  backdateUnit("prune-apply-1", 45);
  insertRelationship(db, "knowledge_unit", "prune-apply-1", "mentions", "entity", "some-entity");

  const result = await pruneKnowledge(db, { dryRun: false, pruneStaleDays: 30, minRelevance: 8 });

  expect(result.unitsPruned).toBeGreaterThanOrEqual(1);
  const deleted = db.prepare(`SELECT 1 FROM smriti_knowledge_units WHERE id = ?`).get("prune-apply-1");
  expect(deleted).toBeNull();

  const edges = getRelationships(db, { subjectType: "knowledge_unit", subjectId: "prune-apply-1" });
  expect(edges.length).toBe(0);
});

test("pruneKnowledge never prunes high-relevance segmented units even at zero retrievals", async () => {
  const highRelevance: KnowledgeUnit = {
    id: "prune-high-relevance",
    topic: "One consolidate run away from promoting",
    category: "architecture/decision",
    relevance: 9,
    entities: [],
    files: [],
    plainText: "High relevance, just hasn't been promoted yet.",
    lineRanges: [{ start: 0, end: 1 }],
  };
  insertKnowledgeUnit(db, highRelevance, "prune-s3", "pruneproj", "prune-hash-3");
  backdateUnit("prune-high-relevance", 45);

  const result = await pruneKnowledge(db, { dryRun: true, pruneStaleDays: 30, minRelevance: 8 });

  expect(result.pruneCandidates?.map((c) => c.id)).not.toContain("prune-high-relevance");
});

test("pruneKnowledge archives superseded canonical units and appends a banner to their doc", async () => {
  const outputDir = join(tmpDir, "prune-archive-output");
  const docRelPath = "knowledge/architecture-decision/old-doc.md";
  const docFullPath = join(outputDir, docRelPath);
  mkdirSync(join(outputDir, "knowledge/architecture-decision"), { recursive: true });
  writeFileSync(docFullPath, "---\nid: old-unit\n---\n\n# Old guidance\n\nUse a 1-minute TTL.");

  const oldUnit: KnowledgeUnit = {
    id: "prune-superseded", topic: "Old Redis TTL guidance", category: "architecture/decision", relevance: 9,
    entities: [], files: [], plainText: "Use a 1-minute TTL.", lineRanges: [{ start: 0, end: 1 }],
  };
  const newUnit: KnowledgeUnit = {
    id: "prune-superseder", topic: "New Redis TTL guidance", category: "architecture/decision", relevance: 9,
    entities: [], files: [], plainText: "Use a 5-minute TTL instead.", lineRanges: [{ start: 0, end: 1 }],
  };
  insertKnowledgeUnit(db, oldUnit, "prune-s4", "pruneproj", "prune-hash-old");
  insertKnowledgeUnit(db, newUnit, "prune-s5", "pruneproj", "prune-hash-new");
  promoteKnowledgeUnit(db, "prune-superseded", docRelPath, "prune-share-1");
  promoteKnowledgeUnit(db, "prune-superseder", "knowledge/architecture-decision/new-doc.md", "prune-share-2");
  insertRelationship(db, "knowledge_unit", "prune-superseder", "supersedes", "knowledge_unit", "prune-superseded", {
    source: "llm",
  });

  const result = await pruneKnowledge(db, { dryRun: false, outputDir });

  expect(result.unitsArchived).toBe(1);

  const archived = listKnowledgeUnits(db, { tier: "archived" }).find((u) => u.id === "prune-superseded");
  expect(archived).toBeDefined();
  expect(archived!.archived_reason).toBe("superseded");

  const docContent = readFileSync(docFullPath, "utf-8");
  expect(docContent).toContain("Archived");
  expect(docContent).toContain("New Redis TTL guidance");

  // The supersedes edge that justified archiving (and any mentions edges)
  // are the audit trail — left untouched, not cascade-deleted.
  const supersedeEdge = getRelationships(db, {
    subjectType: "knowledge_unit", subjectId: "prune-superseder", predicate: "supersedes", objectId: "prune-superseded",
  });
  expect(supersedeEdge.length).toBe(1);
});
