import { test, expect, describe } from "bun:test";
import {
  sanitizeContent,
  shouldDropMessage,
  filterMessages,
  mergeConsecutive,
  deriveTitle,
  formatAsFallbackDocument,
  formatSessionAsFallback,
  isSessionWorthSharing,
} from "../src/team/formatter";

// =============================================================================
// sanitizeContent
// =============================================================================

describe("sanitizeContent", () => {
  test("strips <command-message> tags", () => {
    const input = "<command-message>init</command-message> hello";
    expect(sanitizeContent(input)).toBe("hello");
  });

  test("strips <command-name> tags", () => {
    const input = "<command-name>/init</command-name> world";
    expect(sanitizeContent(input)).toBe("world");
  });

  test("strips <task-notification> blocks", () => {
    const input =
      "before <task-notification>some\nmultiline\ncontent</task-notification> after";
    expect(sanitizeContent(input)).toBe("before  after");
  });

  test("strips <system-reminder> blocks", () => {
    const input =
      "before <system-reminder>reminder\ncontent</system-reminder> after";
    expect(sanitizeContent(input)).toBe("before  after");
  });

  test("strips interrupt markers", () => {
    expect(sanitizeContent("[Request interrupted by user for tool use]")).toBe(
      ""
    );
    expect(sanitizeContent("[Request interrupted by user]")).toBe("");
  });

  test("strips API error lines", () => {
    const input = `Some text\nAPI Error: 400 {"type":"error"}\nMore text`;
    expect(sanitizeContent(input)).toBe("Some text\n\nMore text");
  });

  test("strips tmp path lines", () => {
    const input =
      "Some text\nRead the output file at /private/tmp/abc123.txt\nMore text";
    expect(sanitizeContent(input)).toBe("Some text\n\nMore text");
  });

  test("collapses excessive newlines", () => {
    const input = "line1\n\n\n\n\nline2";
    expect(sanitizeContent(input)).toBe("line1\n\nline2");
  });

  test("preserves clean content untouched", () => {
    const input = "Here is a normal response with `code` and **bold**.";
    expect(sanitizeContent(input)).toBe(input);
  });
});

// =============================================================================
// shouldDropMessage
// =============================================================================

describe("shouldDropMessage", () => {
  test("drops empty content", () => {
    expect(shouldDropMessage("assistant", "")).toBe(true);
    expect(shouldDropMessage("assistant", "   ")).toBe(true);
  });

  test("drops content that is only XML noise", () => {
    expect(
      shouldDropMessage(
        "user",
        "<command-message>init</command-message>\n<command-name>/init</command-name>"
      )
    ).toBe(true);
  });

  test("drops bare commands", () => {
    expect(shouldDropMessage("user", "clear")).toBe(true);
    expect(shouldDropMessage("user", "1")).toBe(true);
    expect(shouldDropMessage("user", "quit")).toBe(true);
  });

  test("drops short assistant narration", () => {
    expect(
      shouldDropMessage("assistant", "Let me read the codebase structure.")
    ).toBe(true);
    expect(
      shouldDropMessage("assistant", "Now let me check a few more details.")
    ).toBe(true);
    expect(
      shouldDropMessage(
        "assistant",
        "I'll start by exploring the codebase structure."
      )
    ).toBe(true);
    expect(
      shouldDropMessage("assistant", "Good, I have all the information I need.")
    ).toBe(true);
    expect(
      shouldDropMessage("assistant", "Standing by for your instructions.")
    ).toBe(true);
  });

  test("keeps long assistant messages even if they start with narration", () => {
    const longMsg =
      "Let me read the codebase. " +
      "Here is a detailed analysis of the architecture including the routing layer, " +
      "authentication middleware, database schema, and deployment configuration. " +
      "The system uses a modular design with clear separation of concerns. " +
      "Each module has its own test suite and documentation.";
    expect(shouldDropMessage("assistant", longMsg)).toBe(false);
  });

  test("keeps substantive user messages", () => {
    expect(
      shouldDropMessage("user", "Implement the following plan:\n\n# Auth Flow")
    ).toBe(false);
  });

  test("drops interrupt-only messages", () => {
    expect(
      shouldDropMessage("user", "[Request interrupted by user for tool use]")
    ).toBe(true);
  });
});

// =============================================================================
// filterMessages
// =============================================================================

describe("filterMessages", () => {
  test("filters out noise and sanitizes remaining", () => {
    const raw = [
      { role: "user", content: "<command-message>init</command-message>" },
      { role: "assistant", content: "" },
      { role: "assistant", content: "Let me read the files." },
      {
        role: "assistant",
        content: "Created CLAUDE.md with project configuration.",
      },
      { role: "user", content: "commit this" },
      {
        role: "assistant",
        content: "Committed successfully as `2bea47e`.",
      },
    ];

    const filtered = filterMessages(raw);

    expect(filtered.length).toBe(3);
    expect(filtered[0]).toEqual({
      role: "assistant",
      content: "Created CLAUDE.md with project configuration.",
    });
    expect(filtered[1]).toEqual({
      role: "user",
      content: "commit this",
    });
    expect(filtered[2]).toEqual({
      role: "assistant",
      content: "Committed successfully as `2bea47e`.",
    });
  });
});

// =============================================================================
// mergeConsecutive
// =============================================================================

describe("mergeConsecutive", () => {
  test("merges consecutive same-role messages", () => {
    const messages = [
      { role: "assistant", content: "Part 1 of the response." },
      { role: "assistant", content: "Part 2 of the response." },
      { role: "user", content: "Thanks" },
    ];

    const merged = mergeConsecutive(messages);

    expect(merged.length).toBe(2);
    expect(merged[0].content).toBe(
      "Part 1 of the response.\n\nPart 2 of the response."
    );
    expect(merged[1].content).toBe("Thanks");
  });

  test("handles empty array", () => {
    expect(mergeConsecutive([])).toEqual([]);
  });

  test("does not merge different roles", () => {
    const messages = [
      { role: "user", content: "question" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "follow up" },
    ];

    expect(mergeConsecutive(messages).length).toBe(3);
  });
});

// =============================================================================
// deriveTitle
// =============================================================================

describe("deriveTitle", () => {
  test("uses session title when clean", () => {
    expect(deriveTitle("Setting up auth", [])).toBe("Setting up auth");
  });

  test("strips XML from session title", () => {
    const title =
      "<command-message>init</command-message> <command-name>/init</command-name>";
    expect(deriveTitle(title, [])).toBe("Untitled Session");
  });

  test("falls back to first user message", () => {
    const messages = [
      { role: "user", content: "Help me set up authentication" },
      { role: "assistant", content: "Sure, let me help." },
    ];
    expect(deriveTitle(null, messages)).toBe(
      "Help me set up authentication"
    );
  });

  test("truncates long first user message", () => {
    const longMsg = "A".repeat(100);
    const messages = [{ role: "user", content: longMsg }];
    const title = deriveTitle(null, messages);
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title.endsWith("...")).toBe(true);
  });

  test("returns Untitled Session as last resort", () => {
    expect(deriveTitle(null, [])).toBe("Untitled Session");
  });

  test("strips heading prefix from session title", () => {
    expect(deriveTitle("# My Session Title", [])).toBe("My Session Title");
  });
});

// =============================================================================
// isSessionWorthSharing
// =============================================================================

describe("isSessionWorthSharing", () => {
  test("returns false for noise-only sessions", () => {
    const raw = [
      { role: "user", content: "clear" },
      { role: "assistant", content: "I'm ready to help!" },
    ];
    expect(isSessionWorthSharing(raw)).toBe(false);
  });

  test("returns false for user-only sessions", () => {
    const raw = [
      { role: "user", content: "Help me with authentication" },
    ];
    expect(isSessionWorthSharing(raw)).toBe(false);
  });

  test("returns false for very short sessions", () => {
    const raw = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    expect(isSessionWorthSharing(raw)).toBe(false);
  });

  test("returns true for substantive sessions", () => {
    const raw = [
      { role: "user", content: "Implement authentication using JWT tokens" },
      {
        role: "assistant",
        content:
          "Created the JWT authentication system with the following components:\n\n" +
          "1. `src/auth/middleware.ts` — validates Bearer tokens on protected routes\n" +
          "2. `src/auth/login.ts` — authenticates credentials and issues tokens\n" +
          "3. `src/auth/register.ts` — creates new user accounts with hashed passwords\n" +
          "4. `src/auth/refresh.ts` — rotates expired tokens using refresh tokens",
      },
    ];
    expect(isSessionWorthSharing(raw)).toBe(true);
  });
});

// =============================================================================
// formatAsFallbackDocument
// =============================================================================

describe("formatAsFallbackDocument", () => {
  test("formats with title, summary, and messages", () => {
    const doc = formatAsFallbackDocument(
      "Auth Setup",
      "Set up JWT authentication",
      [
        { role: "user", content: "Add JWT auth" },
        {
          role: "assistant",
          content: "Created auth middleware with token validation.",
        },
      ]
    );

    expect(doc).toContain("# Auth Setup");
    expect(doc).toContain("> Set up JWT authentication");
    expect(doc).toContain("## Add JWT auth");
    expect(doc).toContain("Created auth middleware with token validation.");
  });

  test("formats without summary", () => {
    const doc = formatAsFallbackDocument("Title", null, [
      { role: "user", content: "question" },
      { role: "assistant", content: "answer" },
    ]);

    expect(doc).not.toContain(">");
    expect(doc).toContain("# Title");
  });

  test("preserves code blocks", () => {
    const doc = formatAsFallbackDocument("Code", null, [
      { role: "user", content: "Show me code" },
      {
        role: "assistant",
        content: "Here:\n\n```ts\nconst x = 1;\n```",
      },
    ]);

    expect(doc).toContain("```ts\nconst x = 1;\n```");
  });
});

// =============================================================================
// formatSessionAsFallback (integration)
// =============================================================================

describe("formatSessionAsFallback", () => {
  test("full pipeline with realistic noisy input", () => {
    const rawMessages = [
      {
        role: "user",
        content:
          '<command-message>init</command-message>\n<command-name>/init</command-name>',
      },
      { role: "assistant", content: "" },
      {
        role: "assistant",
        content: "Now let me read a few more key files to ensure accuracy.",
      },
      {
        role: "assistant",
        content:
          "Created `CLAUDE.md` at the project root. It covers:\n\n" +
          "- **Commands** for dev, build, lint, format, and database setup\n" +
          "- **Architecture** including the App Router layout groups\n" +
          "- **Commit conventions** enforced by commitlint/husky",
      },
      { role: "user", content: "commit this" },
      {
        role: "assistant",
        content:
          'Committed successfully as `2bea47e` — `docs(config): add CLAUDE.md for Claude Code context`.',
      },
    ];

    const { title, body } = formatSessionAsFallback(
      '<command-message>init</command-message> <command-name>/init</command-name>',
      null,
      rawMessages
    );

    // Title should be clean
    expect(title).not.toContain("<command-message>");

    // Body should be clean
    expect(body).not.toContain("<command-message>");
    expect(body).not.toContain("**user**:");
    expect(body).not.toContain("**assistant**:");
    expect(body).not.toContain("Now let me read");

    // Should contain substantive content
    expect(body).toContain("CLAUDE.md");
    expect(body).toContain("Committed successfully");
  });
});
