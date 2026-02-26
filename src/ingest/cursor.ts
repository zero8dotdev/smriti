/**
 * cursor.ts - Cursor IDE conversation parser (pure function)
 *
 * Reads conversation data from .cursor/ directories within projects
 * and normalizes to ParsedSession format.
 *
 * NO DATABASE CALLS — returns ParsedSession for orchestrator to handle persistence.
 */

import { addMessage } from "../qmd";
import type { ParsedMessage, ParsedSession } from "./types";
import type { IngestResult, IngestOptions } from "./index";

/** Shape of a Cursor conversation entry */
type CursorEntry = {
  role?: string;
  content?: string;
  type?: string;
  text?: string;
  timestamp?: string;
};

/** Shape of a Cursor conversation file (JSON array or object) */
type CursorConversation = {
  id?: string;
  title?: string;
  messages?: CursorEntry[];
  tabs?: Array<{
    id?: string;
    messages?: CursorEntry[];
  }>;
};

/**
 * Parse a Cursor conversation JSON file into normalized messages.
 */
export function parseCursorJson(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  let data: CursorConversation | CursorConversation[];
  try {
    data = JSON.parse(content);
  } catch {
    return messages;
  }

  const conversations = Array.isArray(data) ? data : [data];

  for (const conv of conversations) {
    const allMessages = [
      ...(conv.messages || []),
      ...(conv.tabs?.flatMap((t) => t.messages || []) || []),
    ];

    for (const entry of allMessages) {
      const role = entry.role || entry.type;
      if (!role || (role !== "user" && role !== "assistant")) continue;

      const text = entry.content || entry.text;
      if (!text?.trim()) continue;

      messages.push({
        role,
        content: text,
        timestamp: entry.timestamp,
      });
    }
  }

  return messages;
}

/**
 * Discover Cursor conversation files in a project directory.
 */
export async function discoverCursorSessions(
  projectPath: string
): Promise<Array<{ sessionId: string; filePath: string; projectPath: string }>> {
  const sessions: Array<{
    sessionId: string;
    filePath: string;
    projectPath: string;
  }> = [];

  const cursorDir = `${projectPath}/.cursor`;
  try {
    const glob = new Bun.Glob("**/*.json");
    for await (const match of glob.scan({ cwd: cursorDir, absolute: false })) {
      const sessionId = `cursor-${match.replace(/\.json$/, "").replace(/\//g, "-")}`;
      sessions.push({
        sessionId,
        filePath: `${cursorDir}/${match}`,
        projectPath,
      });
    }
  } catch {
    // .cursor directory may not exist
  }

  return sessions;
}

// =============================================================================
// Pure Parser (NO database calls)
// =============================================================================

/**
 * Parse a single Cursor session into a ParsedSession.
 * Pure function — no database knowledge.
 */
export async function parseCursorSession(
  sessionId: string,
  filePath: string
): Promise<ParsedSession> {
  const file = Bun.file(filePath);
  const content = await file.text();
  const parsedMessages = parseCursorJson(content);

  // Convert ParsedMessage to StructuredMessage
  const messages: any[] = parsedMessages.map((msg, idx) => ({
    id: `${sessionId}-msg-${idx}`,
    sessionId,
    sequence: idx,
    timestamp: msg.timestamp || new Date().toISOString(),
    role: msg.role,
    agent: "cursor",
    blocks: [{ type: "text", text: msg.content }],
    metadata: msg.metadata || {},
    plainText: msg.content,
  }));

  const firstUser = parsedMessages.find((m) => m.role === "user");
  const title = firstUser
    ? firstUser.content.slice(0, 100).replace(/\n/g, " ")
    : sessionId;

  return {
    session: {
      id: sessionId,
      title,
      created_at: parsedMessages[0]?.timestamp || new Date().toISOString(),
    },
    messages,
  };
}

// =============================================================================
// Ingestion (orchestrator — temporary wrapper for backward compatibility)
// =============================================================================

/**
 * Ingest Cursor sessions from a project directory.
 * TEMPORARY: This will be removed in Phase 4 when orchestrator is refactored.
 */
export async function ingestCursor(
  options: IngestOptions & { projectPath?: string } = {}
): Promise<IngestResult> {
  const { db, existingSessionIds, onProgress, projectPath } = options;
  if (!db) throw new Error("Database required for ingestion");
  if (!projectPath) throw new Error("projectPath required for Cursor ingestion");

  const { upsertProject, upsertSessionMeta } = await import("../db");

  const sessions = await discoverCursorSessions(projectPath);
  const result: IngestResult = {
    agent: "cursor",
    sessionsFound: sessions.length,
    sessionsIngested: 0,
    messagesIngested: 0,
    skipped: 0,
    errors: [],
  };

  // Derive project ID from path
  const projectId = projectPath.split("/").filter(Boolean).pop() || "unknown";
  upsertProject(db, projectId, projectPath);

  for (const session of sessions) {
    if (existingSessionIds?.has(session.sessionId)) {
      result.skipped++;
      continue;
    }

    try {
      // Use pure parser
      const parsed = await parseCursorSession(session.sessionId, session.filePath);

      if (parsed.messages.length === 0) {
        result.skipped++;
        continue;
      }

      for (const msg of parsed.messages) {
        await addMessage(db, session.sessionId, msg.role, msg.plainText, {
          title: parsed.session.title,
        });
      }

      upsertSessionMeta(db, session.sessionId, "cursor", projectId);
      result.sessionsIngested++;
      result.messagesIngested += parsed.messages.length;

      if (onProgress) {
        onProgress(
          `Ingested ${session.sessionId} (${parsed.messages.length} messages)`
        );
      }
    } catch (err: any) {
      result.errors.push(`${session.sessionId}: ${err.message}`);
    }
  }

  return result;
}
