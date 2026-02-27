import type { ParsedSession } from "./types";

export async function parseGeneric(
  sessionPath: string,
  sessionId: string,
  format: "chat" | "jsonl" = "chat"
): Promise<ParsedSession> {
  const content = await Bun.file(sessionPath).text();
  const messages: Array<{ role: string; content: string; timestamp?: string }> = [];

  if (format === "jsonl") {
    for (const line of content.split("\n").filter((l) => l.trim())) {
      const parsed = JSON.parse(line);
      messages.push({ role: parsed.role || "user", content: parsed.content || "" });
    }
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
