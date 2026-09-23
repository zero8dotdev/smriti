/**
 * parsers/grok.ts - Grok Build conversation parser.
 *
 * Reads `updates.jsonl` (ACP session/update events) and emits one
 * StructuredMessage per user turn, assistant text, tool call, and tool
 * result. Streamed chunks are concatenated. In-progress tool updates and
 * scrollback-hidden prompts are dropped.
 */

import { join } from "path";
import { parseGitCommand } from "../blocks";
import { STORAGE_LIMITS, type MessageBlock, type MessageMetadata, type StructuredMessage } from "../types";
import type { ParsedSession } from "./types";

type GrokSummary = {
  generated_title?: string;
  session_summary?: string;
  created_at?: string;
  current_model_id?: string;
};

type GrokEvent = {
  timestamp?: number;
  params?: {
    update?: Record<string, unknown>;
    _meta?: { agentTimestampMs?: number };
  };
};

function eventTime(ev: GrokEvent): string {
  const ms = ev.params?._meta?.agentTimestampMs;
  if (typeof ms === "number") return new Date(ms).toISOString();
  if (typeof ev.timestamp === "number") {
    const millis = ev.timestamp < 1e12 ? ev.timestamp * 1000 : ev.timestamp;
    return new Date(millis).toISOString();
  }
  return new Date().toISOString();
}

function unwrapUser(text: string): string {
  const match = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
  return (match ? match[1] : text).trim();
}

function clip(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) : text;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toolName(update: Record<string, unknown>): string {
  const meta = asRecord(asRecord(update._meta)["x.ai/tool"]);
  if (typeof meta.name === "string" && meta.name) return meta.name;
  if (typeof update.title === "string" && update.title) return update.title;
  return "tool";
}

function toolKind(update: Record<string, unknown>): string {
  const meta = asRecord(asRecord(update._meta)["x.ai/tool"]);
  return typeof meta.kind === "string" ? meta.kind : "";
}

function toolOutput(update: Record<string, unknown>): { text: string; diff?: { path: string; oldText: string; newText: string } } {
  const parts: string[] = [];
  let diff: { path: string; oldText: string; newText: string } | undefined;
  const content = update.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      const block = asRecord(item);
      if (block.type === "content") {
        const inner = block.content;
        if (typeof inner === "string") parts.push(inner);
        else if (typeof asRecord(inner).text === "string") parts.push(asRecord(inner).text as string);
      } else if (block.type === "diff") {
        const path = typeof block.path === "string" ? block.path : "";
        const oldText = typeof block.oldText === "string" ? block.oldText : "";
        const newText = typeof block.newText === "string" ? block.newText : "";
        diff = { path, oldText, newText };
        parts.push(path);
      }
    }
  }
  if (parts.length === 0 && update.rawOutput != null) {
    parts.push(
      typeof update.rawOutput === "string" ? update.rawOutput : JSON.stringify(update.rawOutput)
    );
  }
  return { text: parts.join("\n"), diff };
}

function specializedBlocks(
  name: string,
  kind: string,
  input: Record<string, unknown>
): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  const path =
    (typeof input.target_file === "string" && input.target_file) ||
    (typeof input.file_path === "string" && input.file_path) ||
    (typeof input.path === "string" && input.path) ||
    "";
  const command = typeof input.command === "string" ? input.command : "";

  if (kind === "read" && path) {
    blocks.push({ type: "file_op", operation: "read", path });
  } else if (kind === "edit" && path) {
    blocks.push({ type: "file_op", operation: "edit", path });
  } else if (kind === "execute" && command) {
    const isGit = /^\s*git\b/.test(command);
    blocks.push({
      type: "command",
      command: clip(command, STORAGE_LIMITS.toolInput),
      description: typeof input.description === "string" ? input.description : undefined,
      isGit,
    });
    if (isGit) {
      const git = parseGitCommand(command);
      if (git) blocks.push(git);
    }
  } else if (kind === "search") {
    const pattern =
      (typeof input.pattern === "string" && input.pattern) ||
      (typeof input.query === "string" && input.query) ||
      name;
    blocks.push({ type: "search", searchType: "grep", pattern, path: path || undefined });
  } else if (kind === "fetch") {
    const url = typeof input.url === "string" ? input.url : path;
    blocks.push({ type: "search", searchType: "web_fetch", pattern: url || name, url: url || undefined });
  }

  return blocks;
}

export function parseGrokUpdates(
  content: string,
  sessionId: string,
  summary: GrokSummary = {}
): StructuredMessage[] {
  const messages: StructuredMessage[] = [];
  let sequence = 0;
  const finishedTools = new Set<string>();
  let userParts: string[] = [];
  let userTs: string | undefined;
  let thoughtParts: string[] = [];
  let textParts: string[] = [];
  let textTs: string | undefined;
  let model = summary.current_model_id;

  const emit = (
    role: StructuredMessage["role"],
    blocks: MessageBlock[],
    plainText: string,
    timestamp: string | undefined,
    metadata: MessageMetadata = {}
  ) => {
    if (!plainText.trim() && blocks.length === 0) return;
    if (model) metadata.model = model;
    messages.push({
      id: `${sessionId}-${sequence}`,
      sessionId,
      sequence,
      timestamp: timestamp || new Date().toISOString(),
      role,
      agent: "grok",
      blocks,
      metadata,
      plainText: clip(plainText, STORAGE_LIMITS.textBlock),
    });
    sequence++;
  };

  const flushUser = () => {
    const text = unwrapUser(userParts.join(""));
    const ts = userTs;
    userParts = [];
    userTs = undefined;
    if (!text) return;
    emit("user", [{ type: "text", text: clip(text, STORAGE_LIMITS.textBlock) }], text, ts);
  };

  const flushAssistant = () => {
    const thinking = thoughtParts.join("").trim();
    const text = textParts.join("").trim();
    const ts = textTs;
    thoughtParts = [];
    textParts = [];
    textTs = undefined;
    if (!thinking && !text) return;
    const blocks: MessageBlock[] = [];
    if (thinking) {
      blocks.push({ type: "thinking", thinking: clip(thinking, STORAGE_LIMITS.thinkingBlock) });
    }
    if (text) blocks.push({ type: "text", text: clip(text, STORAGE_LIMITS.textBlock) });
    emit("assistant", blocks, text, ts);
  };

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let ev: GrokEvent;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const update = ev.params?.update;
    if (!update) continue;
    const kind = update.sessionUpdate;
    const ts = eventTime(ev);

    if (kind === "user_message_chunk") {
      if (asRecord(update._meta).hideFromScrollback) continue;
      flushAssistant();
      const text = asRecord(update.content).text;
      if (typeof text === "string" && text) {
        userParts.push(text);
        userTs = userTs || ts;
      }
      const modelId = asRecord(update._meta).modelId;
      if (typeof modelId === "string") model = modelId;
      continue;
    }

    if (kind === "agent_thought_chunk") {
      flushUser();
      const text = asRecord(update.content).text;
      if (typeof text === "string" && text) thoughtParts.push(text);
      textTs = textTs || ts;
      continue;
    }

    if (kind === "agent_message_chunk") {
      flushUser();
      const text = asRecord(update.content).text;
      if (typeof text === "string" && text) textParts.push(text);
      textTs = textTs || ts;
      continue;
    }

    if (kind === "tool_call") {
      flushUser();
      flushAssistant();
      const name = toolName(update);
      const input = asRecord(update.rawInput);
      const id = typeof update.toolCallId === "string" ? update.toolCallId : `tool-${sequence}`;
      const blocks: MessageBlock[] = [
        ...specializedBlocks(name, toolKind(update), input),
        {
          type: "tool_call",
          toolId: id,
          toolName: name,
          input,
          description: typeof update.title === "string" ? update.title : undefined,
        },
      ];
      emit("assistant", blocks, name, ts);
      continue;
    }

    if (kind === "tool_call_update") {
      const status = update.status;
      if (status !== "completed" && status !== "failed") continue;
      const id = typeof update.toolCallId === "string" ? update.toolCallId : "";
      if (!id || finishedTools.has(id)) continue;
      finishedTools.add(id);
      flushUser();
      flushAssistant();
      const output = toolOutput(update);
      const text = clip(output.text, STORAGE_LIMITS.fileContent);
      const blocks: MessageBlock[] = [
        {
          type: "tool_result",
          toolId: id,
          success: status === "completed",
          output: text,
          error: status === "failed" ? clip(output.text, STORAGE_LIMITS.commandOutput) : undefined,
        },
      ];
      if (output.diff?.path) {
        blocks.push({
          type: "file_op",
          operation: "edit",
          path: output.diff.path,
          diff: clip(`${output.diff.oldText}\n---\n${output.diff.newText}`, STORAGE_LIMITS.fileContent),
        });
      }
      const name = toolName(update);
      emit("tool", blocks, text ? `${name}: ${text}` : name, ts);
      continue;
    }

    if (kind === "turn_completed") {
      flushUser();
      flushAssistant();
      const usage = asRecord(update.usage);
      const last = messages[messages.length - 1];
      if (!last) continue;
      const input = typeof usage.inputTokens === "number" ? usage.inputTokens : 0;
      const output = typeof usage.outputTokens === "number" ? usage.outputTokens : 0;
      if (input || output) {
        last.metadata.tokenUsage = {
          input,
          output,
          cacheCreate: typeof usage.cacheCreationTokens === "number" ? usage.cacheCreationTokens : undefined,
          cacheRead: typeof usage.cachedReadTokens === "number" ? usage.cachedReadTokens : undefined,
        };
      }
      const elapsed = typeof update.elapsed_ms === "number" ? update.elapsed_ms : undefined;
      if (typeof elapsed === "number") {
        last.blocks.push({ type: "system_event", eventType: "turn_duration", data: { durationMs: elapsed } });
      }
      continue;
    }

    if (kind === "subagent_finished") {
      flushUser();
      flushAssistant();
      const output = typeof update.output === "string" ? update.output.trim() : "";
      const description = typeof update.description === "string" ? update.description : "subagent";
      if (!output) continue;
      const text = clip(`${description}\n${output}`, STORAGE_LIMITS.textBlock);
      emit("assistant", [{ type: "text", text }], text, ts);
    }
  }

  flushUser();
  flushAssistant();
  return messages;
}

export async function parseGrok(sessionPath: string, sessionId: string): Promise<ParsedSession> {
  const content = await Bun.file(sessionPath).text();
  let summary: GrokSummary = {};
  try {
    summary = JSON.parse(await Bun.file(join(sessionPath, "..", "summary.json")).text());
  } catch {
    summary = {};
  }
  const messages = parseGrokUpdates(content, sessionId, summary);
  const firstUser = messages.find((m) => m.role === "user");
  const title =
    summary.generated_title ||
    summary.session_summary ||
    (firstUser ? firstUser.plainText.slice(0, 100).replace(/\n/g, " ") : "");

  return {
    session: {
      id: sessionId,
      title,
      created_at: summary.created_at || messages[0]?.timestamp || new Date().toISOString(),
    },
    messages,
    metadata: {},
  };
}
