/**
 * team/formatter.ts - Sanitization and fallback formatting for knowledge export
 *
 * Strips noise from raw chat transcripts (XML tags, interrupt markers, API
 * errors, narration). Provides a fallback conversation-based format when
 * LLM synthesis is unavailable.
 */

// =============================================================================
// Types
// =============================================================================

export type RawMessage = {
  role: string;
  content: string;
};

export type CleanMessage = {
  role: string;
  content: string;
};

// =============================================================================
// Sanitization
// =============================================================================

/** Strip noise patterns from message content */
export function sanitizeContent(content: string): string {
  let s = content;

  // Remove XML block tags (multiline)
  s = s.replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "");
  s = s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");

  // Remove inline XML tags
  s = s.replace(/<command-message>[\s\S]*?<\/command-message>/g, "");
  s = s.replace(/<command-name>[\s\S]*?<\/command-name>/g, "");

  // Remove interrupt markers
  s = s.replace(/\[Request interrupted by user(?:\s+for tool use)?\]/g, "");

  // Remove "Read the output file..." lines with tmp paths
  s = s.replace(/Read the output file.*\/private\/tmp\/.*$/gm, "");
  s = s.replace(/Read the output file.*\/tmp\/.*$/gm, "");

  // Remove API error lines
  s = s.replace(/^API Error:.*$/gm, "");

  // Remove rate limit messages
  s = s.replace(/^Rate limit.*$/gim, "");

  // Clean up residual whitespace
  s = s.replace(/\n{3,}/g, "\n\n");
  s = s.trim();

  return s;
}

// =============================================================================
// Message filtering
// =============================================================================

/** Patterns for short assistant narration that adds no value */
const NARRATION_PATTERNS = [
  /^(?:let me |now let me |i'll |let me now )/i,
  /^(?:now i |good,? i |perfect!? (?:let|i'll|now))/i,
  /^(?:standing by|one moment|looking|checking|reading|searching)/i,
  /^(?:i'm going to |i need to |i have all |i found )/i,
];

/** Check if a message should be dropped entirely */
export function shouldDropMessage(role: string, content: string): boolean {
  const cleaned = sanitizeContent(content);

  // Empty or whitespace-only after sanitization
  if (!cleaned || !cleaned.trim()) return true;

  // Bare commands
  if (/^(clear|quit|exit|\d)$/i.test(cleaned.trim())) return true;

  // Short assistant narration (only when < 200 chars to avoid false positives)
  if (role === "assistant" && cleaned.length < 200) {
    for (const pattern of NARRATION_PATTERNS) {
      if (pattern.test(cleaned.trim())) return true;
    }
  }

  return false;
}

/** Filter and sanitize raw messages */
export function filterMessages(raw: RawMessage[]): CleanMessage[] {
  const result: CleanMessage[] = [];

  for (const msg of raw) {
    if (shouldDropMessage(msg.role, msg.content)) continue;

    const cleaned = sanitizeContent(msg.content);
    if (cleaned) {
      result.push({ role: msg.role, content: cleaned });
    }
  }

  return result;
}

// =============================================================================
// Merging
// =============================================================================

/** Merge consecutive same-role messages into single messages */
export function mergeConsecutive(messages: CleanMessage[]): CleanMessage[] {
  if (messages.length === 0) return [];

  const merged: CleanMessage[] = [{ ...messages[0] }];

  for (let i = 1; i < messages.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = messages[i];

    if (curr.role === prev.role) {
      prev.content = prev.content + "\n\n" + curr.content;
    } else {
      merged.push({ ...curr });
    }
  }

  return merged;
}

// =============================================================================
// Title derivation
// =============================================================================

/** Derive a clean title from session title or first user message */
export function deriveTitle(
  sessionTitle: string | null | undefined,
  messages: CleanMessage[]
): string {
  // Try session title first
  if (sessionTitle) {
    let title = sanitizeContent(sessionTitle).trim();
    // Strip markdown heading prefix if present
    title = title.replace(/^#+\s*/, "");
    if (title && title.length > 3) return title;
  }

  // Fall back to first user message
  const firstUser = messages.find((m) => m.role === "user");
  if (firstUser) {
    // Use first line, truncated
    const firstLine = firstUser.content.split("\n")[0].trim();
    if (firstLine.length > 80) {
      return firstLine.slice(0, 77) + "...";
    }
    return firstLine;
  }

  return "Untitled Session";
}

// =============================================================================
// Fallback document formatting (used when LLM synthesis is unavailable)
// =============================================================================

/** Format filtered messages as a fallback markdown document */
export function formatAsFallbackDocument(
  title: string,
  summary: string | null | undefined,
  messages: CleanMessage[]
): string {
  const lines: string[] = [];

  lines.push(`# ${title}`);
  lines.push("");

  if (summary) {
    lines.push(`> ${summary}`);
    lines.push("");
  }

  for (const msg of messages) {
    if (msg.role === "user") {
      const msgLines = msg.content.split("\n");
      const heading = msgLines[0].replace(/^#+\s*/, "").trim();
      const body = msgLines.slice(1).join("\n").trim();

      lines.push(`## ${heading}`);
      lines.push("");
      if (body) {
        lines.push(body);
        lines.push("");
      }
    } else {
      lines.push(msg.content);
      lines.push("");
    }
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// =============================================================================
// Main entry points
// =============================================================================

/** Fallback pipeline: filter → merge → derive title → format as conversation */
export function formatSessionAsFallback(
  sessionTitle: string | null | undefined,
  summary: string | null | undefined,
  rawMessages: RawMessage[]
): { title: string; body: string } {
  const filtered = filterMessages(rawMessages);
  const merged = mergeConsecutive(filtered);
  const title = deriveTitle(sessionTitle, merged);
  const body = formatAsFallbackDocument(title, summary, merged);

  return { title, body };
}

/** Gate: check if a session has enough substance to be worth sharing */
export function isSessionWorthSharing(rawMessages: RawMessage[]): boolean {
  const filtered = filterMessages(rawMessages);

  const hasUser = filtered.some((m) => m.role === "user");
  const hasAssistant = filtered.some((m) => m.role === "assistant");

  if (!hasUser || !hasAssistant) return false;

  const totalLength = filtered.reduce((sum, m) => sum + m.content.length, 0);
  return totalLength > 100;
}
