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

export type ToolCorrelation = { messageId: number; toolName: string };
export type ToolCorrelationMap = Map<string, ToolCorrelation>;

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
  createdAt: string,
  correlationMap?: ToolCorrelationMap
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
        // Register in correlation map for later result matching
        if (correlationMap && block.toolId) {
          correlationMap.set(block.toolId, { messageId, toolName: block.toolName });
        }
        break;
      case "tool_result":
        if (correlationMap && block.toolId) {
          const corr = correlationMap.get(block.toolId);
          if (corr) {
            // Update tool_usage success from actual result
            db.prepare(
              `UPDATE smriti_tool_usage SET success = ? WHERE message_id = ? AND session_id = ? AND tool_name = ?`
            ).run(block.success ? 1 : 0, corr.messageId, sessionId, corr.toolName);

            // Backfill exit code for Bash commands
            if (corr.toolName === "Bash" && block.exitCode !== undefined) {
              db.prepare(
                `UPDATE smriti_commands SET exit_code = ? WHERE message_id = ? AND session_id = ?`
              ).run(block.exitCode, corr.messageId, sessionId);
            }

            // Insert error row for failed tools
            if (!block.success) {
              insertError(
                db,
                corr.messageId,
                sessionId,
                "tool_failure",
                `${corr.toolName}: ${block.error || block.output}`.slice(0, 2000),
                createdAt
              );
            }

            correlationMap.delete(block.toolId);
          }
        }
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
