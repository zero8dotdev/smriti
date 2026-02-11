import { test, expect } from "bun:test";
import {
  extractBlocks,
  flattenBlocksToText,
  toolCallToBlocks,
  parseToolResult,
  isGitCommand,
  parseGitCommand,
  parseGhPrCommand,
  systemEntryToBlock,
} from "../src/ingest/blocks";

// =============================================================================
// extractBlocks
// =============================================================================

test("extractBlocks handles plain string content", () => {
  const blocks = extractBlocks("Hello world");
  expect(blocks.length).toBe(1);
  expect(blocks[0].type).toBe("text");
  if (blocks[0].type === "text") {
    expect(blocks[0].text).toBe("Hello world");
  }
});

test("extractBlocks handles empty string", () => {
  const blocks = extractBlocks("");
  expect(blocks.length).toBe(0);
});

test("extractBlocks handles text content blocks", () => {
  const blocks = extractBlocks([
    { type: "text", text: "First paragraph" },
    { type: "text", text: "Second paragraph" },
  ]);
  expect(blocks.length).toBe(2);
  expect(blocks[0].type).toBe("text");
  expect(blocks[1].type).toBe("text");
});

test("extractBlocks handles thinking blocks", () => {
  const blocks = extractBlocks([
    { type: "thinking", thinking: "Let me think about this..." },
  ]);
  expect(blocks.length).toBe(1);
  expect(blocks[0].type).toBe("thinking");
  if (blocks[0].type === "thinking") {
    expect(blocks[0].thinking).toBe("Let me think about this...");
  }
});

test("extractBlocks handles tool_use blocks", () => {
  const blocks = extractBlocks([
    {
      type: "tool_use",
      id: "tool_123",
      name: "Read",
      input: { file_path: "/src/index.ts" },
    },
  ]);
  // tool_use → [ToolCallBlock, FileOperationBlock]
  expect(blocks.length).toBe(2);
  expect(blocks[0].type).toBe("tool_call");
  expect(blocks[1].type).toBe("file_op");
  if (blocks[1].type === "file_op") {
    expect(blocks[1].operation).toBe("read");
    expect(blocks[1].path).toBe("/src/index.ts");
  }
});

test("extractBlocks handles tool_result blocks", () => {
  const blocks = extractBlocks([
    {
      type: "tool_result",
      tool_use_id: "tool_123",
      content: "File contents here",
    },
  ]);
  expect(blocks.length).toBe(1);
  expect(blocks[0].type).toBe("tool_result");
  if (blocks[0].type === "tool_result") {
    expect(blocks[0].toolId).toBe("tool_123");
    expect(blocks[0].success).toBe(true);
    expect(blocks[0].output).toBe("File contents here");
  }
});

test("extractBlocks handles image blocks", () => {
  const blocks = extractBlocks([
    {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "abc123" },
    },
  ]);
  expect(blocks.length).toBe(1);
  expect(blocks[0].type).toBe("image");
  if (blocks[0].type === "image") {
    expect(blocks[0].mediaType).toBe("image/png");
    expect(blocks[0].dataHash).toBeDefined();
  }
});

test("extractBlocks handles mixed content blocks", () => {
  const blocks = extractBlocks([
    { type: "text", text: "I'll read the file" },
    {
      type: "tool_use",
      id: "tool_1",
      name: "Read",
      input: { file_path: "/src/main.ts" },
    },
    { type: "text", text: "Here's what I found" },
  ]);
  // text + [tool_call, file_op] + text = 4 blocks
  expect(blocks.length).toBe(4);
  expect(blocks[0].type).toBe("text");
  expect(blocks[1].type).toBe("tool_call");
  expect(blocks[2].type).toBe("file_op");
  expect(blocks[3].type).toBe("text");
});

// =============================================================================
// toolCallToBlocks — domain mapping
// =============================================================================

test("toolCallToBlocks maps Read to file_op", () => {
  const blocks = toolCallToBlocks("Read", "t1", { file_path: "/src/app.ts" });
  expect(blocks.length).toBe(2);
  expect(blocks[0].type).toBe("tool_call");
  expect(blocks[1].type).toBe("file_op");
  if (blocks[1].type === "file_op") {
    expect(blocks[1].operation).toBe("read");
    expect(blocks[1].path).toBe("/src/app.ts");
  }
});

test("toolCallToBlocks maps Write to file_op", () => {
  const blocks = toolCallToBlocks("Write", "t2", {
    file_path: "/src/new.ts",
    content: "export const x = 1;",
  });
  expect(blocks.length).toBe(2);
  expect(blocks[1].type).toBe("file_op");
  if (blocks[1].type === "file_op") {
    expect(blocks[1].operation).toBe("write");
    expect(blocks[1].path).toBe("/src/new.ts");
  }
});

test("toolCallToBlocks maps Edit to file_op with diff", () => {
  const blocks = toolCallToBlocks("Edit", "t3", {
    file_path: "/src/config.ts",
    old_string: "const x = 1",
    new_string: "const x = 2",
  });
  expect(blocks.length).toBe(2);
  if (blocks[1].type === "file_op") {
    expect(blocks[1].operation).toBe("edit");
    expect(blocks[1].diff).toContain("const x = 1");
    expect(blocks[1].diff).toContain("const x = 2");
  }
});

test("toolCallToBlocks maps Glob to file_op + search", () => {
  const blocks = toolCallToBlocks("Glob", "t4", {
    pattern: "**/*.ts",
    path: "/src",
  });
  expect(blocks.length).toBe(3); // tool_call + file_op + search
  expect(blocks[1].type).toBe("file_op");
  expect(blocks[2].type).toBe("search");
  if (blocks[2].type === "search") {
    expect(blocks[2].searchType).toBe("glob");
    expect(blocks[2].pattern).toBe("**/*.ts");
  }
});

test("toolCallToBlocks maps Grep to search", () => {
  const blocks = toolCallToBlocks("Grep", "t5", {
    pattern: "function\\s+main",
    path: "/src",
  });
  expect(blocks.length).toBe(2); // tool_call + search
  expect(blocks[1].type).toBe("search");
  if (blocks[1].type === "search") {
    expect(blocks[1].searchType).toBe("grep");
    expect(blocks[1].pattern).toBe("function\\s+main");
  }
});

test("toolCallToBlocks maps Bash to command", () => {
  const blocks = toolCallToBlocks("Bash", "t6", {
    command: "bun test",
    description: "Run tests",
  });
  expect(blocks.length).toBe(2); // tool_call + command
  expect(blocks[1].type).toBe("command");
  if (blocks[1].type === "command") {
    expect(blocks[1].command).toBe("bun test");
    expect(blocks[1].isGit).toBe(false);
    expect(blocks[1].description).toBe("Run tests");
  }
});

test("toolCallToBlocks maps Bash git command to command + git", () => {
  const blocks = toolCallToBlocks("Bash", "t7", {
    command: 'git commit -m "Fix bug"',
  });
  expect(blocks.length).toBe(3); // tool_call + command + git
  expect(blocks[1].type).toBe("command");
  expect(blocks[2].type).toBe("git");
  if (blocks[1].type === "command") {
    expect(blocks[1].isGit).toBe(true);
  }
  if (blocks[2].type === "git") {
    expect(blocks[2].operation).toBe("commit");
    expect(blocks[2].message).toBe("Fix bug");
  }
});

test("toolCallToBlocks maps WebFetch to search", () => {
  const blocks = toolCallToBlocks("WebFetch", "t8", {
    url: "https://example.com",
    prompt: "Extract the main content",
  });
  expect(blocks.length).toBe(2);
  expect(blocks[1].type).toBe("search");
  if (blocks[1].type === "search") {
    expect(blocks[1].searchType).toBe("web_fetch");
    expect(blocks[1].url).toBe("https://example.com");
  }
});

test("toolCallToBlocks maps WebSearch to search", () => {
  const blocks = toolCallToBlocks("WebSearch", "t9", {
    query: "bun testing guide",
  });
  expect(blocks.length).toBe(2);
  expect(blocks[1].type).toBe("search");
  if (blocks[1].type === "search") {
    expect(blocks[1].searchType).toBe("web_search");
    expect(blocks[1].pattern).toBe("bun testing guide");
  }
});

test("toolCallToBlocks maps EnterPlanMode to control", () => {
  const blocks = toolCallToBlocks("EnterPlanMode", "t10", {});
  expect(blocks.length).toBe(2);
  expect(blocks[1].type).toBe("control");
  if (blocks[1].type === "control") {
    expect(blocks[1].controlType).toBe("plan_enter");
  }
});

test("toolCallToBlocks maps Skill to control with command", () => {
  const blocks = toolCallToBlocks("Skill", "t11", { skill: "commit" });
  expect(blocks.length).toBe(2);
  expect(blocks[1].type).toBe("control");
  if (blocks[1].type === "control") {
    expect(blocks[1].controlType).toBe("slash_command");
    expect(blocks[1].command).toBe("commit");
  }
});

test("toolCallToBlocks keeps unknown tools as generic tool_call only", () => {
  const blocks = toolCallToBlocks("TaskCreate", "t12", { subject: "Do stuff" });
  expect(blocks.length).toBe(1);
  expect(blocks[0].type).toBe("tool_call");
});

// =============================================================================
// Git command detection
// =============================================================================

test("isGitCommand detects git commands", () => {
  expect(isGitCommand("git status")).toBe(true);
  expect(isGitCommand("  git diff")).toBe(true);
  expect(isGitCommand("bun test")).toBe(false);
  expect(isGitCommand("github-cli")).toBe(false);
});

test("parseGitCommand extracts commit message with single quotes", () => {
  const block = parseGitCommand("git commit -m 'Add feature'");
  expect(block).not.toBeNull();
  expect(block!.operation).toBe("commit");
  expect(block!.message).toBe("Add feature");
});

test("parseGitCommand extracts commit message with double quotes", () => {
  const block = parseGitCommand('git commit -m "Fix bug"');
  expect(block).not.toBeNull();
  expect(block!.message).toBe("Fix bug");
});

test("parseGitCommand extracts checkout branch", () => {
  const block = parseGitCommand("git checkout feature/auth");
  expect(block).not.toBeNull();
  expect(block!.operation).toBe("checkout");
  expect(block!.branch).toBe("feature/auth");
});

test("parseGitCommand handles push with remote and branch", () => {
  const block = parseGitCommand("git push origin main");
  expect(block).not.toBeNull();
  expect(block!.operation).toBe("push");
  expect(block!.branch).toBe("main");
});

test("parseGitCommand maps unknown subcommands to other", () => {
  const block = parseGitCommand("git stash pop");
  expect(block).not.toBeNull();
  expect(block!.operation).toBe("other");
});

test("parseGitCommand returns null for non-git commands", () => {
  expect(parseGitCommand("bun test")).toBeNull();
});

test("parseGhPrCommand detects gh pr create", () => {
  const block = parseGhPrCommand('gh pr create --title "My PR" --body "desc"');
  expect(block).not.toBeNull();
  expect(block!.operation).toBe("pr_create");
  expect(block!.message).toBe("My PR");
});

test("parseGhPrCommand returns null for non-pr commands", () => {
  expect(parseGhPrCommand("gh issue list")).toBeNull();
});

// =============================================================================
// parseToolResult
// =============================================================================

test("parseToolResult handles string content", () => {
  const result = parseToolResult("t1", "File contents here");
  expect(result.type).toBe("tool_result");
  expect(result.toolId).toBe("t1");
  expect(result.success).toBe(true);
  expect(result.output).toBe("File contents here");
});

test("parseToolResult handles array content", () => {
  const result = parseToolResult("t2", [
    { type: "text", text: "Line 1" },
    { type: "text", text: "Line 2" },
  ]);
  expect(result.output).toBe("Line 1\nLine 2");
});

test("parseToolResult handles error flag", () => {
  const result = parseToolResult("t3", "Permission denied", true);
  expect(result.success).toBe(false);
  expect(result.error).toBe("Permission denied");
});

test("parseToolResult truncates long output", () => {
  const longOutput = "x".repeat(5000);
  const result = parseToolResult("t4", longOutput);
  expect(result.output.length).toBeLessThan(5000);
  expect(result.output).toContain("...[truncated]");
});

// =============================================================================
// flattenBlocksToText
// =============================================================================

test("flattenBlocksToText includes text blocks", () => {
  const text = flattenBlocksToText([
    { type: "text", text: "Hello" },
    { type: "text", text: "World" },
  ]);
  expect(text).toBe("Hello\nWorld");
});

test("flattenBlocksToText includes command descriptions and commands", () => {
  const text = flattenBlocksToText([
    {
      type: "command",
      command: "bun test",
      description: "Run tests",
      isGit: false,
    },
  ]);
  expect(text).toContain("Run tests");
  expect(text).toContain("$ bun test");
});

test("flattenBlocksToText includes file operations", () => {
  const text = flattenBlocksToText([
    { type: "file_op", operation: "write", path: "/src/new.ts" },
  ]);
  expect(text).toContain("[write] /src/new.ts");
});

test("flattenBlocksToText includes search blocks", () => {
  const text = flattenBlocksToText([
    { type: "search", searchType: "grep", pattern: "TODO", path: "/src" },
  ]);
  expect(text).toContain("[grep] TODO");
});

test("flattenBlocksToText includes git blocks", () => {
  const text = flattenBlocksToText([
    { type: "git", operation: "commit", message: "Fix the bug" },
  ]);
  expect(text).toContain("[git commit] Fix the bug");
});

test("flattenBlocksToText excludes thinking and tool_result", () => {
  const text = flattenBlocksToText([
    { type: "thinking", thinking: "secret thoughts" },
    { type: "tool_result", toolId: "t1", success: true, output: "verbose output" },
    { type: "text", text: "visible" },
  ]);
  expect(text).toBe("visible");
  expect(text).not.toContain("secret thoughts");
  expect(text).not.toContain("verbose output");
});

test("flattenBlocksToText includes tool_call descriptions", () => {
  const text = flattenBlocksToText([
    {
      type: "tool_call",
      toolId: "t1",
      toolName: "Bash",
      input: {},
      description: "Run the build",
    },
  ]);
  expect(text).toContain("Run the build");
});

// =============================================================================
// systemEntryToBlock
// =============================================================================

test("systemEntryToBlock maps turn_duration", () => {
  const block = systemEntryToBlock("turn_duration", { durationMs: 5000 });
  expect(block.type).toBe("system_event");
  expect(block.eventType).toBe("turn_duration");
  expect(block.data.durationMs).toBe(5000);
});

test("systemEntryToBlock maps pr-link", () => {
  const block = systemEntryToBlock("pr-link", {
    prNumber: 42,
    prUrl: "https://github.com/org/repo/pull/42",
  });
  expect(block.eventType).toBe("pr_link");
  expect(block.data.prNumber).toBe(42);
});
