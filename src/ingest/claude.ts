/**
 * claude.ts - Claude Code conversation parser (enriched)
 *
 * Reads JSONL transcripts from ~/.claude/projects/ and produces
 * StructuredMessage objects with full block extraction, then stores
 * via QMD's addMessage() with sidecar table population.
 */

import { existsSync } from "fs";
import { basename } from "path";
import { CLAUDE_LOGS_DIR, PROJECTS_ROOT } from "../config";
import { addMessage } from "../qmd";
import type { ParsedMessage, StructuredMessage, MessageMetadata } from "./types";
import type { IngestResult, IngestOptions } from "./index";
import type { MessageBlock } from "./types";
import {
  extractBlocks,
  flattenBlocksToText,
  systemEntryToBlock,
  type RawContentBlock,
} from "./blocks";

// =============================================================================
// Raw JSONL entry types (expanded)
// =============================================================================

/** Full shape of a Claude Code JSONL entry */
type ClaudeEntry = {
  type: "user" | "assistant" | "system" | "file-history-snapshot" | "pr-link" | "progress" | "queue-operation" | string;
  subtype?: string;
  sessionId?: string;
  uuid?: string;
  parentUuid?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  slug?: string;
  permissionMode?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  requestId?: string;
  message?: {
    role: string;
    model?: string;
    id?: string;
    type?: string;
    content: string | RawContentBlock[];
    stop_reason?: string | null;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  // System event fields
  durationMs?: number;
  prNumber?: number;
  prUrl?: string;
  prRepository?: string;
};

// =============================================================================
// Legacy extractContent (for backward-compat ParsedMessage)
// =============================================================================

/**
 * Extract text content from a Claude message content field.
 * Content can be a string or an array of content blocks.
 */
function extractContent(
  content: string | Array<{ type: string; text?: string; thinking?: string }>
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text!)
    .join("\n");
}

// =============================================================================
// Path resolution (unchanged)
// =============================================================================

/**
 * Reconstruct a real filesystem path from a Claude projects directory name.
 */
export function deriveProjectPath(dirName: string): string {
  const raw = dirName.replace(/^-/, "");
  const parts = raw.split("-");

  const segments: string[] = [];
  let i = 0;
  while (i < parts.length) {
    let best = parts[i];
    let bestLen = 1;
    for (let j = i + 1; j < parts.length; j++) {
      const candidate = parts.slice(i, j + 1).join("-");
      const candidatePath = "/" + [...segments, candidate].join("/");
      if (existsSync(candidatePath)) {
        best = candidate;
        bestLen = j - i + 1;
      }
    }
    segments.push(best);
    i += bestLen;
  }

  return "/" + segments.join("/");
}

/**
 * Derive a project ID from a Claude projects directory name.
 */
export function deriveProjectId(dirName: string): string {
  const realPath = deriveProjectPath(dirName);
  const root = PROJECTS_ROOT.replace(/\/+$/, "");

  if (realPath === root) {
    return basename(root);
  }

  if (realPath.startsWith(root + "/")) {
    return realPath.slice(root.length + 1);
  }

  return basename(realPath) || "home";
}

// =============================================================================
// Structured parsing
// =============================================================================

/**
 * Parse a single Claude Code JSONL entry into a StructuredMessage.
 * Returns null for entries that should be skipped (meta, empty, etc.)
 */
function parseEntry(
  entry: ClaudeEntry,
  sequence: number
): StructuredMessage | null {
  // Handle system events — these produce system-role messages
  if (entry.type === "system" && entry.subtype === "turn_duration") {
    return {
      id: entry.uuid || `sys-${sequence}`,
      sessionId: entry.sessionId || "",
      sequence,
      timestamp: entry.timestamp || new Date().toISOString(),
      role: "system",
      agent: "claude-code",
      blocks: [
        systemEntryToBlock("turn_duration", {
          durationMs: entry.durationMs,
        }),
      ],
      metadata: {},
      plainText: "",
    };
  }

  if (entry.type === "pr-link") {
    return {
      id: entry.uuid || `pr-${sequence}`,
      sessionId: entry.sessionId || "",
      sequence,
      timestamp: entry.timestamp || new Date().toISOString(),
      role: "system",
      agent: "claude-code",
      blocks: [
        systemEntryToBlock("pr-link", {
          prNumber: entry.prNumber,
          prUrl: entry.prUrl,
          prRepository: entry.prRepository,
        }),
        {
          type: "git",
          operation: "pr_create",
          prUrl: entry.prUrl,
          prNumber: entry.prNumber,
        },
      ],
      metadata: {},
      plainText: entry.prUrl ? `[PR #${entry.prNumber}] ${entry.prUrl}` : "",
    };
  }

  // Skip non-message entries
  if (entry.type !== "user" && entry.type !== "assistant") {
    return null;
  }

  // Skip meta messages (hooks, commands)
  if (entry.isMeta) return null;

  // Must have message content
  if (!entry.message?.content) return null;

  // Extract blocks from content
  const blocks = extractBlocks(entry.message.content as string | RawContentBlock[]);
  if (blocks.length === 0) return null;

  // Compute plain text for FTS
  const plainText = flattenBlocksToText(blocks);

  // Skip system/command content (only for text-only messages)
  if (
    blocks.length === 1 &&
    blocks[0].type === "text" &&
    (blocks[0].text.startsWith("<local-command-") ||
      blocks[0].text.startsWith("<command-name>"))
  ) {
    return null;
  }

  // Build metadata
  const metadata: MessageMetadata = {};
  if (entry.cwd) metadata.cwd = entry.cwd;
  if (entry.gitBranch) metadata.gitBranch = entry.gitBranch;
  if (entry.version) metadata.agentVersion = entry.version;
  if (entry.parentUuid) metadata.parentId = entry.parentUuid;
  if (entry.isSidechain) metadata.isSidechain = true;
  if (entry.permissionMode) metadata.permissionMode = entry.permissionMode;
  if (entry.slug) metadata.slug = entry.slug;
  if (entry.requestId) metadata.requestId = entry.requestId;

  // Assistant-specific metadata
  if (entry.type === "assistant" && entry.message) {
    if (entry.message.model) metadata.model = entry.message.model;
    if (entry.message.stop_reason) metadata.stopReason = entry.message.stop_reason;
    if (entry.message.usage) {
      metadata.tokenUsage = {
        input: entry.message.usage.input_tokens || 0,
        output: entry.message.usage.output_tokens || 0,
        cacheCreate: entry.message.usage.cache_creation_input_tokens,
        cacheRead: entry.message.usage.cache_read_input_tokens,
      };
    }
  }

  const role = (entry.message?.role || entry.type) as StructuredMessage["role"];

  return {
    id: entry.uuid || `msg-${sequence}`,
    sessionId: entry.sessionId || "",
    sequence,
    timestamp: entry.timestamp || new Date().toISOString(),
    role: role === "user" || role === "assistant" ? role : "user",
    agent: "claude-code",
    blocks,
    metadata,
    plainText,
  };
}

// =============================================================================
// Public API: Parse JSONL → StructuredMessage[]
// =============================================================================

/**
 * Parse a Claude Code JSONL file into StructuredMessages.
 */
export function parseClaudeJsonlStructured(content: string): StructuredMessage[] {
  const messages: StructuredMessage[] = [];
  const lines = content.split("\n").filter((l) => l.trim());
  let sequence = 0;

  for (const line of lines) {
    let entry: ClaudeEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const msg = parseEntry(entry, sequence);
    if (msg) {
      messages.push(msg);
      sequence++;
    }
  }

  return messages;
}

/**
 * Parse a single Claude Code JSONL file into normalized messages.
 * BACKWARD COMPATIBLE — returns ParsedMessage[] for existing callers.
 */
export function parseClaudeJsonl(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  const lines = content.split("\n").filter((l) => l.trim());

  for (const line of lines) {
    let entry: ClaudeEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // Skip malformed lines
    }

    // Skip non-message entries
    if (
      entry.type !== "user" &&
      entry.type !== "assistant"
    ) {
      continue;
    }

    // Skip meta messages (hooks, commands)
    if (entry.isMeta) continue;

    // Must have message content
    if (!entry.message?.content) continue;

    const text = extractContent(entry.message.content);
    if (!text.trim()) continue;

    // Skip system/command content
    if (
      text.startsWith("<local-command-") ||
      text.startsWith("<command-name>")
    ) {
      continue;
    }

    messages.push({
      role: entry.message.role || entry.type,
      content: text,
      timestamp: entry.timestamp,
      metadata: {
        uuid: entry.uuid,
        cwd: entry.cwd,
      },
    });
  }

  return messages;
}

// =============================================================================
// Session discovery (unchanged)
// =============================================================================

/**
 * Discover all Claude Code sessions from the logs directory.
 */
export async function discoverClaudeSessions(
  logsDir?: string
): Promise<
  Array<{
    sessionId: string;
    projectDir: string;
    filePath: string;
  }>
> {
  const dir = logsDir || CLAUDE_LOGS_DIR;
  const glob = new Bun.Glob("*/*.jsonl");
  const sessions: Array<{
    sessionId: string;
    projectDir: string;
    filePath: string;
  }> = [];

  for await (const match of glob.scan({ cwd: dir, absolute: false })) {
    const [projectDir, filename] = match.split("/");
    if (!projectDir || !filename) continue;
    const sessionId = filename.replace(".jsonl", "");
    sessions.push({
      sessionId,
      projectDir,
      filePath: `${dir}/${match}`,
    });
  }

  return sessions;
}

// =============================================================================
// Ingestion (enriched)
// =============================================================================

/**
 * Ingest Claude Code sessions into QMD's memory with structured block extraction.
 */
export async function ingestClaude(
  options: IngestOptions = {}
): Promise<IngestResult> {
  const { db, existingSessionIds, onProgress } = options;
  if (!db) throw new Error("Database required for ingestion");

  const {
    upsertProject,
    upsertSessionMeta,
    insertToolUsage,
    insertFileOperation,
    insertCommand,
    insertGitOperation,
    insertError,
    upsertSessionCosts,
  } = await import("../db");

  const sessions = await discoverClaudeSessions(options.logsDir);
  const result: IngestResult = {
    agent: "claude-code",
    sessionsFound: sessions.length,
    sessionsIngested: 0,
    messagesIngested: 0,
    skipped: 0,
    errors: [],
  };

  for (const session of sessions) {
    if (existingSessionIds?.has(session.sessionId)) {
      result.skipped++;
      continue;
    }

    try {
      const file = Bun.file(session.filePath);
      const content = await file.text();
      const structuredMessages = parseClaudeJsonlStructured(content);

      if (structuredMessages.length === 0) {
        result.skipped++;
        continue;
      }

      // Derive project info
      const projectId = deriveProjectId(session.projectDir);
      const projectPath = deriveProjectPath(session.projectDir);
      upsertProject(db, projectId, projectPath);

      // Extract title from first user message
      const firstUser = structuredMessages.find((m) => m.role === "user");
      const title = firstUser
        ? firstUser.plainText.slice(0, 100).replace(/\n/g, " ")
        : "";

      // Process each structured message
      for (const msg of structuredMessages) {
        // Store via QMD (backward-compatible: plainText as content)
        const stored = await addMessage(
          db,
          session.sessionId,
          msg.role,
          msg.plainText || "(structured content)",
          {
            title,
            metadata: {
              ...msg.metadata,
              blocks: msg.blocks,
            },
          }
        );

        const messageId = stored.id;
        const createdAt = msg.timestamp || new Date().toISOString();

        // Populate sidecar tables from blocks
        for (const block of msg.blocks) {
          switch (block.type) {
            case "tool_call":
              insertToolUsage(
                db,
                messageId,
                session.sessionId,
                block.toolName,
                block.description || summarizeToolInput(block.toolName, block.input),
                true, // success assumed; updated by tool_result if paired
                null,
                createdAt
              );
              break;

            case "file_op":
              if (block.path) {
                insertFileOperation(
                  db,
                  messageId,
                  session.sessionId,
                  block.operation,
                  block.path,
                  projectId,
                  createdAt
                );
              }
              break;

            case "command":
              insertCommand(
                db,
                messageId,
                session.sessionId,
                block.command,
                block.exitCode ?? null,
                block.cwd ?? null,
                block.isGit,
                createdAt
              );
              break;

            case "git":
              insertGitOperation(
                db,
                messageId,
                session.sessionId,
                block.operation,
                block.branch ?? null,
                block.prUrl ?? null,
                block.prNumber ?? null,
                block.message ? JSON.stringify({ message: block.message }) : null,
                createdAt
              );
              break;

            case "error":
              insertError(
                db,
                messageId,
                session.sessionId,
                block.errorType,
                block.message,
                createdAt
              );
              break;
          }
        }

        // Accumulate token costs from metadata
        if (msg.metadata.tokenUsage) {
          const u = msg.metadata.tokenUsage;
          upsertSessionCosts(
            db,
            session.sessionId,
            msg.metadata.model || null,
            u.input,
            u.output,
            (u.cacheCreate || 0) + (u.cacheRead || 0),
            0
          );
        }

        // Accumulate turn duration from system events
        for (const block of msg.blocks) {
          if (
            block.type === "system_event" &&
            block.eventType === "turn_duration" &&
            typeof block.data.durationMs === "number"
          ) {
            upsertSessionCosts(
              db,
              session.sessionId,
              null,
              0,
              0,
              0,
              block.data.durationMs as number
            );
          }
        }
      }

      // Attach Smriti metadata
      upsertSessionMeta(db, session.sessionId, "claude-code", projectId);

      result.sessionsIngested++;
      result.messagesIngested += structuredMessages.length;

      if (onProgress) {
        onProgress(
          `Ingested ${session.sessionId} (${structuredMessages.length} messages)`
        );
      }
    } catch (err: any) {
      result.errors.push(`${session.sessionId}: ${err.message}`);
    }
  }

  return result;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Create a short summary of tool input for the input_summary column.
 */
function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "Read":
      return `Read ${input.file_path || ""}`;
    case "Write":
      return `Write ${input.file_path || ""}`;
    case "Edit":
      return `Edit ${input.file_path || ""}`;
    case "Glob":
      return `Glob ${input.pattern || ""}`;
    case "Grep":
      return `Grep ${input.pattern || ""} in ${input.path || "."}`;
    case "Bash":
      return String(input.command || "").slice(0, 100);
    case "WebFetch":
      return `Fetch ${input.url || ""}`;
    case "WebSearch":
      return `Search: ${input.query || ""}`;
    default:
      return toolName;
  }
}
