/**
 * test/team-segmented.test.ts - Tests for 3-stage segmentation pipeline
 */

import { test, expect, beforeAll, afterAll, mock } from "bun:test";
import { initSmriti, closeDb, getDb } from "../src/db";
import type { Database } from "bun:sqlite";
import type { RawMessage } from "../src/team/formatter";
import { segmentSession, fallbackToSingleUnit } from "../src/team/segment";
import { generateDocument, generateDocumentsSequential } from "../src/team/document";
import { isValidCategory } from "../src/categorize/schema";
import type { KnowledgeUnit } from "../src/team/types";

// =============================================================================
// Test Setup
// =============================================================================

let db: Database;

beforeAll(async () => {
  db = await initSmriti(":memory:");
});

afterAll(async () => {
  await closeDb();
});

// =============================================================================
// Test Data
// =============================================================================

const SAMPLE_BUG_SESSION: RawMessage[] = [
  {
    role: "user",
    content: "I'm getting a JWT token expiry issue. Sessions timeout after 1 hour but tests expect 24 hours.",
  },
  {
    role: "assistant",
    content: "Let me look at the auth middleware to understand the token expiry logic.",
  },
  {
    role: "user",
    content: "I found it. In src/auth.ts, the JWT expires in 3600 seconds (1 hour). But our tests set environment variable JWT_TTL=86400.",
  },
  {
    role: "assistant",
    content: "I see the issue. The code hardcodes 3600 instead of reading from the environment. Let's fix that.",
  },
  {
    role: "user",
    content: "Done. I updated it to use process.env.JWT_TTL || 3600. Tests pass now.",
  },
];

const SAMPLE_ARCHITECTURE_SESSION: RawMessage[] = [
  {
    role: "user",
    content: "We need to decide on a caching strategy for the API responses. Considering Redis vs in-memory.",
  },
  {
    role: "assistant",
    content: "What's the main constraint? Latency, memory, or multi-instance consistency?",
  },
  {
    role: "user",
    content: "All of the above. We have 3 servers and need sub-100ms cache hits.",
  },
  {
    role: "assistant",
    content: "Redis is better then. It's external state, handles multi-instance, fast, and proven. In-memory would require cache invalidation across servers.",
  },
  {
    role: "user",
    content: "Agreed. Let's use Redis with a 5-minute TTL for API responses.",
  },
];

// =============================================================================
// Segmentation Tests
// =============================================================================

test("fallbackToSingleUnit creates single unit from messages", () => {
  const result = fallbackToSingleUnit("session-1", SAMPLE_BUG_SESSION);

  expect(result.sessionId).toBe("session-1");
  expect(result.units.length).toBe(1);
  expect(result.units[0].category).toBe("uncategorized");
  expect(result.units[0].relevance).toBe(6);
  expect(result.totalMessages).toBe(5);
});

test("fallbackToSingleUnit includes all non-filtered message content", () => {
  const result = fallbackToSingleUnit("session-2", SAMPLE_BUG_SESSION);
  const unit = result.units[0];

  expect(unit.plainText).toContain("JWT token expiry");
  expect(unit.plainText).toContain("environment");
});

test("fallbackToSingleUnit generates unique unit IDs", () => {
  const result1 = fallbackToSingleUnit("session-3a", SAMPLE_BUG_SESSION);
  const result2 = fallbackToSingleUnit("session-3b", SAMPLE_BUG_SESSION);

  expect(result1.units[0].id).not.toBe(result2.units[0].id);
});

// =============================================================================
// Knowledge Unit Tests
// =============================================================================

test("KnowledgeUnit has valid schema", () => {
  const result = fallbackToSingleUnit("session-4", SAMPLE_BUG_SESSION);
  const unit = result.units[0];

  // Check required fields
  expect(unit.id).toBeDefined();
  expect(unit.id.length).toBeGreaterThan(0);
  expect(typeof unit.topic).toBe("string");
  expect(typeof unit.category).toBe("string");
  expect(typeof unit.relevance).toBe("number");
  expect(unit.relevance >= 0 && unit.relevance <= 10).toBe(true);
  expect(Array.isArray(unit.entities)).toBe(true);
  expect(Array.isArray(unit.files)).toBe(true);
  expect(typeof unit.plainText).toBe("string");
  expect(Array.isArray(unit.lineRanges)).toBe(true);
});

// =============================================================================
// Documentation Generation Tests (with mocked Ollama)
// =============================================================================

test("generateDocument creates valid result with mocked Ollama", async () => {
  // Mock fetch to return a realistic Ollama response
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async () =>
    new Response(
      JSON.stringify({
        response: "# Token Expiry Bug Fix\n\n## Symptoms\nSessions expired after 1 hour.\n\n## Root Cause\nHardcoded TTL of 3600s.",
      }),
      { status: 200 }
    )
  );

  try {
    const unit: KnowledgeUnit = {
      id: "unit-test-1",
      topic: "Token expiry bug fix",
      category: "bug/fix",
      relevance: 8,
      entities: ["JWT", "Authentication"],
      files: ["src/auth.ts"],
      plainText: "Fixed token expiry by reading from environment variable",
      lineRanges: [{ start: 0, end: 5 }],
    };

    const result = await generateDocument(unit, "Token Expiry Bug Fix", { model: "test-model" });

    expect(result.unitId).toBe("unit-test-1");
    expect(result.category).toBe("bug/fix");
    expect(result.title).toBe("Token Expiry Bug Fix");
    expect(result.markdown).toContain("Token Expiry Bug Fix");
    expect(result.filename).toMatch(/^\d{4}-\d{2}-\d{2}_token-expiry-bug-fix\.md$/);
    expect(result.tokenEstimate).toBeGreaterThan(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("generateDocumentsSequential processes units in order with mocked Ollama", async () => {
  let callOrder = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async () => {
    callOrder++;
    return new Response(
      JSON.stringify({
        response: `# Document ${callOrder}\n\nContent for document ${callOrder}.`,
      }),
      { status: 200 }
    );
  });

  try {
    const units: KnowledgeUnit[] = [
      {
        id: "unit-1",
        topic: "First unit",
        category: "code/implementation",
        relevance: 7,
        entities: ["TypeScript"],
        files: ["src/main.ts"],
        plainText: "First unit content",
        lineRanges: [{ start: 0, end: 2 }],
      },
      {
        id: "unit-2",
        topic: "Second unit",
        category: "architecture/decision",
        relevance: 8,
        entities: ["Database"],
        files: ["src/db.ts"],
        plainText: "Second unit content",
        lineRanges: [{ start: 3, end: 5 }],
      },
    ];

    const results = await generateDocumentsSequential(units);

    expect(results.length).toBe(2);
    expect(results[0].unitId).toBe("unit-1");
    expect(results[1].unitId).toBe("unit-2");
    expect(results[0].category).toBe("code/implementation");
    expect(results[1].category).toBe("architecture/decision");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("generateDocument falls back to plainText on Ollama failure", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async () => {
    throw new Error("Connection refused");
  });

  try {
    const unit: KnowledgeUnit = {
      id: "unit-fallback",
      topic: "Fallback test",
      category: "topic/learning",
      relevance: 7,
      entities: [],
      files: [],
      plainText: "This is the raw content that should appear as fallback",
      lineRanges: [{ start: 0, end: 1 }],
    };

    const result = await generateDocument(unit, "Fallback Test");

    expect(result.markdown).toContain("raw content that should appear as fallback");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// =============================================================================
// Segmentation Result Tests
// =============================================================================

test("SegmentationResult has valid structure", () => {
  const result = fallbackToSingleUnit("session-5", SAMPLE_BUG_SESSION);

  expect(result.sessionId).toBe("session-5");
  expect(Array.isArray(result.units)).toBe(true);
  expect(result.units.length > 0).toBe(true);
  expect(result.totalMessages).toBe(SAMPLE_BUG_SESSION.length);
  expect(typeof result.processingDurationMs).toBe("number");
  expect(result.processingDurationMs >= 0).toBe(true);
});

// =============================================================================
// Relevance Filtering Tests
// =============================================================================

test("Units with relevance >= threshold should be shared", () => {
  const units: KnowledgeUnit[] = [
    {
      id: "high-rel",
      topic: "Critical bug",
      category: "bug/fix",
      relevance: 9,
      entities: [],
      files: [],
      plainText: "Important fix",
      lineRanges: [],
    },
    {
      id: "medium-rel",
      topic: "Nice to know",
      category: "topic/learning",
      relevance: 6,
      entities: [],
      files: [],
      plainText: "Educational content",
      lineRanges: [],
    },
    {
      id: "low-rel",
      topic: "Trivial",
      category: "uncategorized",
      relevance: 3,
      entities: [],
      files: [],
      plainText: "Not worth sharing",
      lineRanges: [],
    },
  ];

  const minRelevance = 6;
  const worthSharing = units.filter((u) => u.relevance >= minRelevance);

  expect(worthSharing.length).toBe(2);
  expect(worthSharing.map((u) => u.id)).toContain("high-rel");
  expect(worthSharing.map((u) => u.id)).toContain("medium-rel");
  expect(worthSharing.map((u) => u.id)).not.toContain("low-rel");
});

test("Custom relevance threshold filters correctly", () => {
  const units: KnowledgeUnit[] = [
    { id: "1", topic: "A", category: "uncategorized", relevance: 7, entities: [], files: [], plainText: "", lineRanges: [] },
    { id: "2", topic: "B", category: "uncategorized", relevance: 5, entities: [], files: [], plainText: "", lineRanges: [] },
    { id: "3", topic: "C", category: "uncategorized", relevance: 9, entities: [], files: [], plainText: "", lineRanges: [] },
  ];

  const threshold7 = units.filter((u) => u.relevance >= 7);
  expect(threshold7.length).toBe(2);
  expect(threshold7.map((u) => u.id)).toEqual(["1", "3"]);

  const threshold8 = units.filter((u) => u.relevance >= 8);
  expect(threshold8.length).toBe(1);
  expect(threshold8[0].id).toBe("3");
});

// =============================================================================
// Category Validation Tests (using real DB)
// =============================================================================

test("Valid categories pass DB validation", () => {
  const validCategories = [
    "bug/fix",
    "architecture/decision",
    "code/implementation",
    "feature/design",
    "project/setup",
    "topic/learning",
    "decision/technical",
  ];

  for (const cat of validCategories) {
    expect(isValidCategory(db, cat)).toBe(true);
  }
});

test("Invalid categories are rejected by DB validation", () => {
  expect(isValidCategory(db, "made/up/invalid/category")).toBe(false);
  expect(isValidCategory(db, "nonexistent")).toBe(false);
  expect(isValidCategory(db, "")).toBe(false);
});

// =============================================================================
// Edge Cases
// =============================================================================

test("handles empty message list", () => {
  const result = fallbackToSingleUnit("empty-session", []);

  expect(result.units.length).toBe(1);
  expect(result.units[0].plainText).toBe("");
  expect(result.totalMessages).toBe(0);
});

test("handles very long conversations", () => {
  const longSession: RawMessage[] = [];
  for (let i = 0; i < 1000; i++) {
    longSession.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i}: This is a test message content.`,
    });
  }

  const result = fallbackToSingleUnit("long-session", longSession);

  expect(result.units.length).toBe(1);
  expect(result.totalMessages).toBe(1000);
  expect(result.units[0].plainText.length > 0).toBe(true);
});

test("preserves message content through sanitization", () => {
  const messages: RawMessage[] = [
    {
      role: "user",
      content: "Technical question about implementation",
    },
  ];

  const result = fallbackToSingleUnit("sanitize-test", messages);

  expect(result.units[0].plainText).toContain("implementation");
});
