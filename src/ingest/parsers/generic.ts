import type { ParsedSession } from "./types";
import { basename } from "path";

export async function parseGeneric(
  sessionPath: string,
  sessionId: string,
  format: "chat" | "jsonl" | "document" = "chat"
): Promise<ParsedSession> {
  const content = await Bun.file(sessionPath).text();
  const messages: Array<{ role: string; content: string; timestamp?: string }> = [];

  if (format === "jsonl") {
    for (const line of content.split("\n").filter((l) => l.trim())) {
      const parsed = JSON.parse(line);
      messages.push({ role: parsed.role || "user", content: parsed.content || "" });
    }
  } else if (format === "document") {
    // Store entire file as a single user message
    messages.push({ role: "user", content: content.trim() });
  } else {
    const blocks = content.split(/\n\n+/);
    for (const block of blocks) {
      const trimmed = block.trim();
      if (!trimmed) continue;
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx > 0 && colonIdx < 20) {
        messages.push({
          role: trimmed.slice(0, colonIdx).trim().toLowerCase(),
          content: trimmed.slice(colonIdx + 1).trim(),
        });
      } else {
        messages.push({ role: "user", content: trimmed });
      }
    }
  }

  let title = "";
  if (format === "document") {
    // Extract title from first # heading, or use filename
    const headingMatch = content.match(/^# (.+)/m);
    title = headingMatch ? headingMatch[1] : basename(sessionPath);
  } else {
    const firstUser = messages.find((m) => m.role === "user");
    title = firstUser ? firstUser.content.slice(0, 100).replace(/\n/g, " ") : "";
  }

  return {
    session: {
      id: sessionId,
      title,
      created_at: messages[0]?.timestamp || new Date().toISOString(),
    },
    messages,
    metadata: {},
  };
}
