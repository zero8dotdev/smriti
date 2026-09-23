/**
 * Real implementation of `clusters` on the new blueprint (see the `clusters`
 * case in ../index.ts). Blueprint only - no real DB is touched; the clustering
 * backend is injected, defaulting to a safe simulation.
 *
 * Discovers topic clusters from session embeddings using k-means clustering.
 * Requires pre-built embeddings (run 'smriti embed' first). Supports optional
 * project filtering, custom k value, and Ollama model selection for cluster naming.
 */

import { BaseCommand, type ParsedArgs, type CommandContext } from "../command";
import type { ArgSpec, FlagSpec, Example } from "../help/types";
import type { Database } from "bun:sqlite";
import { clusterSessions } from "../cluster";

export interface Cluster {
  id: number;
  name: string;
  sessionIds: string[];
  lastActive: string | null;
}

export interface ClusterResult {
  clusters: Cluster[];
  totalSessions: number;
}

/** Injected backend seams - default simulations, no real DB access. */
export interface ClustersBackend {
  /** Performs k-means clustering on session embeddings. */
  clusterSessions(options: {
    projectId?: string;
    k?: number;
    model?: string;
  }): Promise<ClusterResult>;
}

const simulateBackend: ClustersBackend = {
  async clusterSessions() {
    // Return empty clusters - safe simulation, no real DB access
    return { clusters: [], totalSessions: 0 };
  },
};

/**
 * Real backend for ClustersCommand, wired to the actual DB-backed k-means
 * clustering pipeline (mirrors the `case "clusters":` block in ../index.ts).
 *
 * - clusterSessions -> clusterSessions(db, { projectId, k, model }) from ../cluster
 *
 * The real `clusterSessions` signature and return shape (`{ clusters: Cluster[],
 * totalSessions: number }` with `Cluster = { id, name, sessionIds, lastActive }`)
 * match ClustersBackend/ClusterResult/Cluster exactly, so no conversion is needed
 * here - options and the result are passed straight through.
 *
 * Not exercised against a live DB per instructions - verified only by
 * type-checking and line-by-line comparison against ../index.ts and ../cluster.ts.
 */
export function createRealClustersBackend(db: Database): ClustersBackend {
  return {
    async clusterSessions(options) {
      return clusterSessions(db, options);
    },
  };
}

export class ClustersCommand extends BaseCommand<ClusterResult> {
  constructor(private readonly backend: ClustersBackend = simulateBackend) {
    super();
  }

  name = "clusters";
  summary = "Discover topic clusters from session embeddings";
  args: ArgSpec[] = [];
  flags: FlagSpec[] = [
    {
      flag: "--k",
      type: "number",
      description: "number of clusters (default: auto-calculated from session count)",
    },
    {
      flag: "--model",
      type: "string",
      description: "Ollama model for naming clusters (default: configured model)",
    },
    {
      flag: "--project",
      type: "string",
      description: "filter to a specific project",
    },
    {
      flag: "--json",
      type: "boolean",
      description: "output result as JSON",
    },
  ];
  output = {
    description: "list of topic clusters with session counts and last active dates, or JSON",
    jsonShape: "{ clusters: Array<{id: number, name: string, sessionIds: string[], lastActive: string | null}>, totalSessions: number }",
  };
  examples: [Example, Example, Example] = [
    {
      command: "smriti clusters",
      description: "show clusters across all sessions",
    },
    {
      command: "smriti clusters --project myapp",
      description: "cluster only sessions from a specific project",
    },
    {
      command: "smriti clusters --k 5 --json",
      description: "force 5 clusters and output as JSON",
    },
  ];
  detailedSummary =
    "Performs k-means clustering on session embeddings to discover topic themes. " +
    "Generates human-readable cluster names via Ollama. Requires embeddings to be pre-built " +
    "(run 'smriti embed' first). By default, k is auto-calculated based on session count. " +
    "Use --project to cluster only within a specific project.";

  protected async execute(parsed: ParsedArgs, _ctx: CommandContext): Promise<ClusterResult> {
    const k = parsed.flags["--k"] ? Number(parsed.flags["--k"]) : undefined;
    const model = parsed.flags["--model"] as string | undefined;
    const projectId = parsed.flags["--project"] as string | undefined;

    return await this.backend.clusterSessions({
      projectId,
      k,
      model,
    });
  }
}
