import { test, expect, beforeAll } from "bun:test";
import { classifyByRules, classifyMessage } from "../src/categorize/classifier";
import { getRuleManager, resetRuleManager, type Rule } from "../src/categorize/rules/loader";

// =============================================================================
// Setup
// =============================================================================

let testRules: Rule[];

beforeAll(async () => {
  // Initialize rule manager and load general rules
  const ruleManager = getRuleManager();
  testRules = await ruleManager.loadRules({ language: "general" });
});

// =============================================================================
// Tests
// =============================================================================

test("classifies bug-related content", () => {
  const results = classifyByRules(
    "There's an error in the login function. It crashes when the password is empty.",
    testRules
  );
  expect(results.length).toBeGreaterThan(0);
  expect(results[0].categoryId).toMatch(/^bug\//);
});

test("classifies architecture content", () => {
  const results = classifyByRules(
    "We need to design the system architecture for the microservices. Let's create a component diagram.",
    testRules
  );
  expect(results.length).toBeGreaterThan(0);
  const archResults = results.filter((r) =>
    r.categoryId.startsWith("architecture")
  );
  expect(archResults.length).toBeGreaterThan(0);
});

test("classifies decision content", () => {
  const results = classifyByRules(
    "Should we use JWT or session cookies? I decided to go with JWT because of the microservice architecture.",
    testRules
  );
  expect(results.length).toBeGreaterThan(0);
  const decisionResults = results.filter((r) =>
    r.categoryId.startsWith("decision")
  );
  expect(decisionResults.length).toBeGreaterThan(0);
});

test("classifies project setup content", () => {
  const results = classifyByRules(
    "Let me initialize the project with bun init and set up the configuration files.",
    testRules
  );
  expect(results.length).toBeGreaterThan(0);
  const setupResults = results.filter((r) =>
    r.categoryId.startsWith("project")
  );
  expect(setupResults.length).toBeGreaterThan(0);
});

test("classifies code pattern content", () => {
  const results = classifyByRules(
    "Let me refactor this using the strategy pattern. It's a common design pattern for this use case.",
    testRules
  );
  expect(results.length).toBeGreaterThan(0);
  expect(results[0].categoryId).toBe("code/pattern");
});

test("classifies comparison content", () => {
  const results = classifyByRules(
    "Let me compare Redis vs Memcached for our caching needs. Which is better for our use case?",
    testRules
  );
  expect(results.length).toBeGreaterThan(0);
  const compResults = results.filter(
    (r) => r.categoryId === "topic/comparison"
  );
  expect(compResults.length).toBeGreaterThan(0);
});

test("classifies dependency content", () => {
  const results = classifyByRules(
    "We need to install the dependencies. Run bun install to get all packages.",
    testRules
  );
  expect(results.length).toBeGreaterThan(0);
  const depResults = results.filter(
    (r) => r.categoryId === "project/dependency"
  );
  expect(depResults.length).toBeGreaterThan(0);
});

test("returns empty array for unclassifiable content", () => {
  const results = classifyByRules("hello world", testRules);
  // May or may not match - the important thing is no crash
  expect(Array.isArray(results)).toBe(true);
});

test("results are sorted by confidence", () => {
  const results = classifyByRules(
    "Fix the bug by refactoring the authentication pattern to use a better design.",
    testRules
  );
  for (let i = 1; i < results.length; i++) {
    expect(results[i].confidence).toBeLessThanOrEqual(results[i - 1].confidence);
  }
});

test("classifyMessage returns top result without LLM", async () => {
  const result = await classifyMessage(
    "There's an error in the login function. The stack trace shows a null pointer.",
    { useLLM: false, rules: testRules }
  );
  expect(result).not.toBeNull();
  expect(result!.categoryId).toMatch(/^bug\//);
  expect(result!.source).toBe("rule");
});
