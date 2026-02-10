/**
 * team/formatter.ts - Documentation formatter for .smriti/ knowledge export
 *
 * Transforms raw chat transcripts into clean, readable documentation
 * by stripping noise (XML tags, interrupt markers, API errors, narration)
 * and formatting as structured markdown.
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
// Reflection type (imported from reflect.ts at runtime, defined here to avoid
// circular deps)
// =============================================================================

export type Reflection = {
  learnings: string;
  keyTakeaway: string;
  teamContext: string;
  changesMade: string;
  discovery: string;
};

// =============================================================================
// Document formatting
// =============================================================================

/** Format a reflection block as markdown */
function formatReflectionBlock(reflection: Reflection): string {
  const sections: string[] = [];

  if (reflection.learnings) {
    sections.push(`**Learnings:** ${reflection.learnings}`);
  }
  if (reflection.keyTakeaway) {
    sections.push(`**Key Takeaway:** ${reflection.keyTakeaway}`);
  }
  if (reflection.teamContext) {
    sections.push(`**Team Context:** ${reflection.teamContext}`);
  }
  if (reflection.changesMade) {
    sections.push(`**Changes Made:** ${reflection.changesMade}`);
  }
  if (reflection.discovery) {
    sections.push(`**Discovery:** ${reflection.discovery}`);
  }

  if (sections.length === 0) return "";

  return sections.join("\n\n");
}

export type FormatOptions = {
  reflection?: Reflection | null;
};

/** Format filtered messages as a documentation markdown document */
export function formatAsDocument(
  title: string,
  summary: string | null | undefined,
  messages: CleanMessage[],
  options: FormatOptions = {}
): string {
  const lines: string[] = [];

  lines.push(`# ${title}`);
  lines.push("");

  if (summary) {
    lines.push(`> ${summary}`);
    lines.push("");
  }

  // Insert reflection block after summary, before conversation
  if (options.reflection) {
    const reflectionBlock = formatReflectionBlock(options.reflection);
    if (reflectionBlock) {
      lines.push(reflectionBlock);
      lines.push("");
      lines.push("---");
      lines.push("");
    }
  }

  for (const msg of messages) {
    if (msg.role === "user") {
      // User messages become headings
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
      // Assistant messages are body text
      lines.push(msg.content);
      lines.push("");
    }
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// =============================================================================
// Main entry points
// =============================================================================

/** Full pipeline: filter → merge → derive title → format */
export function formatSessionAsDocument(
  sessionTitle: string | null | undefined,
  summary: string | null | undefined,
  rawMessages: RawMessage[],
  options: FormatOptions = {}
): { title: string; body: string } {
  const filtered = filterMessages(rawMessages);
  const merged = mergeConsecutive(filtered);
  const title = deriveTitle(sessionTitle, merged);
  const body = formatAsDocument(title, summary, merged, options);

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
