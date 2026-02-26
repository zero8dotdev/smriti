/**
 * generic.ts - Generic file parser for importing transcripts (pure function)
 *
 * Supports chat format (role: content) and JSONL format.
 * Pure function — no database calls.
 *
 * NO DATABASE CALLS — returns ParsedSession for orchestrator to handle persistence.
 */

import { importTranscript } from "../qmd";
import type { ParsedSession } from "./types";
import type { IngestResult, IngestOptions } from "./index";

export type GenericIngestOptions = IngestOptions & {
  filePath: string;
  format?: "chat" | "jsonl";
  agentName?: string;
  title?: string;
  sessionId?: string;
  projectId?: string;
};

// =============================================================================
// Pure Parser (NO database calls)
// =============================================================================

/**
 * Parse a generic transcript file into a ParsedSession.
 * Pure function — no database knowledge.
 */
export async function parseGenericSession(
  filePath: string,
  sessionId: string,
  agentName: string,
  format: "chat" | "jsonl" = "chat",
  title?: string
): Promise<ParsedSession> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    throw new Error(`File not found: ${filePath}`);
  }

  const content = await file.text();

  // Parse simple chat format (role: content) or JSONL
  const messages: any[] = [];
  if (format === "chat") {
    const lines = content.split("\n").filter((l) => l.trim());
    for (const line of lines) {
      const match = line.match(/^(\w+):\s*(.*)/);
      if (match) {
        const [, role, text] = match;
        messages.push({
          id: `${sessionId}-msg-${messages.length}`,
          sessionId,
          sequence: messages.length,
          timestamp: new Date().toISOString(),
          role: (role === "user" || role === "assistant") ? role : "user",
          agent: agentName,
          blocks: [{ type: "text", text }],
          metadata: {},
          plainText: text,
        });
      }
    }
  } else if (format === "jsonl") {
    const lines = content.split("\n").filter((l) => l.trim());
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        messages.push({
          id: `${sessionId}-msg-${messages.length}`,
          sessionId,
          sequence: messages.length,
          timestamp: entry.timestamp || new Date().toISOString(),
          role: entry.role || "user",
          agent: agentName,
          blocks: [{ type: "text", text: entry.content || entry.text || "" }],
          metadata: entry.metadata || {},
          plainText: entry.content || entry.text || "",
        });
      } catch {
        // Skip malformed lines
      }
    }
  }

  const finalTitle = title || messages[0]?.plainText.slice(0, 100).replace(/\n/g, " ") || sessionId;

  return {
    session: {
      id: sessionId,
      title: finalTitle,
      created_at: messages[0]?.timestamp || new Date().toISOString(),
    },
    messages,
  };
}

// =============================================================================
// Ingestion (orchestrator — temporary wrapper for backward compatibility)
// =============================================================================

/**
 * Ingest a transcript file using generic parser.
 * TEMPORARY: This will be removed in Phase 4 when orchestrator is refactored.
 */
export async function ingestGeneric(
  options: GenericIngestOptions
): Promise<IngestResult> {
  const { db, filePath, format, agentName, title, sessionId, projectId } =
    options;
  if (!db) throw new Error("Database required for ingestion");

  const { upsertSessionMeta, upsertProject } = await import("../db");
  const { addMessage } = await import("../qmd");

  const result: IngestResult = {
    agent: agentName || "generic",
    sessionsFound: 1,
    sessionsIngested: 0,
    messagesIngested: 0,
    skipped: 0,
    errors: [],
  };

  try {
    // Use pure parser
    const parsed = await parseGenericSession(
      filePath,
      sessionId || `generic-${Date.now()}`,
      agentName || "generic",
      format,
      title
    );

    if (parsed.messages.length === 0) {
      result.skipped = 1;
      return result;
    }

    // If a project was specified, register it
    if (projectId) {
      upsertProject(db, projectId);
    }

    // Store messages
    for (const msg of parsed.messages) {
      await addMessage(db, parsed.session.id, msg.role, msg.plainText, {
        title: parsed.session.title,
      });
    }

    // Attach metadata
    upsertSessionMeta(db, parsed.session.id, agentName || "generic", projectId);

    result.sessionsIngested = 1;
    result.messagesIngested = parsed.messages.length;
  } catch (err: any) {
    result.errors.push(err.message);
  }

  return result;
}
