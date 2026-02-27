/**
 * cursor.ts - Cursor IDE conversation parser
 *
 * Reads conversation data from .cursor/ directories within projects
 * and normalizes to QMD's addMessage() format.
 */

import { join } from "path";
import { addMessage } from "../qmd";
import type { ParsedMessage, IngestResult, IngestOptions } from "./index";

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
      const normalizedMatch = match.replaceAll("\\", "/");
      const sessionId = `cursor-${normalizedMatch.replace(/\.json$/, "").replaceAll("/", "-")}`;
      sessions.push({
        sessionId,
        filePath: join(cursorDir, normalizedMatch),
        projectPath,
      });
    }
  } catch {
    // .cursor directory may not exist
  }

  return sessions;
}

/**
 * Ingest Cursor sessions from a project directory.
 */
export async function ingestCursor(
  options: IngestOptions & { projectPath?: string } = {}
): Promise<IngestResult> {
  const { db, onProgress, projectPath } = options;
  if (!db) throw new Error("Database required for ingestion");
  if (!projectPath) throw new Error("projectPath required for Cursor ingestion");
  const { ingest } = await import("./index");
  return ingest(db, "cursor", {
    projectPath,
    onProgress,
  });
}
