/**
 * test/team.test.ts - Tests for team sharing pipeline utilities
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { isValidCategory } from "../src/categorize/schema";
import { parseFrontmatter } from "../src/team/sync";
import { initSmriti, closeDb } from "../src/db";
import type { Database } from "bun:sqlite";

// =============================================================================
// Setup
// =============================================================================

let db: Database;
beforeAll(async () => { db = await initSmriti(":memory:"); });
afterAll(() => closeDb());

// =============================================================================
// Tag Parsing Tests
// =============================================================================

test("parseFrontmatter extracts tags array", () => {
  const input = `---
tags: ["project", "project/dependency", "decision/tooling"]
---
Body content here`;

  const parsed = parseFrontmatter(input);
  expect(parsed.meta.tags).toBe(`["project", "project/dependency", "decision/tooling"]`);
  expect(parsed.body).toContain("Body content here");
});

test("parseFrontmatter extracts multiple fields", () => {
  const input = `---
category: project
tags: ["a", "b"]
---
Body`;

  const parsed = parseFrontmatter(input);
  expect(parsed.meta.category).toBe("project");
  expect(parsed.meta.tags).toBe(`["a", "b"]`);
});

test("parseFrontmatter handles content without frontmatter", () => {
  const input = "Just plain text without frontmatter delimiters";
  const parsed = parseFrontmatter(input);
  expect(Object.keys(parsed.meta).length).toBe(0);
  expect(parsed.body).toBe(input);
});

// =============================================================================
// Backward Compatibility Tests
// =============================================================================

test("parseFrontmatter returns single category field", () => {
  const input = `---
category: project
---
Some body`;

  const parsed = parseFrontmatter(input);
  expect(parsed.meta.category).toBe("project");
});

test("parseFrontmatter extracts pipeline field for segmented docs", () => {
  const input = `---
category: bug/fix
pipeline: segmented
---
# Bug Fix Title

Some documented content`;

  const parsed = parseFrontmatter(input);
  expect(parsed.meta.pipeline).toBe("segmented");
  expect(parsed.meta.category).toBe("bug/fix");
});

// =============================================================================
// Category Validation Tests
// =============================================================================

test("isValidCategory accepts known categories", () => {
  expect(isValidCategory(db, "bug/fix")).toBe(true);
  expect(isValidCategory(db, "architecture/decision")).toBe(true);
  expect(isValidCategory(db, "code/implementation")).toBe(true);
});

test("isValidCategory rejects unknown categories", () => {
  expect(isValidCategory(db, "made/up/invalid")).toBe(false);
  expect(isValidCategory(db, "nonexistent")).toBe(false);
});

// =============================================================================
// Roundtrip Tests
// =============================================================================

test("parseFrontmatter roundtrip preserves body content", () => {
  const input = `---
category: project
author: testuser
---
# Session Title

**user**: Hello world

**assistant**: Hi there`;

  const parsed = parseFrontmatter(input);
  expect(parsed.meta.category).toBe("project");
  expect(parsed.meta.author).toBe("testuser");
  expect(parsed.body).toContain("# Session Title");
  expect(parsed.body).toContain("**user**: Hello world");
});
