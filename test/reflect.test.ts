import { test, expect, describe } from "bun:test";
import {
  parseReflection,
  loadPromptTemplate,
  hasSubstantiveReflection,
} from "../src/team/reflect";
import type { Reflection } from "../src/team/reflect";

// =============================================================================
// parseReflection
// =============================================================================

describe("parseReflection", () => {
  test("parses well-formed LLM response", () => {
    const response = `### Learnings
The developer learned how to set up JWT authentication with Bun.

### Key Takeaway
JWT middleware should validate tokens on every protected route, not just at login.

### Team Context
The auth system uses RS256 signing with keys stored in environment variables.

### Changes Made
Created src/auth/middleware.ts, login.ts, register.ts, and refresh.ts.

### Discovery
Bun's built-in crypto module supports JWT signing natively without external packages.`;

    const result = parseReflection(response);

    expect(result.learnings).toContain("JWT authentication");
    expect(result.keyTakeaway).toContain("validate tokens");
    expect(result.teamContext).toContain("RS256");
    expect(result.changesMade).toContain("middleware.ts");
    expect(result.discovery).toContain("crypto module");
  });

  test("handles missing sections gracefully", () => {
    const response = `### Learnings
Learned about SQLite FTS5 indexing.

### Key Takeaway
N/A

### Changes Made
Updated the search module.`;

    const result = parseReflection(response);

    expect(result.learnings).toContain("FTS5");
    expect(result.keyTakeaway).toBe(""); // N/A stripped
    expect(result.teamContext).toBe(""); // missing section
    expect(result.changesMade).toContain("search module");
    expect(result.discovery).toBe(""); // missing section
  });

  test("handles completely empty response", () => {
    const result = parseReflection("");

    expect(result.learnings).toBe("");
    expect(result.keyTakeaway).toBe("");
    expect(result.teamContext).toBe("");
    expect(result.changesMade).toBe("");
    expect(result.discovery).toBe("");
  });

  test("handles response with extra text before sections", () => {
    const response = `Here is my analysis of the session:

### Learnings
The team set up a new Bun project.

### Key Takeaway
Using Bun.serve() with HTML imports eliminates the need for Vite.

### Team Context
N/A

### Changes Made
Initialized smriti/ directory with package.json and source structure.

### Discovery
N/A`;

    const result = parseReflection(response);
    expect(result.learnings).toContain("Bun project");
    expect(result.keyTakeaway).toContain("HTML imports");
    expect(result.teamContext).toBe("");
    expect(result.changesMade).toContain("smriti/");
    expect(result.discovery).toBe("");
  });

  test("strips N/A variations", () => {
    const response = `### Learnings
N/A

### Key Takeaway
n/a

### Team Context
N/A.

### Changes Made
na

### Discovery
Something real here.`;

    const result = parseReflection(response);
    expect(result.learnings).toBe("");
    expect(result.keyTakeaway).toBe("");
    expect(result.teamContext).toBe("");
    // "na" matches the N/A pattern (/ is optional)
    expect(result.changesMade).toBe("");
    expect(result.discovery).toContain("Something real");
  });
});

// =============================================================================
// hasSubstantiveReflection
// =============================================================================

describe("hasSubstantiveReflection", () => {
  test("returns false when all fields empty", () => {
    const reflection: Reflection = {
      learnings: "",
      keyTakeaway: "",
      teamContext: "",
      changesMade: "",
      discovery: "",
    };
    expect(hasSubstantiveReflection(reflection)).toBe(false);
  });

  test("returns true when at least one field has content", () => {
    const reflection: Reflection = {
      learnings: "",
      keyTakeaway: "Use Bun for everything.",
      teamContext: "",
      changesMade: "",
      discovery: "",
    };
    expect(hasSubstantiveReflection(reflection)).toBe(true);
  });
});

// =============================================================================
// loadPromptTemplate
// =============================================================================

describe("loadPromptTemplate", () => {
  test("loads built-in default template", async () => {
    const template = await loadPromptTemplate();

    expect(template).toContain("{{conversation}}");
    expect(template).toContain("### Learnings");
    expect(template).toContain("### Key Takeaway");
    expect(template).toContain("### Team Context");
    expect(template).toContain("### Changes Made");
    expect(template).toContain("### Discovery");
  });

  test("falls back to default when project dir doesn't have override", async () => {
    const template = await loadPromptTemplate("/nonexistent/path/.smriti");

    expect(template).toContain("{{conversation}}");
    expect(template).toContain("### Learnings");
  });
});

// =============================================================================
// Integration with formatter
// =============================================================================

describe("reflection in formatted output", () => {
  test("formatAsDocument includes reflection block", async () => {
    // Import formatter here to test integration
    const { formatAsDocument } = await import("../src/team/formatter");

    const reflection: Reflection = {
      learnings: "Learned about JWT auth patterns.",
      keyTakeaway: "Always validate tokens server-side.",
      teamContext: "Auth uses RS256 with env-stored keys.",
      changesMade: "Created auth middleware and routes.",
      discovery: "Bun supports native JWT signing.",
    };

    const doc = formatAsDocument(
      "Auth Setup",
      "Setting up authentication",
      [
        { role: "user", content: "Add JWT auth" },
        { role: "assistant", content: "Created the auth system." },
      ],
      { reflection }
    );

    expect(doc).toContain("# Auth Setup");
    expect(doc).toContain("**Learnings:** Learned about JWT auth patterns.");
    expect(doc).toContain("**Key Takeaway:** Always validate tokens");
    expect(doc).toContain("**Team Context:** Auth uses RS256");
    expect(doc).toContain("**Changes Made:** Created auth middleware");
    expect(doc).toContain("**Discovery:** Bun supports native JWT");
    expect(doc).toContain("---");
    // Reflection should appear before the conversation content
    const reflectionIdx = doc.indexOf("**Learnings:**");
    const conversationIdx = doc.indexOf("## Add JWT auth");
    expect(reflectionIdx).toBeLessThan(conversationIdx);
  });

  test("formatAsDocument works without reflection", async () => {
    const { formatAsDocument } = await import("../src/team/formatter");

    const doc = formatAsDocument("Title", null, [
      { role: "user", content: "question" },
      { role: "assistant", content: "answer" },
    ]);

    expect(doc).not.toContain("**Learnings:**");
    expect(doc).not.toContain("---");
    expect(doc).toContain("# Title");
  });
});
