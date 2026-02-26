/**
 * codex.ts - Codex CLI conversation parser (pure function)
 *
 * Reads conversation logs from ~/.codex/ directories and normalizes
 * to ParsedSession format.
 *
 * NO DATABASE CALLS — returns ParsedSession for orchestrator to handle persistence.
 */

import { CODEX_LOGS_DIR } from "../config";
import { addMessage } from "../qmd";
import type { ParsedMessage, ParsedSession } from "./types";
import type { IngestResult, IngestOptions } from "./index";

/** Shape of a Codex log entry */
type CodexEntry = {
  role?: string;
  type?: string;
  content?: string | Array<{ type: string; text?: string }>;
  timestamp?: string;
  session_id?: string;
};

function extractContent(
  content: string | Array<{ type: string; text?: string }> | undefined
): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text!)
      .join("\n");
  }
  return "";
}

/**
 * Parse a single Codex JSONL file into normalized messages.
 */
export function parseCodexJsonl(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  const lines = content.split("\n").filter((l) => l.trim());

  for (const line of lines) {
    let entry: CodexEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const role = entry.role || entry.type;
    if (!role || (role !== "user" && role !== "assistant")) continue;

    const text = extractContent(entry.content);
    if (!text.trim()) continue;

    messages.push({
      role,
      content: text,
      timestamp: entry.timestamp,
    });
  }

  return messages;
}

/**
 * Discover all Codex sessions from the logs directory.
 */
export async function discoverCodexSessions(
  logsDir?: string
): Promise<Array<{ sessionId: string; filePath: string }>> {
  const dir = logsDir || CODEX_LOGS_DIR;
  const sessions: Array<{ sessionId: string; filePath: string }> = [];

  try {
    const glob = new Bun.Glob("**/*.jsonl");
    for await (const match of glob.scan({ cwd: dir, absolute: false })) {
      const sessionId = match.replace(/\.jsonl$/, "").replace(/\//g, "-");
      sessions.push({
        sessionId: `codex-${sessionId}`,
        filePath: `${dir}/${match}`,
      });
    }
  } catch {
    // Directory may not exist
  }

  return sessions;
}

// =============================================================================
// Pure Parser (NO database calls)
// =============================================================================

/**
 * Parse a single Codex session into a ParsedSession.
 * Pure function — no database knowledge.
 */
export async function parseCodexSession(
  sessionId: string,
  filePath: string
): Promise<ParsedSession> {
  const file = Bun.file(filePath);
  const content = await file.text();
  const parsedMessages = parseCodexJsonl(content);

  // Convert ParsedMessage to StructuredMessage
  const messages: any[] = parsedMessages.map((msg, idx) => ({
    id: `${sessionId}-msg-${idx}`,
    sessionId,
    sequence: idx,
    timestamp: msg.timestamp || new Date().toISOString(),
    role: msg.role,
    agent: "codex",
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
 * Ingest Codex CLI sessions into QMD's memory.
 * TEMPORARY: This will be removed in Phase 4 when orchestrator is refactored.
 */
export async function ingestCodex(
  options: IngestOptions = {}
): Promise<IngestResult> {
  const { db, existingSessionIds, onProgress } = options;
  if (!db) throw new Error("Database required for ingestion");

  const { upsertSessionMeta } = await import("../db");

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
    if (existingSessionIds?.has(session.sessionId)) {
      result.skipped++;
      continue;
    }

    try {
      // Use pure parser
      const parsed = await parseCodexSession(session.sessionId, session.filePath);

      if (parsed.messages.length === 0) {
        result.skipped++;
        continue;
      }

      for (const msg of parsed.messages) {
        await addMessage(db, session.sessionId, msg.role, msg.plainText, {
          title: parsed.session.title,
        });
      }

      upsertSessionMeta(db, session.sessionId, "codex");
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
