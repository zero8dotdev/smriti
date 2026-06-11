/**
 * test/team.test.ts - Tests for team sharing pipeline utilities
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { isValidCategory } from "../src/categorize/schema";
import { parseFrontmatter } from "../src/team/sync";
import { mergeCategories, readConfig, writeConfig, exportCustomCategories } from "../src/team/config";
import { initSmriti, closeDb } from "../src/db";
import type { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// =============================================================================
// Setup
// =============================================================================

let db: Database;
let tmpDir: string;

beforeAll(async () => {
  db = await initSmriti(":memory:");
  tmpDir = join(tmpdir(), `smriti-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterAll(() => {
  closeDb();
  try { rmSync(tmpDir, { recursive: true }); } catch {}
});

// =============================================================================
// Tag Parsing Tests — #1
// =============================================================================

test("parseFrontmatter parses tags array into string[]", () => {
  const input = `---
tags: ["project", "project/dependency", "decision/tooling"]
---
Body content here`;

  const parsed = parseFrontmatter(input);
  expect(Array.isArray(parsed.meta.tags)).toBe(true);
  expect(parsed.meta.tags).toEqual(["project", "project/dependency", "decision/tooling"]);
  expect(parsed.body).toContain("Body content here");
});

test("parseFrontmatter parses tags array with scalar category", () => {
  const input = `---
category: project
tags: ["project", "project/dependency"]
---
Body`;

  const parsed = parseFrontmatter(input);
  expect(parsed.meta.category).toBe("project");
  expect(Array.isArray(parsed.meta.tags)).toBe(true);
  expect(parsed.meta.tags).toEqual(["project", "project/dependency"]);
});

test("parseFrontmatter keeps scalar values as strings", () => {
  const input = `---
category: project
author: alice
---
Body`;

  const parsed = parseFrontmatter(input);
  expect(typeof parsed.meta.category).toBe("string");
  expect(parsed.meta.category).toBe("project");
  expect(parsed.meta.author).toBe("alice");
});

test("parseFrontmatter handles empty tags array", () => {
  const input = `---
tags: []
---
Body`;

  const parsed = parseFrontmatter(input);
  expect(Array.isArray(parsed.meta.tags)).toBe(true);
  expect((parsed.meta.tags as string[]).length).toBe(0);
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

test("parseFrontmatter returns single category field (no tags array)", () => {
  const input = `---
category: project
---
Some body`;

  const parsed = parseFrontmatter(input);
  expect(parsed.meta.category).toBe("project");
  expect(parsed.meta.tags).toBeUndefined();
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

// =============================================================================
// mergeCategories Tests — #2
// =============================================================================

test("mergeCategories adds new custom categories to DB", () => {
  const n = mergeCategories(db, [
    { id: "client", name: "Client-side" },
    { id: "client/web-ui", name: "Web UI", parent: "client" },
  ]);
  expect(n).toBe(2);
  expect(isValidCategory(db, "client")).toBe(true);
  expect(isValidCategory(db, "client/web-ui")).toBe(true);
});

test("mergeCategories is idempotent — second call returns 0", () => {
  mergeCategories(db, [{ id: "infra", name: "Infrastructure" }]);
  const n = mergeCategories(db, [{ id: "infra", name: "Infrastructure" }]);
  expect(n).toBe(0);
});

test("mergeCategories skips builtin categories", () => {
  const n = mergeCategories(db, [{ id: "bug/fix", name: "Bug Fix" }]);
  expect(n).toBe(0);
});

test("mergeCategories handles parent-before-child ordering regardless of input order", () => {
  // child listed before parent in input — should still work
  const n = mergeCategories(db, [
    { id: "ops/incident", name: "Incident", parent: "ops" },
    { id: "ops", name: "Operations" },
  ]);
  // Both should be created; parent first despite input order
  expect(isValidCategory(db, "ops")).toBe(true);
  expect(isValidCategory(db, "ops/incident")).toBe(true);
  expect(n).toBe(2);
});

test("mergeCategories skips child whose parent doesn't exist and isn't in the batch", () => {
  const n = mergeCategories(db, [
    { id: "orphan/child", name: "Orphan Child", parent: "nonexistent-parent" },
  ]);
  expect(n).toBe(0);
  expect(isValidCategory(db, "orphan/child")).toBe(false);
});

// =============================================================================
// Config Read/Write Tests — #2
// =============================================================================

test("writeConfig + readConfig roundtrip", async () => {
  const config = {
    version: 2,
    categories: [{ id: "mycat", name: "My Category" }],
    allowedCategories: ["*"] as string[],
    autoSync: false,
  };
  await writeConfig(tmpDir, config);
  const back = readConfig(tmpDir);
  expect(back.version).toBe(2);
  expect(back.categories).toHaveLength(1);
  expect(back.categories![0]!.id).toBe("mycat");
});

test("readConfig returns default when file missing", () => {
  const config = readConfig(join(tmpDir, "nonexistent"));
  expect(config.version).toBe(1);
  expect(config.categories).toBeUndefined();
});

// =============================================================================
// exportCustomCategories Tests — #2
// =============================================================================

test("exportCustomCategories returns only non-builtin categories", () => {
  // client, client/web-ui, infra, ops, ops/incident were added in earlier tests
  const custom = exportCustomCategories(db);
  const ids = custom.map(c => c.id);
  // Should include our custom ones
  expect(ids).toContain("client");
  expect(ids).toContain("ops/incident");
  // Should NOT include builtins
  expect(ids).not.toContain("bug/fix");
  expect(ids).not.toContain("code");
});

test("exportCustomCategories includes parent field when set", () => {
  const custom = exportCustomCategories(db);
  const webUi = custom.find(c => c.id === "client/web-ui");
  expect(webUi).toBeDefined();
  expect(webUi!.parent).toBe("client");
});
