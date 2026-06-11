/**
 * ingest/index.ts - Ingest orchestrator
 *
 * Routes to the correct parser based on agent name, handles deduplication,
 * and returns ingest statistics.
 */

import type { Database } from "bun:sqlite";
import type { ParsedMessage, StructuredMessage } from "./types";
import { resolveSession } from "./session-resolver";
import { storeBlocks, storeCosts, storeMessage, storeSession } from "./store-gateway";
import type { ToolCorrelationMap } from "./store-gateway";
import { deleteSidecarRows } from "../db";

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
  whole?: boolean;
};

function isStructuredMessage(msg: ParsedMessage | StructuredMessage): msg is StructuredMessage {
  return typeof (msg as StructuredMessage).plainText === "string" &&
    Array.isArray((msg as StructuredMessage).blocks);
}

async function ingestParsedSessions(
  db: Database,
  agentId: string,
  sessions: Array<{ sessionId: string; filePath: string; projectDir?: string }>,
  parser: (sessionPath: string, sessionId: string) => Promise<{
    session: { id: string; title: string; created_at: string };
    messages: Array<ParsedMessage | StructuredMessage>;
  }>,
  options: {
    existingSessionIds: Set<string>;
    onProgress?: (msg: string) => void;
    explicitProjectId?: string;
    explicitProjectPath?: string;
    incremental?: boolean;
    force?: boolean;
  } = {
    existingSessionIds: new Set(),
  }
): Promise<IngestResult> {
  const result: IngestResult = {
    agent: agentId,
    sessionsFound: sessions.length,
    sessionsIngested: 0,
    messagesIngested: 0,
    skipped: 0,
    errors: [],
  };
  const useSessionTxn = process.env.SMRITI_INGEST_SESSION_TXN !== "0";

  for (const session of sessions) {
    if (!options.force && !options.incremental && options.existingSessionIds.has(session.sessionId)) {
      result.skipped++;
      continue;
    }

    try {
      const parsed = await parser(session.filePath, session.sessionId);
      if (parsed.messages.length === 0) {
        result.skipped++;
        continue;
      }

      const resolved = resolveSession({
        db,
        sessionId: session.sessionId,
        agentId,
        projectDir: session.projectDir,
        explicitProjectId: options.explicitProjectId,
        explicitProjectPath: options.explicitProjectPath,
      });

      const messagesToIngest = options.incremental
        ? parsed.messages.slice(resolved.existingMessageCount)
        : parsed.messages;

      if (messagesToIngest.length === 0) {
        result.skipped++;
        continue;
      }

      const correlationMap: ToolCorrelationMap = new Map();
      if (useSessionTxn) db.exec("BEGIN IMMEDIATE");
      try {
        // Force mode: delete existing rows before re-processing — including
        // memory_messages, otherwise re-ingest appends duplicates
        if (options.force && options.existingSessionIds.has(session.sessionId)) {
          deleteSidecarRows(db, session.sessionId);
          db.prepare(`DELETE FROM memory_messages WHERE session_id = ?`).run(session.sessionId);
        }
        for (const msg of messagesToIngest) {
          const content = isStructuredMessage(msg) ? msg.plainText || "(structured content)" : msg.content;
          const messageOptions = isStructuredMessage(msg)
            ? {
                title: parsed.session.title,
                timestamp: msg.timestamp,
                metadata: {
                  ...msg.metadata,
                  blocks: msg.blocks,
                },
              }
            : { title: parsed.session.title, timestamp: msg.timestamp };

          const stored = await storeMessage(db, session.sessionId, msg.role, content, messageOptions);
          if (!stored.success) {
            throw new Error(stored.error || "Failed to store message");
          }

          if (isStructuredMessage(msg)) {
            storeBlocks(
              db,
              stored.messageId,
              session.sessionId,
              resolved.projectId,
              msg.blocks,
              msg.timestamp || new Date().toISOString(),
              correlationMap
            );

            if (msg.metadata.tokenUsage) {
              const u = msg.metadata.tokenUsage;
              storeCosts(
                db,
                session.sessionId,
                msg.metadata.model || null,
                u.input,
                u.output,
                (u.cacheCreate || 0) + (u.cacheRead || 0),
                0
              );
            }

            for (const block of msg.blocks) {
              if (
                block.type === "system_event" &&
                block.eventType === "turn_duration" &&
                typeof block.data.durationMs === "number"
              ) {
                storeCosts(db, session.sessionId, null, 0, 0, 0, block.data.durationMs as number);
              }
            }
          }
        }

        storeSession(
          db,
          session.sessionId,
          agentId,
          resolved.projectId,
          resolved.projectPath
        );
        if (useSessionTxn) db.exec("COMMIT");
      } catch (err) {
        if (useSessionTxn) db.exec("ROLLBACK");
        throw err;
      }

      result.sessionsIngested++;
      result.messagesIngested += messagesToIngest.length;
      if (options.onProgress) {
        options.onProgress(
          `Ingested ${session.sessionId} (${messagesToIngest.length} messages)` +
            (resolved.projectId ? ` - project: ${resolved.projectId}` : "")
        );
      }
    } catch (err: any) {
      result.errors.push(`${session.sessionId}: ${err.message}`);
    }
  }

  return result;
}

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
    storageRoots?: string[];
    filePath?: string;
    format?: "chat" | "jsonl";
    title?: string;
    sessionId?: string;
    projectId?: string;
    force?: boolean;
    whole?: boolean;
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
      const { discoverClaudeSessions } = await import("./claude");
      const { parseClaude } = await import("./parsers");
      const discovered = await discoverClaudeSessions(options.logsDir);
      const sessions = discovered.map((s) => ({
        sessionId: s.sessionId,
        filePath: s.filePath,
        projectDir: s.projectDir,
      }));
      return ingestParsedSessions(db, "claude-code", sessions, parseClaude, {
        existingSessionIds,
        onProgress: options.onProgress,
        explicitProjectId: options.projectId,
        incremental: !options.force,
        force: options.force,
      });
    }
    case "codex": {
      const { discoverCodexSessions } = await import("./codex");
      const { parseCodex } = await import("./parsers");
      const discovered = await discoverCodexSessions(options.logsDir);
      const sessions = discovered.map((s) => ({
        sessionId: s.sessionId,
        filePath: s.filePath,
      }));
      return ingestParsedSessions(db, "codex", sessions, parseCodex, {
        existingSessionIds,
        onProgress: options.onProgress,
        explicitProjectId: options.projectId,
        force: options.force,
      });
    }
    case "cursor": {
      const {
        discoverCursorSessions,
        discoverCursorSqliteSessions,
        buildComposerWorkspaceMap,
        resolveCursorUserRoots,
        parseCursorJson,
      } = await import("./cursor");
      const { parseCursor } = await import("./parsers");

      // --- SQLite path: scan Cursor app globalStorage for all composers ---
      const cursorUserRoots = resolveCursorUserRoots();
      const sqliteSessions: Array<{
        sessionId: string;
        filePath: string; // unused sentinel for the parser
        projectDir?: string;
        _preResolved?: { messages: ParsedMessage[]; title: string; createdAt: string };
      }> = [];

      for (const userRoot of cursorUserRoots) {
        const globalDbPath = `${userRoot}/globalStorage/state.vscdb`;
        const composerMap = buildComposerWorkspaceMap(userRoot);
        const discovered = discoverCursorSqliteSessions(globalDbPath, composerMap, {
          projectPath: options.projectPath,
        });
        for (const { meta, messages } of discovered) {
          sqliteSessions.push({
            sessionId: meta.sessionId,
            filePath: globalDbPath,
            projectDir: meta.projectPath ?? undefined,
            _preResolved: { messages, title: meta.title, createdAt: meta.createdAt },
          });
        }
      }

      // --- Legacy path: .cursor/**/*.json (only if projectPath given) ---
      const legacySessions: Array<{
        sessionId: string;
        filePath: string;
        projectDir?: string;
      }> = [];
      if (options.projectPath) {
        const discovered = await discoverCursorSessions(options.projectPath);
        // Avoid duplicating anything already covered by SQLite
        const sqliteIds = new Set(sqliteSessions.map((s) => s.sessionId));
        for (const s of discovered) {
          if (!sqliteIds.has(s.sessionId)) {
            legacySessions.push({
              sessionId: s.sessionId,
              filePath: s.filePath,
              projectDir: s.projectPath,
            });
          }
        }
      }

      // Ingest SQLite-discovered sessions with an identity parser (messages pre-resolved)
      let sqliteResult: IngestResult = {
        agent: "cursor",
        sessionsFound: 0,
        sessionsIngested: 0,
        messagesIngested: 0,
        skipped: 0,
        errors: [],
      };
      if (sqliteSessions.length > 0) {
        sqliteResult = await ingestParsedSessions(
          db,
          "cursor",
          sqliteSessions,
          async (_filePath: string, sessionId: string) => {
            // Find pre-resolved data for this sessionId
            const entry = sqliteSessions.find((s) => s.sessionId === sessionId);
            const pre = entry?._preResolved;
            return {
              session: {
                id: sessionId,
                title: pre?.title ?? "Cursor Chat",
                created_at: pre?.createdAt ?? new Date().toISOString(),
              },
              messages: pre?.messages ?? [],
            };
          },
          {
            existingSessionIds,
            onProgress: options.onProgress,
            explicitProjectId: options.projectId,
            force: options.force,
          }
        );
      }

      // Ingest legacy JSON sessions
      let legacyResult: IngestResult = {
        agent: "cursor",
        sessionsFound: 0,
        sessionsIngested: 0,
        messagesIngested: 0,
        skipped: 0,
        errors: [],
      };
      if (legacySessions.length > 0) {
        legacyResult = await ingestParsedSessions(
          db,
          "cursor",
          legacySessions,
          parseCursor,
          {
            existingSessionIds,
            onProgress: options.onProgress,
            explicitProjectId: options.projectId,
            force: options.force,
          }
        );
      }

      // Merge results
      return {
        agent: "cursor",
        sessionsFound: sqliteResult.sessionsFound + legacyResult.sessionsFound,
        sessionsIngested: sqliteResult.sessionsIngested + legacyResult.sessionsIngested,
        messagesIngested: sqliteResult.messagesIngested + legacyResult.messagesIngested,
        skipped: sqliteResult.skipped + legacyResult.skipped,
        errors: [...sqliteResult.errors, ...legacyResult.errors],
      };
    }
    case "cline": {
      const { discoverClineSessions } = await import("./cline");
      const { parseCline } = await import("./parsers");
      const discovered = await discoverClineSessions(options.logsDir);
      const sessions = discovered.map((s) => ({
        sessionId: s.sessionId,
        filePath: s.filePath,
        projectDir: s.projectDir,
      }));
      return ingestParsedSessions(db, "cline", sessions, parseCline, {
        existingSessionIds,
        onProgress: options.onProgress,
        explicitProjectId: options.projectId,
        force: options.force,
      });
    }
    case "copilot": {
      const { discoverCopilotSessions } = await import("./copilot");
      const { parseCopilot } = await import("./parsers");
      const discovered = await discoverCopilotSessions({
        projectPath: options.projectPath,
        storageRoots: options.storageRoots,
      });
      const sessions = discovered.map((s) => ({
        sessionId: s.sessionId,
        filePath: s.filePath,
        projectDir: s.workspacePath || undefined,
      }));
      return ingestParsedSessions(db, "copilot", sessions, parseCopilot, {
        existingSessionIds,
        onProgress: options.onProgress,
        explicitProjectId: options.projectId,
        force: options.force,
      });
    }
    case "claude-web": {
      const { ingestClaudeWeb } = await import("./claude-web");
      const filePath = options.filePath;
      if (!filePath) {
        return {
          agent: "claude-web",
          sessionsFound: 0,
          sessionsIngested: 0,
          messagesIngested: 0,
          skipped: 0,
          errors: ["File path required: smriti ingest claude-web <conversations.json>"],
        };
      }
      return ingestClaudeWeb(db, filePath, baseOptions);
    }
    case "claude-web-memory": {
      const { ingestClaudeWebMemories } = await import("./claude-web");
      const filePath = options.filePath;
      if (!filePath) {
        return {
          agent: "claude-web",
          sessionsFound: 0,
          sessionsIngested: 0,
          messagesIngested: 0,
          skipped: 0,
          errors: ["File path required: smriti ingest claude-web-memory <memories.json>"],
        };
      }
      return ingestClaudeWebMemories(db, filePath, baseOptions);
    }
    case "file":
    case "generic": {
      if (!options.filePath) {
        return {
          agent: agent === "file" ? "generic" : agent,
          sessionsFound: 0,
          sessionsIngested: 0,
          messagesIngested: 0,
          skipped: 0,
          errors: ["File path is required for generic ingestion"],
        };
      }
      const { parseGeneric } = await import("./parsers");
      const sessionId = options.sessionId || `generic-${crypto.randomUUID().slice(0, 8)}`;
      // Determine format: if --whole is specified, use "document" mode
      let format: "chat" | "jsonl" | "document" = "chat";
      if (options.whole) {
        format = "document";
      } else if (options.format) {
        format = options.format as "chat" | "jsonl";
      }
      const parsed = await parseGeneric(options.filePath, sessionId, format);
      if (options.title) {
        parsed.session.title = options.title;
      }
      const result = await ingestParsedSessions(
        db,
        agent === "file" ? "generic" : agent,
        [{ sessionId, filePath: options.filePath, projectDir: options.projectPath }],
        async () => parsed,
        {
          existingSessionIds,
          onProgress: options.onProgress,
          explicitProjectId: options.projectId,
          explicitProjectPath: options.projectPath,
          force: options.force,
        }
      );
      return result;
    }
    default:
      return {
        agent,
        sessionsFound: 0,
        sessionsIngested: 0,
        messagesIngested: 0,
        skipped: 0,
        errors: [`Unknown agent: ${agent}. Use: claude, codex, cursor, cline, copilot, claude-web, or file`],
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
