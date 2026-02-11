/**
 * blocks.ts - Tool call → structured block extraction
 *
 * Maps raw Claude Code content blocks (tool_use, text, thinking) into
 * domain-specific MessageBlock types. Also parses git commands from Bash.
 */

import type {
  MessageBlock,
  TextBlock,
  ThinkingBlock,
  ToolCallBlock,
  ToolResultBlock,
  FileOperationBlock,
  CommandBlock,
  SearchBlock,
  GitBlock,
  ErrorBlock,
  ImageBlock,
  ConversationControlBlock,
  SystemEventBlock,
  STORAGE_LIMITS as StorageLimitsType,
} from "./types";
import { STORAGE_LIMITS } from "./types";

// =============================================================================
// Raw content block shape (from Claude API / JSONL)
// =============================================================================

export type RawContentBlock = {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: Record<string, any>;
  tool_use_id?: string;
  content?: string | RawContentBlock[];
  source?: { type: string; media_type: string; data: string };
};

// =============================================================================
// Truncation helper
// =============================================================================

function truncate(s: string | undefined, limit: number): string {
  if (!s) return "";
  return s.length > limit ? s.slice(0, limit) + "...[truncated]" : s;
}

// =============================================================================
// Git command detection & parsing
// =============================================================================

const GIT_COMMAND_RE = /^\s*git\s+/;
const GIT_OP_MAP: Record<string, GitBlock["operation"]> = {
  commit: "commit",
  push: "push",
  pull: "pull",
  branch: "branch",
  checkout: "checkout",
  switch: "checkout",
  diff: "diff",
  merge: "merge",
  rebase: "rebase",
  status: "status",
};

export function isGitCommand(command: string): boolean {
  return GIT_COMMAND_RE.test(command);
}

export function parseGitCommand(command: string): GitBlock | null {
  if (!isGitCommand(command)) return null;

  // Extract the git subcommand
  const match = command.match(/^\s*git\s+(\S+)/);
  if (!match) return null;

  const subcommand = match[1];
  const operation = GIT_OP_MAP[subcommand] || "other";

  const block: GitBlock = {
    type: "git",
    operation,
  };

  // Parse commit message
  if (operation === "commit") {
    const msgMatch = command.match(/-m\s+["']([^"']+)["']/);
    if (!msgMatch) {
      // Try heredoc style: -m "$(cat <<'EOF'\n...\nEOF\n)"
      const heredocMatch = command.match(/-m\s+"\$\(cat\s+<<'?EOF'?\n([\s\S]*?)\nEOF/);
      if (heredocMatch) block.message = heredocMatch[1].trim();
    } else {
      block.message = msgMatch[1];
    }
  }

  // Parse branch from checkout/switch
  if (operation === "checkout" || operation === "branch") {
    const parts = command.trim().split(/\s+/);
    const lastPart = parts[parts.length - 1];
    if (lastPart && lastPart !== subcommand && !lastPart.startsWith("-")) {
      block.branch = lastPart;
    }
  }

  // Parse push branch
  if (operation === "push") {
    const pushMatch = command.match(/push\s+\S+\s+(\S+)/);
    if (pushMatch) block.branch = pushMatch[1];
  }

  return block;
}

/**
 * Detect gh pr create commands and extract PR info.
 */
export function parseGhPrCommand(command: string): GitBlock | null {
  if (!command.match(/^\s*gh\s+pr\s+create/)) return null;

  const block: GitBlock = {
    type: "git",
    operation: "pr_create",
  };

  const titleMatch = command.match(/--title\s+["']([^"']+)["']/);
  if (titleMatch) block.message = titleMatch[1];

  return block;
}

// =============================================================================
// Tool call → domain-specific blocks
// =============================================================================

/**
 * Convert a tool_use content block into one or more domain-specific blocks.
 * The raw ToolCallBlock is always included; domain blocks are added alongside.
 */
export function toolCallToBlocks(
  toolName: string,
  toolId: string,
  input: Record<string, any>,
  description?: string
): MessageBlock[] {
  const blocks: MessageBlock[] = [];

  // Always emit the generic tool call block
  const toolCall: ToolCallBlock = {
    type: "tool_call",
    toolId,
    toolName,
    input: truncateInputFields(input),
    description,
  };
  blocks.push(toolCall);

  // Then emit domain-specific blocks
  switch (toolName) {
    case "Read": {
      const fileOp: FileOperationBlock = {
        type: "file_op",
        operation: "read",
        path: input.file_path || "",
      };
      blocks.push(fileOp);
      break;
    }
    case "Write": {
      const fileOp: FileOperationBlock = {
        type: "file_op",
        operation: "write",
        path: input.file_path || "",
      };
      blocks.push(fileOp);
      break;
    }
    case "Edit": {
      const fileOp: FileOperationBlock = {
        type: "file_op",
        operation: "edit",
        path: input.file_path || "",
        diff: input.old_string && input.new_string
          ? `- ${truncate(input.old_string, 500)}\n+ ${truncate(input.new_string, 500)}`
          : undefined,
      };
      blocks.push(fileOp);
      break;
    }
    case "NotebookEdit": {
      const fileOp: FileOperationBlock = {
        type: "file_op",
        operation: "edit",
        path: input.notebook_path || "",
      };
      blocks.push(fileOp);
      break;
    }
    case "Glob": {
      const fileOp: FileOperationBlock = {
        type: "file_op",
        operation: "glob",
        path: input.path || "",
        pattern: input.pattern,
      };
      blocks.push(fileOp);
      const search: SearchBlock = {
        type: "search",
        searchType: "glob",
        pattern: input.pattern || "",
        path: input.path,
      };
      blocks.push(search);
      break;
    }
    case "Grep": {
      const search: SearchBlock = {
        type: "search",
        searchType: "grep",
        pattern: input.pattern || "",
        path: input.path,
      };
      blocks.push(search);
      break;
    }
    case "Bash": {
      const command = input.command || "";
      const cmdBlock: CommandBlock = {
        type: "command",
        command,
        cwd: input.cwd,
        description: input.description,
        isGit: isGitCommand(command),
      };
      blocks.push(cmdBlock);

      // Also parse git operations
      const gitBlock = parseGitCommand(command) || parseGhPrCommand(command);
      if (gitBlock) blocks.push(gitBlock);
      break;
    }
    case "WebFetch": {
      const search: SearchBlock = {
        type: "search",
        searchType: "web_fetch",
        pattern: input.prompt || "",
        url: input.url,
      };
      blocks.push(search);
      break;
    }
    case "WebSearch": {
      const search: SearchBlock = {
        type: "search",
        searchType: "web_search",
        pattern: input.query || "",
      };
      blocks.push(search);
      break;
    }
    case "EnterPlanMode": {
      const ctrl: ConversationControlBlock = {
        type: "control",
        controlType: "plan_enter",
      };
      blocks.push(ctrl);
      break;
    }
    case "ExitPlanMode": {
      const ctrl: ConversationControlBlock = {
        type: "control",
        controlType: "plan_exit",
      };
      blocks.push(ctrl);
      break;
    }
    case "Skill": {
      const ctrl: ConversationControlBlock = {
        type: "control",
        controlType: "slash_command",
        command: input.skill,
      };
      blocks.push(ctrl);
      break;
    }
    // Task, TaskCreate, TaskList, TaskOutput, TaskUpdate, TodoWrite,
    // AskUserQuestion, KillShell — kept as generic ToolCallBlock only
  }

  return blocks;
}

/**
 * Parse a tool_result content block into a ToolResultBlock.
 */
export function parseToolResult(
  toolUseId: string,
  content: string | RawContentBlock[] | undefined,
  isError?: boolean
): ToolResultBlock {
  let output = "";

  if (typeof content === "string") {
    output = content;
  } else if (Array.isArray(content)) {
    output = content
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text!)
      .join("\n");
  }

  return {
    type: "tool_result",
    toolId: toolUseId,
    success: !isError,
    output: truncate(output, STORAGE_LIMITS.commandOutput),
    error: isError ? truncate(output, STORAGE_LIMITS.commandOutput) : undefined,
  };
}

// =============================================================================
// Content block → MessageBlock conversion
// =============================================================================

/**
 * Convert a raw content block (from Claude API format) into MessageBlock(s).
 */
export function rawBlockToMessageBlocks(raw: RawContentBlock): MessageBlock[] {
  switch (raw.type) {
    case "text":
      return [
        {
          type: "text",
          text: truncate(raw.text, STORAGE_LIMITS.textBlock),
        } as TextBlock,
      ];

    case "thinking":
      return [
        {
          type: "thinking",
          thinking: truncate(raw.thinking, STORAGE_LIMITS.thinkingBlock),
        } as ThinkingBlock,
      ];

    case "tool_use":
      return toolCallToBlocks(
        raw.name || "unknown",
        raw.id || "",
        raw.input || {},
        raw.input?.description
      );

    case "tool_result":
      return [
        parseToolResult(
          raw.tool_use_id || "",
          raw.content,
          false
        ),
      ];

    case "image":
      return [
        {
          type: "image",
          mediaType: raw.source?.media_type || "image/png",
          dataHash: raw.source?.data
            ? hashQuick(raw.source.data)
            : undefined,
        } as ImageBlock,
      ];

    default:
      // Unknown block type — wrap as text if there's content
      if (raw.text) {
        return [{ type: "text", text: raw.text } as TextBlock];
      }
      return [];
  }
}

/**
 * Convert an array of raw content blocks into MessageBlock[].
 */
export function extractBlocks(
  content: string | RawContentBlock[]
): MessageBlock[] {
  if (typeof content === "string") {
    if (!content.trim()) return [];
    return [{ type: "text", text: truncate(content, STORAGE_LIMITS.textBlock) } as TextBlock];
  }

  if (!Array.isArray(content)) return [];

  const blocks: MessageBlock[] = [];
  for (const raw of content) {
    blocks.push(...rawBlockToMessageBlocks(raw));
  }
  return blocks;
}

/**
 * Flatten MessageBlock[] into plain text for backward-compatible FTS indexing.
 */
export function flattenBlocksToText(blocks: MessageBlock[]): string {
  const parts: string[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case "text":
        parts.push(block.text);
        break;
      case "command":
        if (block.description) parts.push(block.description);
        parts.push(`$ ${block.command}`);
        break;
      case "file_op":
        parts.push(`[${block.operation}] ${block.path}`);
        break;
      case "search":
        parts.push(`[${block.searchType}] ${block.pattern}`);
        break;
      case "git":
        if (block.message) parts.push(`[git ${block.operation}] ${block.message}`);
        else parts.push(`[git ${block.operation}]`);
        break;
      case "error":
        parts.push(`[error:${block.errorType}] ${block.message}`);
        break;
      case "system_event":
        // Don't include system events in FTS text
        break;
      case "control":
        // Don't include control blocks in FTS text
        break;
      case "tool_call":
        if (block.description) parts.push(block.description);
        break;
      case "tool_result":
        // Don't index full tool output — too noisy
        break;
      case "thinking":
        // Don't index thinking blocks in FTS — optional deep search
        break;
      case "image":
        if (block.description) parts.push(block.description);
        break;
      case "code":
        parts.push(block.code);
        break;
    }
  }

  return parts.filter(Boolean).join("\n");
}

/**
 * Convert a Claude system entry into a SystemEventBlock.
 */
export function systemEntryToBlock(
  type: string,
  data: Record<string, unknown>
): SystemEventBlock {
  const eventTypeMap: Record<string, SystemEventBlock["eventType"]> = {
    "turn_duration": "turn_duration",
    "pr-link": "pr_link",
    "file-history-snapshot": "file_snapshot",
    "progress": "session_start", // approximate
  };

  return {
    type: "system_event",
    eventType: eventTypeMap[type] || "session_start",
    data,
  };
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Quick non-crypto hash for image data references (not for dedup).
 */
function hashQuick(data: string): string {
  let hash = 0;
  for (let i = 0; i < Math.min(data.length, 1000); i++) {
    hash = ((hash << 5) - hash + data.charCodeAt(i)) | 0;
  }
  return `img_${Math.abs(hash).toString(36)}`;
}

/**
 * Truncate all string fields in a tool input object.
 */
function truncateInputFields(
  input: Record<string, any>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") {
      result[key] = truncate(value, STORAGE_LIMITS.toolInput);
    } else {
      result[key] = value;
    }
  }
  return result;
}
