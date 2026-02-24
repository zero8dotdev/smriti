/**
 * ingest/index.ts - Ingest orchestrator
 *
 * Routes to the correct parser based on agent name, handles deduplication,
 * and returns ingest statistics.
 */

import type { Database } from "bun:sqlite";

// =============================================================================
// Types — re-export from types.ts
// =============================================================================

export type { ParsedMessage, StructuredMessage, MessageBlock, MessageMetadata } from "./types";

export type IngestResult = {
  agent: string;
  sessionsFound: number;
  sessionsIngested: number;
  messagesIngested: number;
  skipped: number;
  errors: string[];
};

export type IngestOptions = {
  db?: Database;
  existingSessionIds?: Set<string>;
  onProgress?: (msg: string) => void;
  logsDir?: string;
};

// =============================================================================
// Orchestrator
// =============================================================================

/**
 * Get the set of session IDs that already have Smriti metadata.
 * Used for deduplication during ingestion.
 */
export function getExistingSessionIds(db: Database): Set<string> {
  const rows = db
    .prepare(`SELECT session_id FROM smriti_session_meta`)
    .all() as { session_id: string }[];
  return new Set(rows.map((r) => r.session_id));
}

/**
 * Ingest conversations from a specific agent.
 */
export async function ingest(
  db: Database,
  agent: string,
  options: {
    onProgress?: (msg: string) => void;
    logsDir?: string;
    projectPath?: string;
    filePath?: string;
    format?: "chat" | "jsonl";
    title?: string;
    sessionId?: string;
    projectId?: string;
  } = {}
): Promise<IngestResult> {
  const existingSessionIds = getExistingSessionIds(db);
  const baseOptions: IngestOptions = {
    db,
    existingSessionIds,
    onProgress: options.onProgress,
    logsDir: options.logsDir,
  };

  switch (agent) {
    case "claude":
    case "claude-code": {
      const { ingestClaude } = await import("./claude");
      return ingestClaude(baseOptions);
    }
    case "codex": {
      const { ingestCodex } = await import("./codex");
      return ingestCodex(baseOptions);
    }
    case "cursor": {
      const { ingestCursor } = await import("./cursor");
      return ingestCursor({ ...baseOptions, projectPath: options.projectPath });
    }
    case "cline": {
      const { ingestCline } = await import("./cline");
      return ingestCline(baseOptions);
    }
    case "copilot": {
      const { ingestCopilot } = await import("./copilot");
      return ingestCopilot({ ...baseOptions, projectPath: options.projectPath });
    }
    case "file":
    case "generic": {
      const { ingestGeneric } = await import("./generic");
      return ingestGeneric({
        ...baseOptions,
        filePath: options.filePath || "",
        format: options.format,
        title: options.title,
        sessionId: options.sessionId,
        projectId: options.projectId,
        agentName: agent === "file" ? "generic" : agent,
      });
    }
    default:
      return {
        agent,
        sessionsFound: 0,
        sessionsIngested: 0,
        messagesIngested: 0,
        skipped: 0,
        errors: [`Unknown agent: ${agent}. Use: claude, codex, cursor, cline, copilot, or file`],
      };
  }
}

/**
 * Ingest from all known agents.
 */
export async function ingestAll(
  db: Database,
  options: { onProgress?: (msg: string) => void } = {}
): Promise<IngestResult[]> {
  const results: IngestResult[] = [];

  for (const agent of ["claude-code", "codex", "cline", "copilot"]) {
    const result = await ingest(db, agent, options);
    results.push(result);
  }

  return results;
}
