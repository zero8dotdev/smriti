/**
 * cline.ts - Cline CLI conversation parser (enriched)
 *
 * Reads JSON task files from ~/.cline/tasks and produces
 * StructuredMessage objects with full block extraction, then stores
 * via QMD's addMessage() with sidecar table population.
 */

import { existsSync } from "fs";
import { basename, join } from "path";
import { CLINE_LOGS_DIR, PROJECTS_ROOT } from "../config";
import { addMessage } from "../qmd";
import type { StructuredMessage, MessageMetadata } from "./types";
import type { IngestResult, IngestOptions } from "./index";
import type { MessageBlock } from "./types";
import {
  extractBlocks,
  flattenBlocksToText,
  systemEntryToBlock,
  type RawContentBlock,
} from "./blocks";
import { Database } from "bun:sqlite";

// =============================================================================
// Raw JSON entry types for Cline
// =============================================================================

/** Full shape of a Cline task JSON entry */
type ClineTask = {
  id: string;
  parentId?: string;
  name: string;
  timestamp: string;
  cwd?: string;
  gitBranch?: string;
  history: Array<ClineHistoryEntry>;
  metadata?: Record<string, unknown>;
};

type ClineHistoryEntry = {
  ts: string;
  type: "say" | "ask" | "tool" | "tool_code" | "tool_result" | "command" | "command_output" | "system_event" | "error";
  text?: string;
  toolId?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  output?: string;
  success?: boolean;
  exitCode?: number;
  command?: string;
  cwd?: string;
  isGit?: boolean;
  error?: string;
  durationMs?: number;
  question?: string;
  options?: string; // Comma-separated options for 'ask' type
};

// =============================================================================
// Path resolution
// =============================================================================

/**
 * Reconstruct a real filesystem path from a Cline projects directory name.
 * Note: Cline doesn't have a direct "project" concept like Claude Code, so we'll use the CWD.
 */
export function deriveProjectPath(cwd: string): string {
  // For Cline, the project path is simply the CWD of the task
  return cwd || PROJECTS_ROOT; // Fallback to PROJECTS_ROOT if CWD is not available
}

/**
 * Derive a project ID from a Cline task's CWD.
 */
export function deriveProjectId(cwd: string): string {
  const realPath = deriveProjectPath(cwd);
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
 * Parse a single Cline task JSON entry into StructuredMessages.
 */
function parseClineTask(task: ClineTask, sequenceOffset: number): StructuredMessage[] {
  const messages: StructuredMessage[] = [];
  let sequence = sequenceOffset;

  for (const entry of task.history) {
    let blocks: MessageBlock[] = [];
    let role: StructuredMessage["role"] = "assistant"; // Default role
    let plainText = "";
    const metadata: MessageMetadata = {};

    if (task.cwd) metadata.cwd = task.cwd;
    if (task.gitBranch) metadata.gitBranch = task.gitBranch;
    if (task.parentId) metadata.parentId = task.parentId;

    switch (entry.type) {
      case "say":
        blocks.push({ type: "text", text: entry.text || "" });
        plainText = entry.text || "";
        // Determine role based on common patterns or assume assistant for 'say'
        // For simplicity, we'll assume 'say' from assistant unless explicit user prompt found
        role = "assistant";
        break;

      case "ask":
        blocks.push({ type: "text", text: `User asked: ${entry.question || ""} (Options: ${entry.options || ""})` });
        plainText = `User asked: ${entry.question || ""}`;
        role = "user"; // User is asking a question
        break;

      case "tool":
      case "tool_code": // Assuming tool_code is also a tool call
        blocks.push({
          type: "tool_call",
          toolId: entry.toolId || "unknown_tool",
          toolName: entry.toolName || "Unknown Tool",
          input: entry.input || {},
          description: entry.text, // Use text field for description if available
        });
        plainText = `Tool Call: ${entry.toolName || "Unknown Tool"} with input: ${JSON.stringify(entry.input || {})}`;
        role = "assistant"; // Tools are typically called by the assistant
        break;

      case "tool_result":
        blocks.push({
          type: "tool_result",
          toolId: entry.toolId || "unknown_tool",
          success: entry.success ?? true,
          output: entry.output || "",
          error: entry.error,
          durationMs: entry.durationMs,
        });
        plainText = `Tool Result (Success: ${entry.success ?? true}): ${entry.output || entry.error || ""}`;
        role = "tool"; // Tool results are from the tool itself
        break;

      case "command":
        blocks.push({
          type: "command",
          command: entry.command || "",
          cwd: entry.cwd || task.cwd,
          isGit: entry.isGit ?? false,
          description: entry.text,
        });
        plainText = `Command: ${entry.command || ""}`;
        role = "assistant"; // Commands are typically executed by the assistant
        break;

      case "command_output":
        blocks.push({
          type: "command",
          command: entry.command || "", // Re-use command for context
          stdout: entry.output,
          stderr: entry.error,
          exitCode: entry.exitCode,
        });
        plainText = `Command Output: ${entry.output || entry.error || ""}`;
        role = "tool"; // Command output is from the system/tool
        break;

      case "system_event":
        blocks.push(
          systemEntryToBlock("turn_duration", { durationMs: entry.durationMs })
        );
        plainText = `System Event: Duration ${entry.durationMs || 0}ms`;
        role = "system";
        break;

      case "error":
        blocks.push({
          type: "error",
          errorType: "tool_failure", // Assuming most Cline errors relate to tool execution
          message: entry.error || "Unknown error",
        });
        plainText = `Error: ${entry.error || "Unknown error"}`;
        role = "system";
        break;

      default:
        // For any unknown types, treat as a generic text block
        blocks.push({ type: "text", text: entry.text || JSON.stringify(entry) });
        plainText = entry.text || JSON.stringify(entry);
        break;
    }

    messages.push({
      id: `${task.id}-${sequence}`, // Unique message ID within the session
      sessionId: task.id,
      sequence,
      timestamp: entry.ts || new Date().toISOString(),
      role,
      agent: "cline",
      blocks,
      metadata,
      plainText,
    });
    sequence++;
  }

  return messages;
}

// =============================================================================
// Public API: Parse JSONL → StructuredMessage[]
// =============================================================================

/**
 * Discover all Cline task sessions from the logs directory.
 */
export async function discoverClineSessions(
  logsDir?: string
): Promise<
  Array<{
    sessionId: string;
    projectDir: string; // This will be the CWD for Cline tasks
    filePath: string;
  }>
> {
  const dir = logsDir || CLINE_LOGS_DIR;
  if (!existsSync(dir)) {
    console.warn(`Cline logs directory not found: ${dir}`);
    return [];
  }

  const glob = new Bun.Glob("*.json");
  const sessions: Array<{
    sessionId: string;
    projectDir: string;
    filePath: string;
  }> = [];

  for await (const match of glob.scan({ cwd: dir, absolute: false })) {
    const filePath = join(dir, match);
    const sessionId = basename(match, ".json");

    // Read the file to get the CWD from the task object
    let task: ClineTask;
    try {
      const fileContent = await Bun.file(filePath).text();
      task = JSON.parse(fileContent);
    } catch (error) {
      console.error(`Error reading or parsing Cline task file ${filePath}:`, error);
      continue;
    }

    sessions.push({
      sessionId,
      projectDir: task.cwd || PROJECTS_ROOT, // Use task's CWD as projectDir
      filePath,
    });
  }

  return sessions;
}

// =============================================================================
// Ingestion (enriched)
// =============================================================================

/**
 * Ingest Cline CLI task sessions into QMD's memory with structured block extraction.
 */
export async function ingestCline(
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

  const sessions = await discoverClineSessions(options.logsDir);
  const result: IngestResult = {
    agent: "cline",
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
      const task: ClineTask = JSON.parse(content);
      const structuredMessages = parseClineTask(task, 0); // Start sequence from 0

      if (structuredMessages.length === 0) {
        result.skipped++;
        continue;
      }

      // Derive project info using the task's CWD
      const projectId = deriveProjectId(task.cwd || "");
      const projectPath = deriveProjectPath(task.cwd || "");
      upsertProject(db, projectId, projectPath);

      // Use task name or first message as title
      const title = task.name || structuredMessages[0].plainText.slice(0, 100).replace(/\n/g, " ");

      // Process each structured message
      for (const msg of structuredMessages) {
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

            case "system_event":
              if (block.eventType === "turn_duration" && typeof block.data.durationMs === "number") {
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
              break;
          }
        }

        // Accumulate token costs if present in metadata (Cline tasks might not have this directly)
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
      }

      // Attach Smriti metadata
      upsertSessionMeta(db, session.sessionId, "cline", projectId);

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
// Helpers (copied from claude.ts, might need adjustments based on Cline's actual tool names)
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
