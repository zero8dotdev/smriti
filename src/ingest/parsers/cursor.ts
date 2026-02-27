import { parseCursorJson } from "../cursor";
import type { ParsedSession } from "./types";

export async function parseCursor(
  sessionPath: string,
  sessionId: string
): Promise<ParsedSession> {
  const content = await Bun.file(sessionPath).text();
  const messages = parseCursorJson(content);
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
