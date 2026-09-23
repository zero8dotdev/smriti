/**
 * Real implementation of `recall` on the new blueprint (see the `recall`
 * case in ../index.ts). Blueprint only - no real DB is touched; the recall
 * backend is injected, defaulting to a safe simulated implementation.
 *
 * Recall queries memory with smart synthesis, conflict detection, and
 * cross-project search capability. The core `<query>` is required; everything
 * else is optional filters and synthesis tuning.
 */

import { BaseCommand, type ParsedArgs, CommandError } from "../command";
import type { ArgSpec, FlagSpec, Example } from "../help/types";
import type { Database } from "bun:sqlite";
import { recall } from "../search/recall";
import { getClusterSessionIds } from "../cluster";
import { ollamaCheckConflicts } from "../ollama";

export interface SearchResult {
  session_id: string;
  session_title: string;
  message_id: number;
  role: string;
  content: string;
  score: number;
  source: string;
  category?: string;
  project?: string;
  agent?: string;
}

export interface ConflictResult {
  pair: [number, number];
  description: string;
}

export interface RecallResult {
  results: SearchResult[];
  synthesis?: string;
  conflicts: ConflictResult[];
}

export interface RecallFilters {
  category?: string;
  project?: string;
  agent?: string;
  limit?: number;
  synthesize?: boolean;
  model?: string;
  maxTokens?: number;
  includeThinking?: boolean;
  includeArtifacts?: boolean;
  includeAttachments?: boolean;
  includeVoiceNotes?: boolean;
  fast?: boolean;
  wide?: boolean;
}

/** Injected backend seams - default simulations, no real DB access. */
export interface RecallBackend {
  /** Executes a recall query with optional filters, returns results and optional synthesis. */
  recallQuery(query: string, filters: RecallFilters): Promise<{ results: SearchResult[]; synthesis?: string }>;
  /** Gets cluster session IDs if the cluster exists, returns null if not found. */
  getClusterSessionIds(clusterName: string): Promise<string[] | null>;
  /** Checks for contradictions among passages (first 5 results). */
  checkConflicts(query: string, passages: { n: number; title: string; content: string }[]): Promise<ConflictResult[]>;
}

const simulateBackend: RecallBackend = {
  async recallQuery() {
    // Simulate finding 3 results
    return {
      results: [
        { session_id: "sess1", session_title: "Auth setup", message_id: 1, role: "assistant", content: "We discussed OAuth...", score: 0.95, source: "fts" },
        { session_id: "sess2", session_title: "Security review", message_id: 2, role: "assistant", content: "Reviewed token handling...", score: 0.87, source: "fts" },
        { session_id: "sess3", session_title: "Deployment notes", message_id: 3, role: "assistant", content: "Auth module deployed...", score: 0.72, source: "fts" },
      ],
      synthesis: undefined,
    };
  },
  async getClusterSessionIds(clusterName: string) {
    // Return null to simulate cluster not found
    return null;
  },
  async checkConflicts() {
    return []; // No conflicts by default
  },
};

/**
 * Real backend for RecallCommand, wired to the actual DB-backed recall
 * pipeline (mirrors the `case "recall":` block in ../index.ts).
 *
 * - recallQuery      -> recall(db, query, options) from ../search/recall
 * - getClusterSessionIds -> getClusterSessionIds(db, clusterName) from ../cluster
 * - checkConflicts   -> ollamaCheckConflicts(topic, passages) from ../ollama
 *
 * Note: the index.ts case block also performs a cosmetic cross-project
 * "badge" enrichment (a direct query against smriti_session_meta) when
 * --wide is combined with --project, decorating results with the
 * originating project name. That enrichment has no corresponding hook on
 * RecallBackend (recallQuery only returns { results, synthesis }), so it
 * is intentionally not reproduced here - see the "concerns" note in the
 * wiring report.
 */
export function createRealRecallBackend(db: Database): RecallBackend {
  return {
    async recallQuery(query, filters) {
      return recall(db, query, filters);
    },
    async getClusterSessionIds(clusterName) {
      // Real getClusterSessionIds is synchronous and always returns string[]
      // (empty when the cluster has no sessions) - it never returns null.
      // This matches index.ts, which also only ever assigns an array (or
      // null when no --cluster flag was given at all) to clusterSessionIds.
      return getClusterSessionIds(db, clusterName);
    },
    async checkConflicts(query, passages) {
      return ollamaCheckConflicts(query, passages);
    },
  };
}

export class RecallCommand extends BaseCommand<RecallResult> {
  constructor(private readonly backend: RecallBackend = simulateBackend) {
    super();
  }

  name = "recall";
  summary = "Smart recall with optional synthesis and conflict detection";
  args: ArgSpec[] = [
    {
      name: "query",
      type: "string",
      required: true,
      description: "search query for memory recall",
    },
  ];
  flags: FlagSpec[] = [
    { flag: "--category", type: "string", description: "filter by category" },
    { flag: "--project", type: "string", description: "filter by project" },
    { flag: "--agent", type: "string", description: "filter by agent" },
    { flag: "--limit", type: "number", description: "max results" },
    { flag: "--synthesize", type: "boolean", description: "synthesize results via Ollama" },
    { flag: "--model", type: "string", description: "Ollama model for synthesis" },
    { flag: "--max-tokens", type: "number", description: "max synthesis tokens" },
    { flag: "--include-thinking", type: "boolean", description: "include thinking blocks" },
    { flag: "--no-artifacts", type: "boolean", description: "exclude artifacts" },
    { flag: "--no-attachments", type: "boolean", description: "exclude attachments" },
    { flag: "--no-voice-notes", type: "boolean", description: "exclude voice notes" },
    { flag: "--fast", type: "boolean", description: "skip query expansion and reranking" },
    { flag: "--wide", type: "boolean", description: "search all projects" },
    { flag: "--cluster", type: "string", description: "filter to named cluster" },
    { flag: "--check-conflicts", type: "boolean", description: "detect contradictions (opt-in)" },
  ];
  output = {
    description: "displays search results, optional synthesis, and optional conflict warnings",
    jsonShape: "{ results: SearchResult[], synthesis?: string, conflicts: ConflictResult[] }",
  };
  examples: [Example, Example, Example] = [
    { command: "smriti recall 'how do we authenticate users'", description: "basic recall" },
    { command: "smriti recall 'auth flow' --synthesize --project myapp", description: "recall with synthesis, scoped to a project" },
    { command: "smriti recall 'database design' --wide --check-conflicts", description: "cross-project recall with conflict detection" },
  ];
  detailedSummary =
    "Recall queries memory with optional multi-stage ranking, synthesis via Ollama, " +
    "and opt-in contradiction detection. --wide searches all projects. --cluster filters " +
    "results to a named topic cluster. Content filters (--no-artifacts, etc.) control what " +
    "material is included in the search. Synthesis combines results into a narrative.";

  protected async execute(parsed: ParsedArgs): Promise<RecallResult> {
    const query = parsed.positionals[0];
    const clusterFilter = parsed.flags["--cluster"] as string | undefined;
    const wide = parsed.flags["--wide"] === true;

    // Validate cluster exists (if specified)
    let clusterSessionIds: string[] | null = null;
    if (clusterFilter) {
      clusterSessionIds = await this.backend.getClusterSessionIds(clusterFilter);
      if (clusterSessionIds === null || clusterSessionIds.length === 0) {
        throw new CommandError(
          `No sessions found for cluster: ${clusterFilter}\nRun 'smriti clusters' to see available clusters.`,
          "NOT_FOUND",
          { cluster: clusterFilter }
        );
      }
    }

    // Build filters object
    const filters: RecallFilters = {
      category: parsed.flags["--category"] as string | undefined,
      project: parsed.flags["--project"] as string | undefined,
      agent: parsed.flags["--agent"] as string | undefined,
      limit: parsed.flags["--limit"] ? Number(parsed.flags["--limit"]) : undefined,
      synthesize: parsed.flags["--synthesize"] === true,
      model: parsed.flags["--model"] as string | undefined,
      maxTokens: parsed.flags["--max-tokens"] ? Number(parsed.flags["--max-tokens"]) : undefined,
      includeThinking: parsed.flags["--include-thinking"] === true,
      includeArtifacts: parsed.flags["--no-artifacts"] !== true,
      includeAttachments: parsed.flags["--no-attachments"] !== true,
      includeVoiceNotes: parsed.flags["--no-voice-notes"] !== true,
      fast: parsed.flags["--fast"] === true,
      wide,
    };

    // Execute recall
    const recallResult = await this.backend.recallQuery(query, filters);
    let results = recallResult.results;

    // Apply cluster filter if specified
    if (clusterSessionIds && clusterSessionIds.length > 0) {
      const clusterSet = new Set(clusterSessionIds);
      results = results.filter((r) => clusterSet.has(r.session_id));
    }

    // Check for conflicts (opt-in)
    let conflicts: ConflictResult[] = [];
    const checkConflicts = parsed.flags["--check-conflicts"] === true;
    if (checkConflicts && results.length >= 2) {
      const passages = results.slice(0, 5).map((r, i) => ({
        n: i + 1,
        title: r.session_title || r.session_id,
        content: r.content,
      }));
      try {
        conflicts = await this.backend.checkConflicts(query, passages);
      } catch {
        // Ollama unavailable — skip conflict detection
      }
    }

    return {
      results,
      synthesis: recallResult.synthesis,
      conflicts,
    };
  }
}
