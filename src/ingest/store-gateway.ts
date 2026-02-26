/**
 * store-gateway.ts - Unified persistence interface
 *
 * Centralizes all database write operations (SQLite + ES).
 * Single place to manage SQLite schema, ES indices, and persistence layers.
 *
 * Design: Fire-and-forget ES writes don't block SQLite success.
 * If ES fails, SQLite still succeeds (degraded mode).
 */

import type { Database } from "bun:sqlite";
import type { MessageBlock } from "./types";

// =============================================================================
// Types
// =============================================================================

export type StoreMessageResult = {
  messageId: string;
  success: boolean;
  error?: string;
};

// =============================================================================
// Store Message (SQLite + ES parallel)
// =============================================================================

/**
 * Store a single message to SQLite (via QMD) and ES in parallel.
 *
 * ES write is non-blocking (fire & forget):
 * - If ES fails, SQLite still succeeds
 * - Caller doesn't wait for ES completion
 * - Errors logged but not thrown
 */
export async function storeMessage(
  db: Database,
  sessionId: string,
  role: string,
  content: string,
  blocks: MessageBlock[] = [],
  metadata?: Record<string, any>
): Promise<StoreMessageResult> {
  try {
    // Import QMD function
    const { addMessage } = await import("../qmd");

    // Store to SQLite (synchronous via QMD)
    const result = await addMessage(db, sessionId, role, content, {
      ...metadata,
      blocks,
    });

    const messageId = result.id;

    // Store to ES in parallel (non-blocking, fire & forget)
    storeMessageToES(sessionId, role, content, metadata).catch((err) => {
      console.warn(`[ES] Message ingest failed for ${sessionId}:`, err.message);
    });

    return {
      messageId,
      success: true,
    };
  } catch (err) {
    return {
      messageId: "",
      success: false,
      error: (err as Error).message,
    };
  }
}

// =============================================================================
// Store Blocks (all sidecar tables)
// =============================================================================

/**
 * Store all blocks from a message to sidecar tables.
 * Handles tool usage, file operations, commands, git ops, errors.
 */
export async function storeBlocks(
  db: Database,
  messageId: string,
  sessionId: string,
  projectId: string,
  blocks: MessageBlock[],
  createdAt: string = new Date().toISOString()
): Promise<void> {
  const {
    insertToolUsage,
    insertFileOperation,
    insertCommand,
    insertGitOperation,
    insertError,
  } = await import("../db");

  for (const block of blocks) {
    switch (block.type) {
      case "tool_call":
        insertToolUsage(
          db,
          messageId,
          sessionId,
          (block as any).toolName,
          (block as any).description || "",
          true, // success assumed; updated by tool_result if paired
          null,
          createdAt
        );
        break;

      case "file_op":
        if ((block as any).path) {
          insertFileOperation(
            db,
            messageId,
            sessionId,
            (block as any).operation,
            (block as any).path,
            projectId,
            createdAt
          );
        }
        break;

      case "command":
        insertCommand(
          db,
          messageId,
          sessionId,
          (block as any).command,
          (block as any).exitCode ?? null,
          (block as any).cwd ?? null,
          (block as any).isGit,
          createdAt
        );
        break;

      case "git":
        insertGitOperation(
          db,
          messageId,
          sessionId,
          (block as any).operation,
          (block as any).branch ?? null,
          (block as any).prUrl ?? null,
          (block as any).prNumber ?? null,
          (block as any).message ? JSON.stringify({ message: (block as any).message }) : null,
          createdAt
        );
        break;

      case "error":
        insertError(
          db,
          messageId,
          sessionId,
          (block as any).errorType,
          (block as any).message,
          createdAt
        );
        break;
    }
  }
}

// =============================================================================
// Store Session (SQLite + ES)
// =============================================================================

/**
 * Store session metadata to SQLite and ES.
 * Called once per session (not per message).
 */
export async function storeSession(
  db: Database,
  sessionId: string,
  agentId: string,
  projectId: string,
  title: string,
  metadata?: { total_tokens?: number; total_duration_ms?: number }
): Promise<void> {
  const { upsertSessionMeta } = await import("../db");

  // Store to SQLite
  upsertSessionMeta(db, sessionId, agentId, projectId);

  // Store to ES in parallel (non-blocking, fire & forget)
  storeSessionToES(sessionId, agentId, projectId, {
    title,
    total_tokens: metadata?.total_tokens,
    total_duration_ms: metadata?.total_duration_ms,
  }).catch((err) => {
    console.warn(`[ES] Session ingest failed for ${sessionId}:`, err.message);
  });
}

// =============================================================================
// Store Costs (tokens, duration)
// =============================================================================

/**
 * Store aggregated session costs.
 * Called once per session after all messages are processed.
 */
export async function storeCosts(
  db: Database,
  sessionId: string,
  tokens: number = 0,
  durationMs: number = 0
): Promise<void> {
  const { upsertSessionCosts } = await import("../db");

  if (tokens > 0 || durationMs > 0) {
    upsertSessionCosts(db, sessionId, null, tokens, 0, 0, durationMs);
  }
}

// =============================================================================
// Store Project (create/upsert)
// =============================================================================

/**
 * Register a project in the database.
 */
export async function storeProject(
  db: Database,
  projectId: string,
  projectPath: string
): Promise<void> {
  const { upsertProject } = await import("../db");
  upsertProject(db, projectId, projectPath);
}

// =============================================================================
// Helper: ES Writers (non-blocking)
// =============================================================================

/**
 * Store a message to Elasticsearch (async, non-blocking).
 * Called from storeMessage() but doesn't block the caller.
 */
async function storeMessageToES(
  sessionId: string,
  role: string,
  content: string,
  metadata?: Record<string, any>
): Promise<void> {
  try {
    const { ingestMessageToES } = await import("../es/ingest");
    await ingestMessageToES(sessionId, role, content, metadata);
  } catch (err) {
    // Log but don't throw — ES is optional
    console.warn(`[ES] Failed to ingest message:`, (err as Error).message);
  }
}

/**
 * Store a session to Elasticsearch (async, non-blocking).
 * Called from storeSession() but doesn't block the caller.
 */
async function storeSessionToES(
  sessionId: string,
  agentId: string,
  projectId: string,
  metadata?: Record<string, any>
): Promise<void> {
  try {
    const { ingestSessionToES } = await import("../es/ingest");
    await ingestSessionToES(sessionId, agentId, projectId, metadata);
  } catch (err) {
    // Log but don't throw — ES is optional
    console.warn(`[ES] Failed to ingest session:`, (err as Error).message);
  }
}
