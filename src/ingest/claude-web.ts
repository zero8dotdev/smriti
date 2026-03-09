/**
 * claude-web.ts - Claude.ai data export parser
 *
 * Parses conversations.json from Claude.ai data exports.
 * Extracts artifacts, thinking blocks, attachments, and voice notes
 * into dedicated sidecar tables for rich querying.
 */

import type { Database } from "bun:sqlite";
import { addMessage } from "../qmd";
import {
  upsertSessionMeta,
  insertArtifact,
  insertThinking,
  insertAttachment,
  insertVoiceNote,
} from "../db";
import type { IngestResult, IngestOptions } from "./index";

// =============================================================================
// Types — Claude.ai export format
// =============================================================================

export type ClaudeWebConversation = {
  uuid: string;
  name: string;
  summary: string;
  created_at: string;
  updated_at: string;
  account?: { uuid: string };
  chat_messages: ClaudeWebMessage[];
};

export type ClaudeWebMessage = {
  uuid: string;
  text: string;
  content: ClaudeWebContentBlock[];
  sender: "human" | "assistant";
  created_at: string;
  updated_at: string;
  attachments: ClaudeWebAttachment[];
  files: { file_name: string }[];
};

export type ClaudeWebContentBlock =
  | ClaudeWebTextBlock
  | ClaudeWebToolUseBlock
  | ClaudeWebToolResultBlock
  | ClaudeWebThinkingBlock
  | ClaudeWebVoiceNoteBlock
  | ClaudeWebTokenBudgetBlock;

export type ClaudeWebTextBlock = {
  type: "text";
  text: string;
};

export type ClaudeWebToolUseBlock = {
  type: "tool_use";
  name: string;
  id: string | null;
  input: {
    id?: string;
    type?: string;
    title?: string;
    command?: string;
    content?: string;
    language?: string;
    version_uuid?: string;
    old_str?: string;
    new_str?: string;
  };
};

export type ClaudeWebToolResultBlock = {
  type: "tool_result";
  tool_use_id: string | null;
  name: string;
  content: Array<{ type: string; text: string }>;
  is_error: boolean;
};

export type ClaudeWebThinkingBlock = {
  type: "thinking";
  thinking: string;
};

export type ClaudeWebVoiceNoteBlock = {
  type: "voice_note";
  title: string;
  text: string;
};

export type ClaudeWebTokenBudgetBlock = {
  type: "token_budget";
  [key: string]: unknown;
};

export type ClaudeWebAttachment = {
  file_name: string;
  file_type: string;
  file_size: number;
  extracted_content?: string;
};

// =============================================================================
// Content extraction
// =============================================================================

/**
 * Extract plain text from a message's content blocks.
 * Combines text blocks, artifact titles, and voice note transcripts.
 */
function extractPlainText(msg: ClaudeWebMessage): string {
  const parts: string[] = [];

  // The top-level `text` field is often a summary/preview
  if (msg.text) {
    parts.push(msg.text);
    return parts.join("\n");
  }

  for (const block of msg.content || []) {
    switch (block.type) {
      case "text":
        if (block.text) parts.push(block.text);
        break;
      case "tool_use":
        // Include artifact title for searchability
        if (block.input?.title) {
          parts.push(`[Artifact: ${block.input.title}]`);
        }
        break;
      case "voice_note":
        if (block.text) parts.push(block.text);
        break;
    }
  }

  return parts.join("\n").trim();
}

// =============================================================================
// Parse + Ingest
// =============================================================================

/**
 * Parse a conversations.json file and ingest into the memory database.
 */
export async function ingestClaudeWeb(
  db: Database,
  filePath: string,
  options: IngestOptions = {}
): Promise<IngestResult> {
  const { existingSessionIds, onProgress } = options;

  const result: IngestResult = {
    agent: "claude-web",
    sessionsFound: 0,
    sessionsIngested: 0,
    messagesIngested: 0,
    skipped: 0,
    errors: [],
  };

  // Read and parse the JSON file
  let conversations: ClaudeWebConversation[];
  try {
    const file = Bun.file(filePath);
    const raw = await file.text();
    conversations = JSON.parse(raw);
  } catch (err: any) {
    result.errors.push(`Failed to read ${filePath}: ${err.message}`);
    return result;
  }

  if (!Array.isArray(conversations)) {
    result.errors.push(`Expected array in ${filePath}, got ${typeof conversations}`);
    return result;
  }

  result.sessionsFound = conversations.length;

  for (const conv of conversations) {
    // Dedup by UUID
    if (existingSessionIds?.has(conv.uuid)) {
      result.skipped++;
      continue;
    }

    if (!conv.chat_messages?.length) {
      result.skipped++;
      continue;
    }

    try {
      const sessionId = conv.uuid;
      const title = conv.name || "";

      let msgCount = 0;

      for (const msg of conv.chat_messages) {
        const role = msg.sender === "human" ? "user" : "assistant";
        const plainText = extractPlainText(msg);

        if (!plainText.trim() && !msg.attachments?.length && !msg.content?.length) {
          continue;
        }

        // Store via QMD's addMessage
        const stored = await addMessage(
          db,
          sessionId,
          role,
          plainText || "(structured content)",
          { title }
        );

        const messageId = stored.id;
        const createdAt = msg.created_at || conv.created_at;

        // Extract content blocks into sidecar tables
        for (const block of msg.content || []) {
          switch (block.type) {
            case "tool_use": {
              // Artifact (both creates and updates)
              if (block.name === "artifacts") {
                insertArtifact(
                  db,
                  messageId,
                  sessionId,
                  block.input?.id || null,
                  block.input?.type || null,
                  block.input?.title || null,
                  block.input?.command || null,
                  block.input?.language || null,
                  block.input?.content || null,
                  createdAt
                );
              }
              break;
            }

            case "thinking": {
              if (block.thinking?.trim()) {
                insertThinking(db, messageId, sessionId, block.thinking, createdAt);
              }
              break;
            }

            case "voice_note": {
              if (block.text?.trim()) {
                insertVoiceNote(
                  db,
                  messageId,
                  sessionId,
                  block.title || null,
                  block.text,
                  createdAt
                );
              }
              break;
            }
          }
        }

        // Extract attachments
        for (const att of msg.attachments || []) {
          insertAttachment(
            db,
            messageId,
            sessionId,
            att.file_name || null,
            att.file_type || null,
            att.file_size || null,
            att.extracted_content || null,
            createdAt
          );
        }

        msgCount++;
      }

      // Attach Smriti session metadata
      upsertSessionMeta(db, sessionId, "claude-web");

      result.sessionsIngested++;
      result.messagesIngested += msgCount;

      if (onProgress) {
        onProgress(`Ingested "${title || sessionId}" (${msgCount} messages)`);
      }
    } catch (err: any) {
      result.errors.push(`${conv.uuid}: ${err.message}`);
    }
  }

  return result;
}

// =============================================================================
// Memory import
// =============================================================================

export type MemoryExport = Array<{
  conversations_memory: string;
  project_memories: Record<string, string>;
  account_uuid: string;
}>;

/**
 * Import memories.json as a special session.
 */
export async function ingestClaudeWebMemories(
  db: Database,
  filePath: string,
  options: IngestOptions = {}
): Promise<IngestResult> {
  const result: IngestResult = {
    agent: "claude-web",
    sessionsFound: 0,
    sessionsIngested: 0,
    messagesIngested: 0,
    skipped: 0,
    errors: [],
  };

  let memories: MemoryExport;
  try {
    const file = Bun.file(filePath);
    memories = JSON.parse(await file.text());
  } catch (err: any) {
    result.errors.push(`Failed to read ${filePath}: ${err.message}`);
    return result;
  }

  if (!Array.isArray(memories) || memories.length === 0) {
    result.errors.push("No memories found");
    return result;
  }

  const mem = memories[0];
  const sessionId = `claude-web-memory-${mem.account_uuid || "default"}`;

  if (options.existingSessionIds?.has(sessionId)) {
    result.skipped = 1;
    result.sessionsFound = 1;
    return result;
  }

  result.sessionsFound = 1;

  try {
    let msgCount = 0;

    // Conversation-level memory
    if (mem.conversations_memory?.trim()) {
      await addMessage(db, sessionId, "assistant", mem.conversations_memory, {
        title: "Claude.ai Memories",
      });
      msgCount++;
    }

    // Project-level memories
    for (const [projectId, memory] of Object.entries(mem.project_memories || {})) {
      if (memory?.trim()) {
        await addMessage(db, sessionId, "assistant", memory, {
          title: `Claude.ai Project Memory: ${projectId}`,
        });
        msgCount++;
      }
    }

    upsertSessionMeta(db, sessionId, "claude-web");

    result.sessionsIngested = 1;
    result.messagesIngested = msgCount;

    if (options.onProgress) {
      options.onProgress(`Imported ${msgCount} memory entries`);
    }
  } catch (err: any) {
    result.errors.push(`memories: ${err.message}`);
  }

  return result;
}
