/**
 * codex.ts - Codex CLI conversation parser
 *
 * Reads conversation logs from ~/.codex/ directories and normalizes
 * to QMD's addMessage() format.
 */

import { join } from "path";
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
  // Rollout format (codex_cli_rs >= ~0.40): messages wrapped in payload
  payload?: {
    type?: string;
    role?: string;
    content?: string | Array<{ type: string; text?: string }>;
  };
};

const TEXT_BLOCK_TYPES = new Set(["text", "input_text", "output_text"]);

function extractContent(
  content: string | Array<{ type: string; text?: string }> | undefined
): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => TEXT_BLOCK_TYPES.has(b.type) && b.text)
      .map((b) => b.text!)
      .join("\n");
  }
  return "";
}

/** Injected context blocks Codex records as user messages — not real conversation */
function isInjectedContext(text: string): boolean {
  return (
    text.startsWith("# AGENTS.md instructions") ||
    text.startsWith("<environment_context>") ||
    text.startsWith("<user_instructions>") ||
    text.startsWith("<permissions instructions>")
  );
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

    // Rollout format: unwrap response_item message payloads
    let role: string | undefined;
    let content: CodexEntry["content"];
    if (entry.type === "response_item" && entry.payload?.type === "message") {
      role = entry.payload.role;
      content = entry.payload.content;
    } else {
      role = entry.role || entry.type;
      content = entry.content;
    }
    if (!role || (role !== "user" && role !== "assistant")) continue;

    const text = extractContent(content);
    if (!text.trim()) continue;
    if (role === "user" && isInjectedContext(text)) continue;

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
      const normalizedMatch = match.replaceAll("\\", "/");
      const sessionId = normalizedMatch.replace(/\.jsonl$/, "").replaceAll("/", "-");
      sessions.push({
        sessionId: `codex-${sessionId}`,
        filePath: join(dir, normalizedMatch),
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
