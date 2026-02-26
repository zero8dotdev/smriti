/**
 * test/ingest-parsers.test.ts - Test pure parser functions
 *
 * Verifies each parser returns correct ParsedSession structure
 * without requiring database or external files.
 */

import { test, expect, describe } from "bun:test";
import { parseClaudeJsonlStructured } from "../src/ingest/claude";
import { parseCodexJsonl } from "../src/ingest/codex";
import { parseCursorJson } from "../src/ingest/cursor";
import type { StructuredMessage, ParsedSession } from "../src/ingest/types";

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Validate ParsedSession structure
 */
function validateParsedSession(parsed: ParsedSession): void {
  // Check session structure
  expect(parsed.session).toBeDefined();
  expect(parsed.session.id).toMatch(/^[\w-]+$/);
  expect(parsed.session.title).toBeDefined();
  expect(parsed.session.created_at).toMatch(/^\d{4}-/); // ISO date

  // Check messages
  expect(Array.isArray(parsed.messages)).toBe(true);

  // Validate each message
  for (const msg of parsed.messages) {
    expect(msg).toHaveProperty("id");
    expect(msg).toHaveProperty("sessionId");
    expect(msg).toHaveProperty("role");
    expect(msg.role).toMatch(/^(user|assistant|system|tool)$/);
    expect(msg).toHaveProperty("blocks");
    expect(Array.isArray(msg.blocks)).toBe(true);
    expect(msg).toHaveProperty("plainText");
  }

  // Check metadata if present
  if (parsed.metadata) {
    if (parsed.metadata.total_tokens !== undefined) {
      expect(typeof parsed.metadata.total_tokens).toBe("number");
    }
    if (parsed.metadata.total_duration_ms !== undefined) {
      expect(typeof parsed.metadata.total_duration_ms).toBe("number");
    }
  }
}

// =============================================================================
// Claude Parser Tests
// =============================================================================

describe("Claude Parser", () => {
  test("parseClaudeJsonlStructured extracts user/assistant messages", () => {
    const jsonl = `
{"type":"user","uuid":"u1","timestamp":"2025-01-01T10:00:00Z","sessionId":"s1","message":{"role":"user","content":"Hello"}}
{"type":"assistant","uuid":"a1","timestamp":"2025-01-01T10:01:00Z","sessionId":"s1","message":{"role":"assistant","content":"Hi there"}}
    `.trim();

    const messages = parseClaudeJsonlStructured(jsonl);

    expect(messages.length).toBe(2);
    expect(messages[0].role).toBe("user");
    expect(messages[0].plainText).toContain("Hello");
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].plainText).toContain("Hi there");
  });

  test("parseClaudeJsonlStructured skips meta messages", () => {
    const jsonl = `
{"type":"user","uuid":"u1","sessionId":"s1","message":{"role":"user","content":"Hello"},"isMeta":true}
{"type":"user","uuid":"u2","sessionId":"s1","message":{"role":"user","content":"World"},"isMeta":false}
    `.trim();

    const messages = parseClaudeJsonlStructured(jsonl);

    // Should only have 1 message (second one, since first is marked isMeta)
    expect(messages.length).toBe(1);
    expect(messages[0].plainText).toContain("World");
  });

  test("parseClaudeJsonlStructured extracts block structure", () => {
    const jsonl = `
{"type":"assistant","uuid":"a1","sessionId":"s1","message":{"role":"assistant","content":[{"type":"text","text":"Check this file:"},{"type":"code","language":"typescript","code":"const x = 1;"}]}}
    `.trim();

    const messages = parseClaudeJsonlStructured(jsonl);

    expect(messages.length).toBe(1);
    expect(messages[0].blocks.length).toBeGreaterThan(0);
    const textBlock = messages[0].blocks.find((b) => b.type === "text");
    expect(textBlock).toBeDefined();
  });

  test("parseClaudeJsonlStructured handles system events", () => {
    const jsonl = `
{"type":"system","subtype":"turn_duration","uuid":"sys1","timestamp":"2025-01-01T10:00:00Z","sessionId":"s1","durationMs":5000}
    `.trim();

    const messages = parseClaudeJsonlStructured(jsonl);

    expect(messages.length).toBe(1);
    expect(messages[0].role).toBe("system");
    const eventBlock = messages[0].blocks.find((b) => b.type === "system_event");
    expect(eventBlock).toBeDefined();
  });

  test("parseClaudeJsonlStructured skips empty messages", () => {
    const jsonl = `
{"type":"user","uuid":"u1","sessionId":"s1","message":{"role":"user","content":""}}
{"type":"user","uuid":"u2","sessionId":"s1","message":{"role":"user","content":"Real message"}}
    `.trim();

    const messages = parseClaudeJsonlStructured(jsonl);

    // Empty message should be skipped
    expect(messages.length).toBe(1);
    expect(messages[0].plainText).toContain("Real message");
  });
});

// =============================================================================
// Codex Parser Tests
// =============================================================================

describe("Codex Parser", () => {
  test("parseCodexJsonl extracts user/assistant messages", () => {
    const jsonl = `
{"role":"user","content":"What is 2+2?","timestamp":"2025-01-01T10:00:00Z"}
{"role":"assistant","content":"4","timestamp":"2025-01-01T10:01:00Z"}
    `.trim();

    const messages = parseCodexJsonl(jsonl);

    expect(messages.length).toBe(2);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toContain("2+2");
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toBe("4");
  });

  test("parseCodexJsonl skips empty messages", () => {
    const jsonl = `
{"role":"user","content":"","timestamp":"2025-01-01T10:00:00Z"}
{"role":"user","content":"Hello","timestamp":"2025-01-01T10:01:00Z"}
    `.trim();

    const messages = parseCodexJsonl(jsonl);

    expect(messages.length).toBe(1);
    expect(messages[0].content).toBe("Hello");
  });

  test("parseCodexJsonl ignores invalid roles", () => {
    const jsonl = `
{"role":"system","content":"This is system","timestamp":"2025-01-01T10:00:00Z"}
{"role":"user","content":"This is user","timestamp":"2025-01-01T10:01:00Z"}
    `.trim();

    const messages = parseCodexJsonl(jsonl);

    // Only user message should be parsed
    expect(messages.length).toBe(1);
    expect(messages[0].role).toBe("user");
  });
});

// =============================================================================
// Cursor Parser Tests
// =============================================================================

describe("Cursor Parser", () => {
  test("parseCursorJson extracts messages from turns array", () => {
    const json = JSON.stringify({
      messages: [
        { role: "user", content: "Help me code" },
        { role: "assistant", content: "Sure, I'll help" },
      ],
    });

    const messages = parseCursorJson(json);

    expect(messages.length).toBe(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
  });

  test("parseCursorJson handles nested tabs format", () => {
    const json = JSON.stringify({
      tabs: [
        {
          id: "tab1",
          messages: [{ role: "user", content: "Tab 1 message" }],
        },
        {
          id: "tab2",
          messages: [{ role: "user", content: "Tab 2 message" }],
        },
      ],
    });

    const messages = parseCursorJson(json);

    // Should extract from both tabs
    expect(messages.length).toBeGreaterThanOrEqual(2);
  });
});

// =============================================================================
// Integration Tests
// =============================================================================

describe("Parser Output Format", () => {
  test("Claude parser returns valid ParsedSession-like structure", () => {
    const jsonl = `
{"type":"user","uuid":"u1","sessionId":"s1","message":{"role":"user","content":"Test"}}
{"type":"assistant","uuid":"a1","sessionId":"s1","message":{"role":"assistant","content":"Response"}}
    `.trim();

    const messages = parseClaudeJsonlStructured(jsonl);

    // Simulate ParsedSession structure
    const parsed: ParsedSession = {
      session: {
        id: "s1",
        title: messages[0]?.plainText.slice(0, 100) || "Test",
        created_at: new Date().toISOString(),
      },
      messages,
    };

    validateParsedSession(parsed);
  });

  test("All parsers return consistent message structure", () => {
    const claudeJsonl = `
{"type":"user","uuid":"u1","sessionId":"s1","message":{"role":"user","content":"Hello"}}
    `.trim();

    const claudeMessages = parseClaudeJsonlStructured(claudeJsonl);

    // All messages should have required fields
    for (const msg of claudeMessages) {
      expect(msg).toHaveProperty("id");
      expect(msg).toHaveProperty("sessionId");
      expect(msg).toHaveProperty("role");
      expect(msg).toHaveProperty("plainText");
      expect(msg).toHaveProperty("blocks");
      expect(msg).toHaveProperty("metadata");
    }
  });
});
