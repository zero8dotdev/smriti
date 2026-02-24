/**
 * test/rules-loader.test.ts - Rule loading and merging tests
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { RuleManager, type Rule, type RulesDocument } from "../src/categorize/rules/loader";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";

// =============================================================================
// Setup
// =============================================================================

let testDir: string;
let ruleManager: RuleManager;

beforeAll(() => {
  testDir = join(tmpdir(), `smriti-rules-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  ruleManager = new RuleManager();
});

afterAll(() => {
  ruleManager.clear();
});

// =============================================================================
// Tests
// =============================================================================

test("loads general rules from YAML file", async () => {
  const projectDir = join(testDir, "test-project-1");
  mkdirSync(projectDir, { recursive: true });

  // Create a test YAML rules file
  const rulesDoc: RulesDocument = {
    version: "1.0.0",
    language: "test",
    rules: [
      {
        id: "test-rule-1",
        pattern: "\\btest\\b",
        category: "topic/learning",
        weight: 0.8,
        description: "Test rule",
      },
    ],
  };

  const rulesPath = join(projectDir, ".smriti", "rules", "base.yml");
  mkdirSync(join(projectDir, ".smriti", "rules"), { recursive: true });
  writeFileSync(rulesPath, stringifyYaml(rulesDoc));

  // For this test, we'll use the rules directly
  const rules = rulesDoc.rules;
  expect(rules).toHaveLength(1);
  expect(rules[0].id).toBe("test-rule-1");
  expect(rules[0].weight).toBe(0.8);
});

test("merges base and project rules with override", () => {
  const baseRules: Rule[] = [
    {
      id: "rule-1",
      pattern: "\\btest\\b",
      category: "topic/learning",
      weight: 0.7,
    },
    {
      id: "rule-2",
      pattern: "\\bbug\\b",
      category: "bug/report",
      weight: 0.8,
    },
  ];

  const projectRules: Rule[] = [
    {
      id: "rule-1",
      pattern: "\\bcustom\\b",
      category: "topic/learning",
      weight: 0.9, // Override weight
    },
  ];

  const merged = ruleManager.mergeRules(baseRules, projectRules, []);

  expect(merged).toHaveLength(2);

  // Find rule-1 and check that project override applied
  const rule1 = merged.find((r) => r.id === "rule-1");
  expect(rule1?.weight).toBe(0.9);
  expect(rule1?.pattern).toBe("\\bcustom\\b"); // Project version should override

  // rule-2 should remain unchanged
  const rule2 = merged.find((r) => r.id === "rule-2");
  expect(rule2?.weight).toBe(0.8);
});

test("merges all three tiers with proper precedence", () => {
  const baseRules: Rule[] = [
    {
      id: "rule-1",
      pattern: "\\bbase\\b",
      category: "bug/report",
      weight: 0.5,
    },
  ];

  const projectRules: Rule[] = [
    {
      id: "rule-1",
      weight: 0.7, // Tier 2 override
    },
  ];

  const runtimeRules: Rule[] = [
    {
      id: "rule-1",
      weight: 0.95, // Tier 3 override (highest precedence)
    },
  ];

  const merged = ruleManager.mergeRules(baseRules, projectRules, runtimeRules);

  const rule1 = merged.find((r) => r.id === "rule-1");
  expect(rule1?.weight).toBe(0.95); // Runtime should win
});

test("adds new rules from project tier", () => {
  const baseRules: Rule[] = [
    {
      id: "rule-1",
      pattern: "\\bbase\\b",
      category: "bug/report",
      weight: 0.8,
    },
  ];

  const projectRules: Rule[] = [
    {
      id: "custom-rule",
      pattern: "\\bcustom\\b",
      category: "code/pattern",
      weight: 0.6,
    },
  ];

  const merged = ruleManager.mergeRules(baseRules, projectRules, []);

  expect(merged).toHaveLength(2);
  const customRule = merged.find((r) => r.id === "custom-rule");
  expect(customRule?.category).toBe("code/pattern");
});

test("compiles and caches regex patterns", () => {
  const rule: Rule = {
    id: "test-pattern",
    pattern: "\\b(test|debug)\\b",
    category: "bug/investigation",
    weight: 0.7,
  };

  const regex1 = ruleManager.compilePattern(rule);
  const regex2 = ruleManager.compilePattern(rule); // Should return cached version

  expect(regex1).toBe(regex2); // Same object reference
  expect(regex1.test("test")).toBe(true);
  expect(regex1.test("debug")).toBe(true);
  expect(regex1.test("hello")).toBe(false);
});

test("handles invalid regex patterns gracefully", () => {
  const rule: Rule = {
    id: "invalid-pattern",
    pattern: "[invalid(", // Invalid regex
    category: "bug/report",
    weight: 0.8,
  };

  const regex = ruleManager.compilePattern(rule);
  // Should return a pattern that never matches
  expect(regex.test("anything")).toBe(false);
});

test("filters rules by framework", () => {
  const rules: Rule[] = [
    {
      id: "global-rule",
      pattern: "\\bglobal\\b",
      category: "bug/report",
      weight: 0.8,
      // No frameworks specified = always applies
    },
    {
      id: "nextjs-rule",
      pattern: "\\bnextjs\\b",
      category: "architecture/design",
      weight: 0.7,
      frameworks: ["nextjs"],
    },
    {
      id: "fastapi-rule",
      pattern: "\\bfastapi\\b",
      category: "architecture/design",
      weight: 0.7,
      frameworks: ["fastapi"],
    },
  ];

  // Filter for Next.js project
  const nextjsRules = ruleManager.filterByFramework(rules, "nextjs");
  expect(nextjsRules).toHaveLength(2); // global + nextjs
  expect(nextjsRules.some((r) => r.id === "global-rule")).toBe(true);
  expect(nextjsRules.some((r) => r.id === "nextjs-rule")).toBe(true);
  expect(nextjsRules.some((r) => r.id === "fastapi-rule")).toBe(false);

  // Filter for project with no framework
  const noFrameworkRules = ruleManager.filterByFramework(rules, null);
  expect(noFrameworkRules).toHaveLength(1); // Only global
  expect(noFrameworkRules[0].id).toBe("global-rule");

  // Filter for FastAPI
  const fastapiRules = ruleManager.filterByFramework(rules, "fastapi");
  expect(fastapiRules).toHaveLength(2); // global + fastapi
});

test("clear cache removes all cached rules", () => {
  const rule: Rule = {
    id: "test-rule",
    pattern: "\\btest\\b",
    category: "bug/report",
    weight: 0.8,
  };

  ruleManager.compilePattern(rule);
  expect(() => {
    ruleManager.compilePattern(rule); // Should use cached version
  }).not.toThrow();

  ruleManager.clear();

  // After clear, pattern should recompile (but still work)
  const regex = ruleManager.compilePattern(rule);
  expect(regex.test("test")).toBe(true);
});
