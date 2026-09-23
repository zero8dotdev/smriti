/**
 * Real implementation of `compare` on the new blueprint (see the `compare`
 * case in ../index.ts). Blueprint only - no real DB is touched; session
 * metrics are injected via the backend, defaulting to a safe simulation.
 *
 * Supports two calling conventions:
 *   - `compare <session-a> <session-b>` - compare two specific sessions
 *   - `compare --last [--project <id>]` - compare the two most recent sessions
 *
 * This mirrors the real CLI's dual-mode pattern where the positional args
 * are required UNLESS --last is given - requiredUnless models this.
 */

import type { Database } from "bun:sqlite";
import { BaseCommand, type ParsedArgs, CommandError } from "../command";
import type { ArgSpec, FlagSpec, Example } from "../help/types";
import {
  resolveSessionId as realResolveSessionId,
  recentSessionIds as realRecentSessionIds,
  gatherSessionMetrics as realGatherSessionMetrics,
  detectProject as realDetectProject,
} from "../context";

export interface SessionMetrics {
  id: string;
  title: string;
  createdAt: string;
  turnCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  toolCalls: number;
  toolBreakdown: Record<string, number>;
  fileOps: number;
  fileReads: number;
  fileWrites: number;
  errors: number;
  durationMs: number;
}

export interface CompareResult {
  a: SessionMetrics;
  b: SessionMetrics;
  diff: {
    tokens: number;
    tokensPct: number;
    turns: number;
    turnsPct: number;
    toolCalls: number;
    toolCallsPct: number;
    fileReads: number;
    fileReadsPct: number;
  };
}

/** Injected backend seams - default simulations, no real DB access. */
export interface CompareBackend {
  /** Resolves a partial session ID to a full ID (prefix matching). */
  resolveSessionId(partial: string): string | null;
  /** Gets the N most recent session IDs for a project (or all if no project). */
  recentSessionIds(n: number, projectId?: string): string[];
  /** Gathers metrics for a single session. */
  gatherSessionMetrics(sessionId: string): SessionMetrics;
}

const simulateBackend: CompareBackend = {
  resolveSessionId(partial: string): string | null {
    // Simulate: if partial looks like a valid ID prefix, return a full mock ID
    if (partial.length >= 1) {
      return partial.padEnd(8, "0");
    }
    return null;
  },
  recentSessionIds(n: number, projectId?: string): string[] {
    // Simulate: return N mock session IDs
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      ids.push(`mock-sess-${String(i).padStart(4, "0")}`);
    }
    return ids;
  },
  gatherSessionMetrics(sessionId: string): SessionMetrics {
    // Simulate: return mock metrics for any session
    return {
      id: sessionId,
      title: `Session ${sessionId.slice(0, 8)}`,
      createdAt: new Date(Date.now() - Math.random() * 86400000).toISOString(),
      turnCount: Math.floor(Math.random() * 20) + 5,
      inputTokens: Math.floor(Math.random() * 50000) + 10000,
      outputTokens: Math.floor(Math.random() * 30000) + 5000,
      totalTokens: 0, // Will be computed in compareSessions
      toolCalls: Math.floor(Math.random() * 50) + 10,
      toolBreakdown: {
        read: Math.floor(Math.random() * 20),
        write: Math.floor(Math.random() * 10),
        grep: Math.floor(Math.random() * 15),
      },
      fileOps: Math.floor(Math.random() * 40) + 5,
      fileReads: Math.floor(Math.random() * 30) + 5,
      fileWrites: Math.floor(Math.random() * 15) + 2,
      errors: Math.floor(Math.random() * 5),
      durationMs: Math.floor(Math.random() * 300000) + 30000,
    };
  },
};

/**
 * Real backend, wired to the actual sqlite-backed session data via `db`.
 * Mirrors the `case "compare":` block in ../index.ts:
 *   - resolveSessionId(partial)      -> context.resolveSessionId(db, partial)
 *   - recentSessionIds(n, projectId) -> context.recentSessionIds(db, n, projectId),
 *                                        falling back to context.detectProject(db)
 *                                        when no --project was given, exactly as
 *                                        index.ts does before calling recentSessionIds
 *   - gatherSessionMetrics(id)       -> context.gatherSessionMetrics(db, id)
 */
export function createRealCompareBackend(db: Database): CompareBackend {
  return {
    resolveSessionId(partial: string): string | null {
      return realResolveSessionId(db, partial);
    },
    recentSessionIds(n: number, projectId?: string): string[] {
      const resolvedProjectId = projectId || realDetectProject(db) || undefined;
      return realRecentSessionIds(db, n, resolvedProjectId);
    },
    gatherSessionMetrics(sessionId: string): SessionMetrics {
      return realGatherSessionMetrics(db, sessionId);
    },
  };
}

export class CompareCommand extends BaseCommand<CompareResult> {
  constructor(private readonly backend: CompareBackend = simulateBackend) {
    super();
  }

  name = "compare";
  summary = "Compare metrics between two sessions";
  args: ArgSpec[] = [
    {
      name: "session-a",
      type: "string",
      required: true,
      requiredUnless: ["--last"],
      description: "first session to compare (supports prefix matching)",
    },
    {
      name: "session-b",
      type: "string",
      required: true,
      requiredUnless: ["--last"],
      description: "second session to compare (supports prefix matching)",
    },
  ];
  flags: FlagSpec[] = [
    {
      flag: "--last",
      type: "boolean",
      description: "compare the two most recent sessions instead of specifying IDs",
    },
    {
      flag: "--project",
      type: "string",
      description: "project ID to filter sessions when using --last",
    },
    {
      flag: "--json",
      type: "boolean",
      description: "output result as JSON",
    },
  ];
  output = {
    description:
      "displays a formatted table comparing turns, tokens, tool calls, file operations, and errors between two sessions",
    jsonShape: "{ a: SessionMetrics, b: SessionMetrics, diff: { tokens, tokensPct, turns, turnsPct, toolCalls, toolCallsPct, fileReads, fileReadsPct } }",
  };
  examples: [Example, Example, Example] = [
    {
      command: "smriti compare sess1 sess2",
      description: "compare two sessions by ID (supports prefix matching)",
    },
    {
      command: "smriti compare --last",
      description: "compare the two most recent sessions across all projects",
    },
    {
      command: "smriti compare --last --project web-app",
      description: "compare the two most recent sessions for a specific project",
    },
  ];
  detailedSummary =
    "Compare two sessions to understand performance differences. " +
    "Shows side-by-side metrics including turns, tokens (input/output), tool usage, file operations, and errors. " +
    "Supports both explicit ID specification with prefix matching, and --last to automatically pick the two most recent sessions. " +
    "Use --json for machine-readable output suitable for scripting or analysis.";

  protected async execute(parsed: ParsedArgs): Promise<CompareResult> {
    let idA: string | null = null;
    let idB: string | null = null;

    if (parsed.flags["--last"] === true) {
      // Compare last 2 sessions for the detected/specified project
      const projectId = parsed.flags["--project"] as string | undefined;
      const recent = this.backend.recentSessionIds(2, projectId);
      if (recent.length < 2) {
        throw new CommandError(
          "Need at least 2 sessions to compare. Run 'smriti ingest' first.",
          "NOT_FOUND",
          { reason: "insufficient_sessions", available: recent.length }
        );
      }
      idA = recent[1]; // older
      idB = recent[0]; // newer
    } else {
      // Use explicit session IDs
      const rawA = parsed.positionals[0];
      const rawB = parsed.positionals[1];

      if (!rawA || !rawB) {
        throw new CommandError(
          "Missing required arguments: session-a and session-b",
          "MISSING_ARG",
          { missingArgs: !rawA ? ["session-a", "session-b"] : ["session-b"] }
        );
      }

      idA = this.backend.resolveSessionId(rawA);
      if (!idA) {
        throw new CommandError(
          `Could not resolve session: ${rawA}`,
          "NOT_FOUND",
          { unresolvedSession: rawA }
        );
      }

      idB = this.backend.resolveSessionId(rawB);
      if (!idB) {
        throw new CommandError(
          `Could not resolve session: ${rawB}`,
          "NOT_FOUND",
          { unresolvedSession: rawB }
        );
      }
    }

    // Gather metrics for both sessions
    const a = this.backend.gatherSessionMetrics(idA);
    const b = this.backend.gatherSessionMetrics(idB);

    // Compute total tokens
    a.totalTokens = a.inputTokens + a.outputTokens;
    b.totalTokens = b.inputTokens + b.outputTokens;

    return {
      a,
      b,
      diff: {
        tokens: b.totalTokens - a.totalTokens,
        tokensPct: pctChange(a.totalTokens, b.totalTokens),
        turns: b.turnCount - a.turnCount,
        turnsPct: pctChange(a.turnCount, b.turnCount),
        toolCalls: b.toolCalls - a.toolCalls,
        toolCallsPct: pctChange(a.toolCalls, b.toolCalls),
        fileReads: b.fileReads - a.fileReads,
        fileReadsPct: pctChange(a.fileReads, b.fileReads),
      },
    };
  }
}

/** Helper: compute percentage change from a to b */
function pctChange(a: number, b: number): number {
  if (a === 0) return b === 0 ? 0 : 100;
  return ((b - a) / a) * 100;
}
