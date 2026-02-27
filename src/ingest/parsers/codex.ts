import { parseCodexJsonl } from "../codex";
import type { ParsedSession } from "./types";

export async function parseCodex(
  sessionPath: string,
  sessionId: string
): Promise<ParsedSession> {
  const content = await Bun.file(sessionPath).text();
  const messages = parseCodexJsonl(content);
  const firstUser = messages.find((m) => m.role === "user");

  return {
    session: {
      id: sessionId,
      title: firstUser ? firstUser.content.slice(0, 100).replace(/\n/g, " ") : "",
      created_at: messages[0]?.timestamp || new Date().toISOString(),
    },
    messages,
    metadata: {},
  };
}
