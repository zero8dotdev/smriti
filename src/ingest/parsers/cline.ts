import type { StructuredMessage, MessageMetadata, MessageBlock } from "../types";
import type { ParsedSession } from "./types";

type ClineTask = {
  id: string;
  parentId?: string;
  name: string;
  timestamp: string;
  cwd?: string;
  gitBranch?: string;
  history: Array<{
    ts: string;
    type: "say" | "ask" | "tool" | "tool_code" | "tool_result" | "command" | "command_output" | "system_event" | "error";
    text?: string;
    question?: string;
    options?: string;
    toolId?: string;
    toolName?: string;
    input?: Record<string, unknown>;
    output?: string;
    success?: boolean;
    error?: string;
    durationMs?: number;
    command?: string;
    cwd?: string;
    isGit?: boolean;
    exitCode?: number;
  }>;
};

function parseTask(task: ClineTask): StructuredMessage[] {
  const messages: StructuredMessage[] = [];
  let sequence = 0;

  for (const entry of task.history) {
    const metadata: MessageMetadata = {};
    if (task.cwd) metadata.cwd = task.cwd;
    if (task.gitBranch) metadata.gitBranch = task.gitBranch;
    if (task.parentId) metadata.parentId = task.parentId;

    let role: StructuredMessage["role"] = "assistant";
    let plainText = "";
    let blocks: MessageBlock[] = [];

    switch (entry.type) {
      case "say":
        blocks = [{ type: "text", text: entry.text || "" }];
        plainText = entry.text || "";
        role = "assistant";
        break;
      case "ask":
        blocks = [{ type: "text", text: `User asked: ${entry.question || ""} (Options: ${entry.options || ""})` }];
        plainText = `User asked: ${entry.question || ""}`;
        role = "user";
        break;
      case "tool":
      case "tool_code":
        blocks = [{
          type: "tool_call",
          toolId: entry.toolId || "unknown_tool",
          toolName: entry.toolName || "Unknown Tool",
          input: entry.input || {},
          description: entry.text,
        }];
        plainText = `Tool Call: ${entry.toolName || "Unknown Tool"}`;
        role = "assistant";
        break;
      case "tool_result":
        blocks = [{
          type: "tool_result",
          toolId: entry.toolId || "unknown_tool",
          success: entry.success ?? true,
          output: entry.output || "",
          error: entry.error,
          durationMs: entry.durationMs,
        }];
        plainText = `Tool Result: ${entry.output || entry.error || ""}`;
        role = "tool";
        break;
      case "command":
        blocks = [{
          type: "command",
          command: entry.command || "",
          cwd: entry.cwd || task.cwd,
          isGit: entry.isGit ?? false,
          description: entry.text,
        }];
        plainText = `Command: ${entry.command || ""}`;
        role = "assistant";
        break;
      case "command_output":
        blocks = [{
          type: "command",
          command: entry.command || "",
          stdout: entry.output,
          stderr: entry.error,
          exitCode: entry.exitCode,
          isGit: entry.isGit ?? false,
        }];
        plainText = `Command Output: ${entry.output || entry.error || ""}`;
        role = "tool";
        break;
      case "system_event":
        blocks = [{ type: "system_event", eventType: "turn_duration", data: { durationMs: entry.durationMs } }];
        plainText = `System Event: ${entry.durationMs || 0}ms`;
        role = "system";
        break;
      case "error":
        blocks = [{ type: "error", errorType: "tool_failure", message: entry.error || "Unknown error" }];
        plainText = `Error: ${entry.error || "Unknown error"}`;
        role = "system";
        break;
    }

    messages.push({
      id: `${task.id}-${sequence}`,
      sessionId: task.id,
      sequence,
      timestamp: entry.ts || new Date().toISOString(),
      role,
      agent: "cline",
      blocks,
      metadata,
      plainText,
    });

    sequence++;
  }

  return messages;
}

export async function parseCline(
  sessionPath: string,
  sessionId: string
): Promise<ParsedSession> {
  const content = await Bun.file(sessionPath).text();
  const task = JSON.parse(content) as ClineTask;
  const messages = parseTask(task);

  return {
    session: {
      id: sessionId,
      title: task.name || messages[0]?.plainText.slice(0, 100).replace(/\n/g, " ") || "",
      created_at: task.timestamp || messages[0]?.timestamp || new Date().toISOString(),
    },
    messages,
    metadata: {},
  };
}
