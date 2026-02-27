import { parseClaudeJsonlStructured } from "../claude";
import type { ParsedSession } from "./types";

export async function parseClaude(
  sessionPath: string,
  sessionId: string
): Promise<ParsedSession> {
  const content = await Bun.file(sessionPath).text();
  const messages = parseClaudeJsonlStructured(content);

  const firstUser = messages.find((m) => m.role === "user");
  const title = firstUser
    ? firstUser.plainText.slice(0, 100).replace(/\n/g, " ")
    : "";

  let totalTokens = 0;
  let totalDurationMs = 0;

  for (const msg of messages) {
    const u = msg.metadata.tokenUsage;
    if (u) {
      totalTokens += u.input + u.output + (u.cacheCreate || 0) + (u.cacheRead || 0);
    }

    for (const block of msg.blocks) {
      if (
        block.type === "system_event" &&
        block.eventType === "turn_duration" &&
        typeof block.data.durationMs === "number"
      ) {
        totalDurationMs += block.data.durationMs as number;
      }
    }
  }

  return {
    session: {
      id: sessionId,
      title,
      created_at: messages[0]?.timestamp || new Date().toISOString(),
    },
    messages,
    metadata: {
      total_tokens: totalTokens || undefined,
      total_duration_ms: totalDurationMs || undefined,
    },
  };
}
