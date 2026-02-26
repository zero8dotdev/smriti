/**
 * ingest/index.ts - Ingest orchestrator (clean layer composition)
 *
 * Routes to correct parser and coordinates three clean layers:
 * 1. Parser (pure function → ParsedSession)
 * 2. Resolver (session state → ResolvedSession)
 * 3. Gateway (persistence → SQLite + ES)
 */

import type { Database } from "bun:sqlite";
import { resolveSession } from "./session-resolver";
import {
  storeMessage,
  storeBlocks,
  storeSession,
  storeCosts,
  storeProject,
} from "./store-gateway";
import type { ParsedSession } from "./types";

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
// Generic Orchestrator (Layer Composition)
// =============================================================================

/**
 * Generic parseAndStore() orchestrator — works for ANY agent.
 *
 * Seven-step pipeline:
 * 1. Parse session (pure parser)
 * 2. Resolve session (project, incremental counts)
 * 3. Skip if no new messages
 * 4. Register project (store-gateway)
 * 5. Store each message + blocks (store-gateway)
 * 6. Store session metadata (store-gateway)
 * 7. Store aggregated costs (store-gateway)
 */
async function parseAndStore(
  db: Database,
  agent: string,
  sessionId: string,
  projectDir: string,
  parsed: ParsedSession,
  onProgress?: (msg: string) => void
): Promise<{
  ingested: boolean;
  messageCount: number;
  error?: string;
}> {
  try {
    // Step 1: Resolve session (project ID, path, incremental counts)
    const resolved = await resolveSession(db, sessionId, projectDir, agent);

    // Step 2: Skip if no new messages (incremental ingest)
    const newMessages = parsed.messages.slice(resolved.existingMessageCount);
    if (newMessages.length === 0) {
      return { ingested: false, messageCount: 0 };
    }

    // Step 3: Register project
    storeProject(db, resolved.projectId, resolved.projectPath);

    // Step 4: Store each message + blocks
    for (const msg of newMessages) {
      const result = await storeMessage(
        db,
        sessionId,
        msg.role,
        msg.plainText || "(structured content)",
        msg.blocks,
        {
          title: parsed.session.title,
          ...msg.metadata,
        }
      );

      if (!result.success) {
        console.warn(`Failed to store message: ${result.error}`);
        continue;
      }

      // Store blocks if message succeeded
      if (msg.blocks.length > 0) {
        await storeBlocks(
          db,
          result.messageId,
          sessionId,
          resolved.projectId,
          msg.blocks,
          msg.timestamp
        );
      }
    }

    // Step 5: Store session metadata (once per session)
    storeSession(db, sessionId, agent, resolved.projectId, parsed.session.title, parsed.metadata);

    // Step 6: Store aggregated costs (once per session)
    if (parsed.metadata?.total_tokens || parsed.metadata?.total_duration_ms) {
      storeCosts(
        db,
        sessionId,
        parsed.metadata.total_tokens || 0,
        parsed.metadata.total_duration_ms || 0
      );
    }

    if (onProgress) {
      onProgress(
        `Ingested ${sessionId} (${newMessages.length} new messages, ${resolved.existingMessageCount} existing)`
      );
    }

    return {
      ingested: true,
      messageCount: newMessages.length,
    };
  } catch (err) {
    return {
      ingested: false,
      messageCount: 0,
      error: (err as Error).message,
    };
  }
}

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
 *
 * Clean flow:
 * 1. Discover sessions (agent-specific)
 * 2. Parse each session (pure parser → ParsedSession)
 * 3. Store using generic orchestrator (parseAndStore)
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
  // Route to agent-specific discovery and parsing
  switch (agent) {
    case "claude":
    case "claude-code": {
      const {
        discoverClaudeSessions,
        parseClaudeSession,
      } = await import("./claude");

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
        try {
          const parsed = await parseClaudeSession(
            session.sessionId,
            session.projectDir,
            session.filePath
          );

          if (parsed.messages.length === 0) {
            result.skipped++;
            continue;
          }

          const { ingested, messageCount, error } = await parseAndStore(
            db,
            "claude-code",
            session.sessionId,
            session.projectDir,
            parsed,
            options.onProgress
          );

          if (error) {
            result.errors.push(`${session.sessionId}: ${error}`);
          } else if (ingested) {
            result.sessionsIngested++;
            result.messagesIngested += messageCount;
          } else {
            result.skipped++;
          }
        } catch (err: any) {
          result.errors.push(`${session.sessionId}: ${err.message}`);
        }
      }

      return result;
    }

    case "codex": {
      const { discoverCodexSessions, parseCodexSession } = await import("./codex");

      const sessions = await discoverCodexSessions(options.logsDir);
      const result: IngestResult = {
        agent: "codex",
        sessionsFound: sessions.length,
        sessionsIngested: 0,
        messagesIngested: 0,
        skipped: 0,
        errors: [],
      };

      for (const session of sessions) {
        try {
          const parsed = await parseCodexSession(
            session.sessionId,
            session.filePath
          );

          if (parsed.messages.length === 0) {
            result.skipped++;
            continue;
          }

          const { ingested, messageCount, error } = await parseAndStore(
            db,
            "codex",
            session.sessionId,
            "", // Codex doesn't have projectDir
            parsed,
            options.onProgress
          );

          if (error) {
            result.errors.push(`${session.sessionId}: ${error}`);
          } else if (ingested) {
            result.sessionsIngested++;
            result.messagesIngested += messageCount;
          } else {
            result.skipped++;
          }
        } catch (err: any) {
          result.errors.push(`${session.sessionId}: ${err.message}`);
        }
      }

      return result;
    }

    case "cursor": {
      if (!options.projectPath) {
        throw new Error("projectPath required for Cursor ingestion");
      }

      const { discoverCursorSessions, parseCursorSession } = await import(
        "./cursor"
      );

      const sessions = await discoverCursorSessions(options.projectPath);
      const result: IngestResult = {
        agent: "cursor",
        sessionsFound: sessions.length,
        sessionsIngested: 0,
        messagesIngested: 0,
        skipped: 0,
        errors: [],
      };

      for (const session of sessions) {
        try {
          const parsed = await parseCursorSession(
            session.sessionId,
            session.filePath
          );

          if (parsed.messages.length === 0) {
            result.skipped++;
            continue;
          }

          const { ingested, messageCount, error } = await parseAndStore(
            db,
            "cursor",
            session.sessionId,
            options.projectPath,
            parsed,
            options.onProgress
          );

          if (error) {
            result.errors.push(`${session.sessionId}: ${error}`);
          } else if (ingested) {
            result.sessionsIngested++;
            result.messagesIngested += messageCount;
          } else {
            result.skipped++;
          }
        } catch (err: any) {
          result.errors.push(`${session.sessionId}: ${err.message}`);
        }
      }

      return result;
    }

    case "cline": {
      const { discoverClineSessions, parseCliineSession } = await import(
        "./cline"
      );

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
        try {
          const parsed = await parseCliineSession(
            session.sessionId,
            session.filePath
          );

          if (parsed.messages.length === 0) {
            result.skipped++;
            continue;
          }

          const { ingested, messageCount, error } = await parseAndStore(
            db,
            "cline",
            session.sessionId,
            session.projectDir,
            parsed,
            options.onProgress
          );

          if (error) {
            result.errors.push(`${session.sessionId}: ${error}`);
          } else if (ingested) {
            result.sessionsIngested++;
            result.messagesIngested += messageCount;
          } else {
            result.skipped++;
          }
        } catch (err: any) {
          result.errors.push(`${session.sessionId}: ${err.message}`);
        }
      }

      return result;
    }

    case "copilot": {
      const { discoverCopilotSessions, parseCopilotSession } = await import(
        "./copilot"
      );

      const sessions = await discoverCopilotSessions({
        projectPath: options.projectPath,
      });
      const result: IngestResult = {
        agent: "copilot",
        sessionsFound: sessions.length,
        sessionsIngested: 0,
        messagesIngested: 0,
        skipped: 0,
        errors: [],
      };

      if (sessions.length === 0) {
        result.errors.push(
          "VS Code workspaceStorage not found. Is VS Code installed? Set COPILOT_STORAGE_DIR to override."
        );
        return result;
      }

      for (const session of sessions) {
        try {
          const parsed = await parseCopilotSession(
            session.sessionId,
            session.filePath
          );

          if (parsed.messages.length === 0) {
            result.skipped++;
            continue;
          }

          const projectDir = session.workspacePath || "";
          const { ingested, messageCount, error } = await parseAndStore(
            db,
            "copilot",
            session.sessionId,
            projectDir,
            parsed,
            options.onProgress
          );

          if (error) {
            result.errors.push(`${session.sessionId}: ${error}`);
          } else if (ingested) {
            result.sessionsIngested++;
            result.messagesIngested += messageCount;
          } else {
            result.skipped++;
          }
        } catch (err: any) {
          result.errors.push(`${session.sessionId}: ${err.message}`);
        }
      }

      return result;
    }

    case "file":
    case "generic": {
      const { parseGenericSession } = await import("./generic");

      if (!options.filePath) {
        throw new Error("filePath required for generic ingestion");
      }

      const sessionId = options.sessionId || `generic-${Date.now()}`;
      const result: IngestResult = {
        agent: options.sessionId || "generic",
        sessionsFound: 1,
        sessionsIngested: 0,
        messagesIngested: 0,
        skipped: 0,
        errors: [],
      };

      try {
        const parsed = await parseGenericSession(
          options.filePath,
          sessionId,
          agent === "file" ? "generic" : agent,
          options.format,
          options.title
        );

        if (parsed.messages.length === 0) {
          result.skipped = 1;
          return result;
        }

        const { ingested, messageCount, error } = await parseAndStore(
          db,
          agent,
          sessionId,
          "", // Generic doesn't have projectDir
          parsed,
          options.onProgress
        );

        if (error) {
          result.errors.push(error);
        } else if (ingested) {
          result.sessionsIngested = 1;
          result.messagesIngested = messageCount;
        } else {
          result.skipped = 1;
        }
      } catch (err: any) {
        result.errors.push(err.message);
      }

      return result;
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
