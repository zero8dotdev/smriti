/**
 * types.ts - Structured message types for enriched ingestion
 *
 * Defines the full message taxonomy across all agents: tool calls, thinking
 * blocks, file operations, commands, searches, git operations, errors, etc.
 */

// =============================================================================
// Storage Limits
// =============================================================================

export const STORAGE_LIMITS = {
  textBlock: 50_000,
  commandOutput: 2_000,
  fileContent: 10_000,
  thinkingBlock: 20_000,
  searchResults: 5_000,
  toolInput: 5_000,
};

// =============================================================================
// Content Blocks
// =============================================================================

export type TextBlock = {
  type: "text";
  text: string;
};

export type ThinkingBlock = {
  type: "thinking";
  thinking: string;
  budgetTokens?: number;
};

export type ToolCallBlock = {
  type: "tool_call";
  toolId: string;
  toolName: string;
  input: Record<string, unknown>;
  description?: string;
};

export type ToolResultBlock = {
  type: "tool_result";
  toolId: string;
  success: boolean;
  output: string;
  error?: string;
  durationMs?: number;
};

export type FileOperationBlock = {
  type: "file_op";
  operation: "read" | "write" | "edit" | "create" | "delete" | "glob";
  path: string;
  diff?: string;
  pattern?: string;
  results?: string[];
};

export type CommandBlock = {
  type: "command";
  command: string;
  cwd?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  description?: string;
  isGit: boolean;
};

export type SearchBlock = {
  type: "search";
  searchType: "grep" | "glob" | "web_fetch" | "web_search";
  pattern: string;
  path?: string;
  url?: string;
  resultCount?: number;
};

export type GitBlock = {
  type: "git";
  operation:
    | "commit"
    | "push"
    | "pull"
    | "branch"
    | "checkout"
    | "diff"
    | "merge"
    | "rebase"
    | "status"
    | "pr_create"
    | "other";
  branch?: string;
  message?: string;
  files?: string[];
  prUrl?: string;
  prNumber?: number;
};

export type ErrorBlock = {
  type: "error";
  errorType:
    | "api"
    | "tool_failure"
    | "rate_limit"
    | "timeout"
    | "permission"
    | "validation";
  message: string;
  retryable?: boolean;
};

export type ImageBlock = {
  type: "image";
  mediaType: string;
  path?: string;
  dataHash?: string;
  description?: string;
};

export type CodeBlock = {
  type: "code";
  language: string;
  code: string;
  filePath?: string;
  lineStart?: number;
};

export type SystemEventBlock = {
  type: "system_event";
  eventType:
    | "turn_duration"
    | "pr_link"
    | "file_snapshot"
    | "mode_change"
    | "session_start"
    | "session_end";
  data: Record<string, unknown>;
};

export type ConversationControlBlock = {
  type: "control";
  controlType:
    | "interrupt"
    | "retry"
    | "plan_enter"
    | "plan_exit"
    | "sidechain"
    | "slash_command";
  command?: string;
};

export type MessageBlock =
  | TextBlock
  | ThinkingBlock
  | ToolCallBlock
  | ToolResultBlock
  | FileOperationBlock
  | CommandBlock
  | SearchBlock
  | GitBlock
  | ErrorBlock
  | ImageBlock
  | CodeBlock
  | SystemEventBlock
  | ConversationControlBlock;

// =============================================================================
// Metadata
// =============================================================================

export type MessageMetadata = {
  cwd?: string;
  gitBranch?: string;
  model?: string;
  requestId?: string;
  stopReason?: string;
  tokenUsage?: {
    input: number;
    output: number;
    cacheCreate?: number;
    cacheRead?: number;
  };
  agentVersion?: string;
  parentId?: string;
  isSidechain?: boolean;
  permissionMode?: string;
  slug?: string;
};

// =============================================================================
// Structured Message
// =============================================================================

export type StructuredMessage = {
  id: string;
  sessionId: string;
  sequence: number;
  timestamp: string;
  role: "user" | "assistant" | "system" | "tool";
  agent: string;
  blocks: MessageBlock[];
  metadata: MessageMetadata;
  plainText: string;
};

// =============================================================================
// Legacy compat — ParsedMessage is still used by Codex/Cursor/Generic parsers
// =============================================================================

export type ParsedMessage = {
  role: string;
  content: string;
  timestamp?: string;
  metadata?: Record<string, unknown>;
};
