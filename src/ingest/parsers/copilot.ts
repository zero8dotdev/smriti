import { parseCopilotJson } from "../copilot";
import type { ParsedSession } from "./types";

export async function parseCopilot(
  sessionPath: string,
  sessionId: string
): Promise<ParsedSession> {
  const content = await Bun.file(sessionPath).text();
  const messages = parseCopilotJson(content);
  const firstUser = messages.find((m) => m.role === "user");

  return {
    session: {
      id: sessionId,
      title: firstUser ? firstUser.content.slice(0, 100).replace(/\n/g, " ") : "Copilot Chat",
      created_at: messages[0]?.timestamp || new Date().toISOString(),
    },
    messages,
    metadata: {},
  };
}
