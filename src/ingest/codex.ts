/**
 * codex.ts - Codex CLI conversation parser
 *
 * Reads conversation logs from ~/.codex/ directories and normalizes
 * to QMD's addMessage() format.
 */

import { CODEX_LOGS_DIR } from "../config";
import { addMessage } from "../qmd";
import type { ParsedMessage, IngestResult, IngestOptions } from "./index";

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

/**
 * Ingest Codex CLI sessions into QMD's memory.
 */
export async function ingestCodex(
  options: IngestOptions = {}
): Promise<IngestResult> {
  const { db, onProgress } = options;
  if (!db) throw new Error("Database required for ingestion");
  const { ingest } = await import("./index");
  return ingest(db, "codex", {
    logsDir: options.logsDir,
    onProgress,
  });
}
