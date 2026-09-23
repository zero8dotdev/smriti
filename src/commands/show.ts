/**
 * Show command implementation - display session messages.
 * Based on real behavior from ../index.ts case "show":
 *   - One required positional: session-id
 *   - Optional flags: --limit <number>, --json
 *   - Fetches session metadata and messages
 *   - Displays session info header (title/id, created_at, summary)
 *   - Lists messages with role and content
 *   - Supports --json output for messages array
 *
 * Blueprint pattern: backend injection for session/message retrieval,
 * defaulting to safe simulations (no real DB access).
 */

import { BaseCommand, CommandError } from "../command";
import type { ParsedArgs, CommandContext } from "../command";
import type { ArgSpec, FlagSpec, Example } from "../help/types";
import type { Database } from "bun:sqlite";
import { getSession as qmdGetSession, getMessages as qmdGetMessages } from "../qmd";

export interface SessionInfo {
  id: string;
  title: string | null;
  created_at: string;
  summary: string | null;
}

export interface Message {
  role: string;
  content: string;
}

export interface ShowResult {
  session: SessionInfo;
  messageCount: number;
  messages: Message[];
}

export interface ShowBackend {
  /** Retrieves session info by ID. Returns null if not found. */
  getSession(sessionId: string): SessionInfo | null;
  /** Retrieves messages for a session, optionally limited. */
  getMessages(sessionId: string, options?: { limit?: number }): Message[];
}

const simulateBackend: ShowBackend = {
  getSession(sessionId: string): SessionInfo | null {
    // Simulate a session found
    if (sessionId === "not-found") return null;
    return {
      id: sessionId,
      title: `Session: ${sessionId}`,
      created_at: "2026-08-06T10:00:00Z",
      summary: "A sample session for testing",
    };
  },
  getMessages(sessionId: string, options?: { limit?: number }): Message[] {
    // Simulate some messages
    const allMessages: Message[] = [
      { role: "user", content: "What is Smriti?" },
      { role: "assistant", content: "Smriti is a unified memory layer for AI agents." },
      { role: "user", content: "How do I use it?" },
      { role: "assistant", content: "Run 'smriti help' to see available commands." },
    ];
    const limit = options?.limit;
    return limit ? allMessages.slice(0, limit) : allMessages;
  },
};

/**
 * Real backend, backed by the shared sqlite Database handle opened once in
 * main() and threaded through every case block in ../index.ts.
 *
 * Mirrors ../index.ts case "show" exactly:
 *   - getSession   -> getSession(db, sessionId)              from ../qmd (re-exports ../memory)
 *   - getMessages  -> getMessages(db, sessionId, { limit })  from ../qmd (re-exports ../memory)
 *
 * The real getSession/getMessages return the wider MemorySession /
 * MemoryMessage[] shapes (extra fields: updated_at, summary_at, active on
 * sessions; id, session_id, hash, metadata on messages) - these are
 * structurally assignable to this file's narrower SessionInfo / Message
 * interfaces as-is, so no field-mapping/conversion is needed in the factory.
 *
 * Not wired into any default constructor param - callers must opt in
 * explicitly via createRealShowBackend(db).
 */
export function createRealShowBackend(db: Database): ShowBackend {
  return {
    getSession(sessionId: string): SessionInfo | null {
      return qmdGetSession(db, sessionId);
    },
    getMessages(sessionId: string, options?: { limit?: number }): Message[] {
      return qmdGetMessages(db, sessionId, options);
    },
  };
}

export class ShowCommand extends BaseCommand<ShowResult> {
  constructor(private readonly backend: ShowBackend = simulateBackend) {
    super();
  }

  name = "show";
  summary = "Show session messages";
  args: ArgSpec[] = [
    {
      name: "session-id",
      type: "string",
      required: true,
      description: "session to display",
    },
  ];
  flags: FlagSpec[] = [
    { flag: "--limit", type: "number", description: "max messages to show (default: all)" },
    { flag: "--json", type: "boolean", description: "output messages as JSON array" },
  ];
  output = {
    description:
      "session metadata (title, created_at, summary) followed by messages with role and content",
    jsonShape: "{ session: { id, title, created_at, summary }, messageCount: number, messages: Array<{role, content}> }",
  };
  examples: [Example, Example, Example] = [
    {
      command: "smriti show sess1",
      description: "display all messages from a session with header info",
    },
    {
      command: "smriti show sess1 --limit 5",
      description: "display the first 5 messages from a session",
    },
    {
      command: "smriti show sess1 --json",
      description: "display messages as a JSON array",
    },
  ];
  detailedSummary =
    "Displays a session's metadata (title, created_at, optional summary) followed by its message history. " +
    "Each message shows the speaker role (user, assistant, etc.) and content. Use --limit to show only the first N messages, " +
    "or --json to output messages as a machine-readable array.";

  protected async execute(parsed: ParsedArgs): Promise<ShowResult> {
    const sessionId = parsed.positionals[0];
    const limit = parsed.flags["--limit"] ? Number(parsed.flags["--limit"]) : undefined;

    // Fetch session info
    const session = this.backend.getSession(sessionId);
    if (!session) {
      throw new CommandError(`Session not found: ${sessionId}`, "NOT_FOUND", {
        sessionId,
      });
    }

    // Fetch messages
    const messages = this.backend.getMessages(sessionId, { limit });

    return {
      session,
      messageCount: messages.length,
      messages,
    };
  }
}
