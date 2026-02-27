import type { Database } from "bun:sqlite";
import { addMessage } from "../qmd";
import {
  insertCommand,
  insertError,
  insertFileOperation,
  insertGitOperation,
  insertToolUsage,
  upsertProject,
  upsertSessionCosts,
  upsertSessionMeta,
} from "../db";
import type { MessageBlock } from "./types";

export type StoreMessageResult = {
  messageId: number;
  success: boolean;
  error?: string;
};

export async function storeMessage(
  db: Database,
  sessionId: string,
  role: string,
  content: string,
  options?: { title?: string; metadata?: Record<string, unknown> }
): Promise<StoreMessageResult> {
  try {
    const stored = await addMessage(db, sessionId, role, content, options);
    return { messageId: stored.id, success: true };
  } catch (err: any) {
    return { messageId: -1, success: false, error: err.message };
  }
}

export function storeBlocks(
  db: Database,
  messageId: number,
  sessionId: string,
  projectId: string | null,
  blocks: MessageBlock[],
  createdAt: string
): void {
  for (const block of blocks) {
    switch (block.type) {
      case "tool_call":
        insertToolUsage(
          db,
          messageId,
          sessionId,
          block.toolName,
          block.description || null,
          true,
          null,
          createdAt
        );
        break;
      case "file_op":
        insertFileOperation(
          db,
          messageId,
          sessionId,
          block.operation,
          block.path,
          projectId,
          createdAt
        );
        break;
      case "command":
        insertCommand(
          db,
          messageId,
          sessionId,
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
          sessionId,
          block.operation,
          block.branch ?? null,
          block.prUrl ?? null,
          block.prNumber ?? null,
          block.message ? JSON.stringify({ message: block.message }) : null,
          createdAt
        );
        break;
      case "error":
        insertError(db, messageId, sessionId, block.errorType, block.message, createdAt);
        break;
    }
  }
}

export function storeSession(
  db: Database,
  sessionId: string,
  agentId: string,
  projectId: string | null,
  projectPath?: string | null
): void {
  if (projectId) {
    upsertProject(db, projectId, projectPath || undefined);
  }
  const agentExists = db
    .prepare(`SELECT 1 as yes FROM smriti_agents WHERE id = ?`)
    .get(agentId) as { yes: number } | null;
  upsertSessionMeta(db, sessionId, agentExists ? agentId : undefined, projectId || undefined);
}

export function storeCosts(
  db: Database,
  sessionId: string,
  model: string | null,
  inputTokens: number,
  outputTokens: number,
  cacheTokens: number,
  durationMs: number
): void {
  upsertSessionCosts(db, sessionId, model, inputTokens, outputTokens, cacheTokens, durationMs);
}
