import { test, expect, describe } from "bun:test";
import {
  parseSynthesis,
  loadPromptTemplate,
  hasSubstantiveSynthesis,
  deriveTitleFromSynthesis,
  formatSynthesisAsDocument,
} from "../src/team/reflect";
import type { Synthesis } from "../src/team/reflect";

// =============================================================================
// parseSynthesis
// =============================================================================

describe("parseSynthesis", () => {
  test("parses well-formed LLM response", () => {
    const response = `### Summary
Set up JWT authentication for the API. Created middleware, login, register, and refresh endpoints with RS256 signing.

### Changes
- Created \`src/auth/middleware.ts\` — validates Bearer tokens on protected routes
- Created \`src/auth/login.ts\` — authenticates credentials and issues tokens
- Created \`src/auth/register.ts\` — creates new user accounts
- Created \`src/auth/refresh.ts\` — rotates expired tokens

### Decisions
Chose RS256 over HS256 for JWT signing because it allows public key verification without sharing the secret. Keys stored in environment variables.

### Insights
Bun's built-in crypto module supports JWT signing natively without external packages like \`jsonwebtoken\`. This eliminates a dependency.

### Context
The API previously had no authentication. All endpoints were public. This was blocking the frontend team from implementing user-specific features.`;

    const result = parseSynthesis(response);

    expect(result.summary).toContain("JWT authentication");
    expect(result.changes).toContain("middleware.ts");
    expect(result.decisions).toContain("RS256");
    expect(result.insights).toContain("crypto module");
    expect(result.context).toContain("no authentication");
  });

  test("handles missing sections gracefully", () => {
    const response = `### Summary
Updated the search module with FTS5 indexing.

### Changes
- Modified \`src/search/index.ts\`

### Decisions
N/A

### Insights
N/A

### Context
Search was previously doing full table scans.`;

    const result = parseSynthesis(response);

    expect(result.summary).toContain("FTS5");
    expect(result.changes).toContain("search/index.ts");
    expect(result.decisions).toBe("");
    expect(result.insights).toBe("");
    expect(result.context).toContain("full table scans");
  });

  test("handles completely empty response", () => {
    const result = parseSynthesis("");

    expect(result.summary).toBe("");
    expect(result.changes).toBe("");
    expect(result.decisions).toBe("");
    expect(result.insights).toBe("");
    expect(result.context).toBe("");
  });

  test("handles response with preamble text before sections", () => {
    const response = `Here is my analysis:

### Summary
Initialized the Smriti project as a Bun-based memory layer.

### Changes
- Created \`package.json\` with Bun config
- Created \`src/\` directory structure

### Decisions
Named the project "Smriti" (Sanskrit for memory) based on user preference.

### Insights
N/A

### Context
N/A`;

    const result = parseSynthesis(response);
    expect(result.summary).toContain("Smriti");
    expect(result.changes).toContain("package.json");
    expect(result.decisions).toContain("Sanskrit");
  });
});

// =============================================================================
// hasSubstantiveSynthesis
// =============================================================================

describe("hasSubstantiveSynthesis", () => {
  test("returns false when all fields empty", () => {
    const synthesis: Synthesis = {
      summary: "",
      changes: "",
      decisions: "",
      insights: "",
      context: "",
    };
    expect(hasSubstantiveSynthesis(synthesis)).toBe(false);
  });

  test("returns false when only summary present", () => {
    const synthesis: Synthesis = {
      summary: "Did some work.",
      changes: "",
      decisions: "",
      insights: "",
      context: "",
    };
    expect(hasSubstantiveSynthesis(synthesis)).toBe(false);
  });

  test("returns true when summary + at least one other section", () => {
    const synthesis: Synthesis = {
      summary: "Set up authentication.",
      changes: "- Created middleware.ts",
      decisions: "",
      insights: "",
      context: "",
    };
    expect(hasSubstantiveSynthesis(synthesis)).toBe(true);
  });
});

// =============================================================================
// deriveTitleFromSynthesis
// =============================================================================

describe("deriveTitleFromSynthesis", () => {
  test("derives title from first sentence of summary", () => {
    const synthesis: Synthesis = {
      summary: "Set up JWT authentication for the API. Created four new files.",
      changes: "",
      decisions: "",
      insights: "",
      context: "",
    };
    expect(deriveTitleFromSynthesis(synthesis)).toBe(
      "Set up JWT authentication for the API"
    );
  });

  test("truncates long titles", () => {
    const synthesis: Synthesis = {
      summary: "A".repeat(100) + ". More text.",
      changes: "",
      decisions: "",
      insights: "",
      context: "",
    };
    const title = deriveTitleFromSynthesis(synthesis);
    expect(title!.length).toBeLessThanOrEqual(80);
    expect(title!.endsWith("...")).toBe(true);
  });

  test("returns null when no summary", () => {
    const synthesis: Synthesis = {
      summary: "",
      changes: "",
      decisions: "",
      insights: "",
      context: "",
    };
    expect(deriveTitleFromSynthesis(synthesis)).toBeNull();
  });
});

// =============================================================================
// formatSynthesisAsDocument
// =============================================================================

describe("formatSynthesisAsDocument", () => {
  test("formats complete synthesis as knowledge article", () => {
    const synthesis: Synthesis = {
      summary: "Set up authentication with JWT tokens.",
      changes: "- Created `src/auth/middleware.ts`\n- Created `src/auth/login.ts`",
      decisions: "Chose RS256 over HS256 for asymmetric verification.",
      insights: "Bun natively supports JWT signing via its crypto module.",
      context: "API had no authentication previously.",
    };

    const doc = formatSynthesisAsDocument("JWT Authentication Setup", synthesis);

    expect(doc).toContain("# JWT Authentication Setup");
    expect(doc).toContain("> Set up authentication with JWT tokens.");
    expect(doc).toContain("## Changes");
    expect(doc).toContain("src/auth/middleware.ts");
    expect(doc).toContain("## Decisions");
    expect(doc).toContain("RS256");
    expect(doc).toContain("## Insights");
    expect(doc).toContain("crypto module");
    expect(doc).toContain("## Context");
    expect(doc).toContain("no authentication");
  });

  test("omits empty sections", () => {
    const synthesis: Synthesis = {
      summary: "Quick fix for a typo.",
      changes: "- Fixed typo in `README.md`",
      decisions: "",
      insights: "",
      context: "",
    };

    const doc = formatSynthesisAsDocument("Typo Fix", synthesis);

    expect(doc).toContain("# Typo Fix");
    expect(doc).toContain("## Changes");
    expect(doc).not.toContain("## Decisions");
    expect(doc).not.toContain("## Insights");
    expect(doc).not.toContain("## Context");
  });
});

// =============================================================================
// loadPromptTemplate
// =============================================================================

describe("loadPromptTemplate", () => {
  test("loads built-in default template", async () => {
    const template = await loadPromptTemplate();

    expect(template).toContain("{{conversation}}");
    expect(template).toContain("### Summary");
    expect(template).toContain("### Changes");
    expect(template).toContain("### Decisions");
    expect(template).toContain("### Insights");
    expect(template).toContain("### Context");
  });

  test("falls back to default when project dir doesn't have override", async () => {
    const template = await loadPromptTemplate("/nonexistent/path/.smriti");

    expect(template).toContain("{{conversation}}");
    expect(template).toContain("### Summary");
  });
});
