/**
 * Real implementation of `enrich` on the new blueprint (see the `enrich`
 * case in ../index.ts). Blueprint only - no real DB is touched; backends
 * for density computation, query expansion, and clustering are injected,
 * defaulting to safe simulations.
 *
 * Enrich requires at least one of --density, --queries, or --clusters,
 * enforced via requiredFlagGroups. All three modes are independent and
 * can run together in one invocation.
 */

import type { Database } from "bun:sqlite";
import { BaseCommand, type ParsedArgs } from "../command";
import type { ArgSpec, FlagSpec, Example } from "../help/types";
import {
  computeDensityScore as dbComputeDensityScore,
  updateDensityScore as dbUpdateDensityScore,
  insertSessionQueries as dbInsertSessionQueries,
  getUnenrichedSessionIds,
  type DensityBreakdown,
} from "../db";
import { clusterSessions as realClusterSessions } from "../cluster";
import { formatDensityBreakdown } from "../format";

export type { DensityBreakdown };

export interface EnrichResult {
  densityScoresUpdated: number;
  queriesEnriched: number;
  queriesSkipped: number;
  clustersFound: number;
  totalClusteredSessions: number;
}

export interface EnrichBackend {
  /** Compute density score for a session. */
  computeDensityScore(sessionId: string): DensityBreakdown;
  /** Update density score in DB. */
  updateDensityScore(sessionId: string, score: number): void;
  /** Get all session IDs that need enrichment (or one if sessionId is specified). */
  getSessionIds(opts: { sessionId?: string; projectId?: string }): Promise<string[]>;
  /** Get session metadata. */
  getSessionInfo(sessionId: string): Promise<{ title: string; summary: string | null } | null>;
  /** Expand a query via LLM. */
  expandQuery(input: string): Promise<{ query: string }[]>;
  /** Insert expanded queries for a session. */
  insertSessionQueries(sessionId: string, queryTexts: string[]): number;
  /** Cluster sessions. */
  clusterSessions(opts: {
    projectId?: string;
    k?: number;
    model?: string;
  }): Promise<{ clusters: Array<{ name: string; sessionIds: string[]; lastActive?: string }>; totalSessions: number }>;
}

const simulateBackend: EnrichBackend = {
  computeDensityScore() {
    return {
      score: 0.75,
      toolCalls: 20,
      fileWrites: 5,
      gitOps: 1,
      decisionTags: 1,
      errors: 0,
      totalTokens: 50000,
    };
  },
  updateDensityScore() {
    // noop
  },
  async getSessionIds() {
    return []; // simulate no sessions by default
  },
  async getSessionInfo() {
    return null;
  },
  async expandQuery() {
    return [{ query: "test query" }];
  },
  insertSessionQueries() {
    return 3;
  },
  async clusterSessions() {
    return { clusters: [], totalSessions: 0 };
  },
};

/**
 * Real backend, wired against the shared `db: Database` handle opened once in
 * main() (see ../index.ts). Mirrors the "enrich" case block exactly:
 *   --density  -> db.ts computeDensityScore / updateDensityScore
 *   --queries  -> db.ts getUnenrichedSessionIds / insertSessionQueries,
 *                 plus the QMD store's internal.expandQuery (LLM)
 *   --clusters -> cluster.ts clusterSessions
 *
 * NOTE on getSessionIds: EnrichCommand#execute calls this.backend.getSessionIds
 * from two call sites with different real-world semantics, but the shared
 * EnrichBackend interface has no per-call "mode" flag to distinguish them:
 *   --density : this.backend.getSessionIds({ sessionId: sessionFilter })
 *               (no "projectId" key at all in the object literal) -> in the
 *               original, this means ALL session ids from smriti_session_meta,
 *               unfiltered by project (density recomputes for everyone).
 *   --queries : this.backend.getSessionIds({ sessionId: sessionFilter, projectId: projectFilter })
 *               ("projectId" key is always present in the object literal,
 *               even when its value is undefined) -> in the original, this
 *               means only *unenriched* session ids (getUnenrichedSessionIds),
 *               optionally filtered by project.
 * Because sessionId and projectId can both be undefined at either call site,
 * the values alone can't disambiguate. The only reliable signal is whether
 * the "projectId" property key was included in the opts object literal at
 * all - which is fixed by EnrichCommand's source (which we were told not to
 * modify) and won't change at runtime. This factory relies on that key
 * presence check (`"projectId" in opts`), not the value, to route to the
 * correct real behavior. See "concerns" in the wiring report.
 */
export function createRealEnrichBackend(db: Database): EnrichBackend {
  return {
    computeDensityScore(sessionId: string): DensityBreakdown {
      return dbComputeDensityScore(db, sessionId);
    },

    updateDensityScore(sessionId: string, score: number): void {
      dbUpdateDensityScore(db, sessionId, score);
    },

    async getSessionIds(opts: { sessionId?: string; projectId?: string }): Promise<string[]> {
      if (opts.sessionId) {
        return [opts.sessionId];
      }

      if ("projectId" in opts) {
        // --queries call site: unenriched sessions, optionally project-filtered.
        return getUnenrichedSessionIds(db, opts.projectId || undefined);
      }

      // --density call site: every known session, unfiltered.
      const rows = db.prepare(`SELECT session_id FROM smriti_session_meta`).all() as {
        session_id: string;
      }[];
      return rows.map((r) => r.session_id);
    },

    async getSessionInfo(sessionId: string): Promise<{ title: string; summary: string | null } | null> {
      const session = db
        .prepare(`SELECT title, summary FROM memory_sessions WHERE id = ?`)
        .get(sessionId) as { title: string; summary: string | null } | null;
      return session;
    },

    async expandQuery(input: string): Promise<{ query: string }[]> {
      // Dynamic import mirrors the original index.ts, which lazily imports
      // ./store inside the --queries branch so commands that don't need
      // query expansion never pull in the QMD store (and its LLM backend).
      const { getQmdStore } = await import("../store");
      const store = getQmdStore();
      return store.internal.expandQuery(input);
    },

    insertSessionQueries(sessionId: string, queryTexts: string[]): number {
      return dbInsertSessionQueries(db, sessionId, queryTexts);
    },

    async clusterSessions(opts: {
      projectId?: string;
      k?: number;
      model?: string;
    }): Promise<{ clusters: Array<{ name: string; sessionIds: string[]; lastActive?: string }>; totalSessions: number }> {
      const result = await realClusterSessions(db, {
        projectId: opts.projectId || undefined,
        k: opts.k,
        model: opts.model,
      });
      return {
        clusters: result.clusters.map((c) => ({
          name: c.name,
          sessionIds: c.sessionIds,
          lastActive: c.lastActive ?? undefined,
        })),
        totalSessions: result.totalSessions,
      };
    },
  };
}

export class EnrichCommand extends BaseCommand<EnrichResult> {
  constructor(private readonly backend: EnrichBackend = simulateBackend) {
    super();
  }

  name = "enrich";
  summary = "Compute density scores, generate query labels, or discover topic clusters";
  args: ArgSpec[] = [];
  flags: FlagSpec[] = [
    { flag: "--density", type: "boolean", description: "recompute density scores for all sessions" },
    { flag: "--queries", type: "boolean", description: "generate search aliases via LLM query expansion" },
    { flag: "--clusters", type: "boolean", description: "discover topic clusters from session embeddings" },
    { flag: "--session", type: "string", description: "filter to a single session (--density only)" },
    { flag: "--project", type: "string", description: "filter to a specific project" },
    { flag: "--dry-run", type: "boolean", description: "print what would be generated, don't write" },
    { flag: "--k", type: "number", description: "target number of clusters (clustering only)" },
    { flag: "--model", type: "string", description: "Ollama model for clustering or query expansion" },
  ];
  requiredFlagGroups = [["--density", "--queries", "--clusters"]];
  output = {
    description: "prints counts of enriched entities; --json returns { densityScoresUpdated, queriesEnriched, queriesSkipped, clustersFound, totalClusteredSessions }",
    jsonShape: "{ densityScoresUpdated: number, queriesEnriched: number, queriesSkipped: number, clustersFound: number, totalClusteredSessions: number }",
  };
  examples: [Example, Example, Example] = [
    {
      command: "smriti enrich --density",
      description: "recompute density scores for all sessions",
    },
    {
      command: "smriti enrich --queries --project myapp",
      description: "generate query aliases for unenriched sessions in myapp",
    },
    {
      command: "smriti enrich --clusters --dry-run",
      description: "preview topic clusters without writing to DB",
    },
  ];
  detailedSummary =
    "Enrich supports three independent modes: --density recomputes session relevance scores, " +
    "--queries expands each session's searchability via LLM-generated aliases, and --clusters " +
    "discovers thematic groups in the session corpus. All can run in one command. " +
    "--dry-run (queries only) prints expansions without saving.";

  protected async execute(parsed: ParsedArgs): Promise<EnrichResult> {
    const density = parsed.flags["--density"] === true;
    const queries = parsed.flags["--queries"] === true;
    const clusters = parsed.flags["--clusters"] === true;
    const sessionFilter = parsed.flags["--session"] as string | undefined;
    const projectFilter = parsed.flags["--project"] as string | undefined;
    const dryRun = parsed.flags["--dry-run"] === true;
    const k = parsed.flags["--k"] ? Number(parsed.flags["--k"]) : undefined;
    const model = parsed.flags["--model"] as string | undefined;

    const result: EnrichResult = {
      densityScoresUpdated: 0,
      queriesEnriched: 0,
      queriesSkipped: 0,
      clustersFound: 0,
      totalClusteredSessions: 0,
    };

    // This command prints its own progress inline (matching the original
    // index.ts case block exactly), instead of returning pure data - the
    // original streams per-session progress ("[i/n] title... +N") and,
    // for --density --session, a formatted breakdown - none of which is
    // reconstructible from aggregate counts after the fact.

    if (density) {
      const sessionIds = await this.backend.getSessionIds({ sessionId: sessionFilter });
      console.log(`Computing density scores for ${sessionIds.length} session${sessionIds.length === 1 ? "" : "s"}...`);
      for (const sid of sessionIds) {
        const breakdown = this.backend.computeDensityScore(sid);
        this.backend.updateDensityScore(sid, breakdown.score);
        result.densityScoresUpdated++;
        if (sessionFilter) {
          console.log(formatDensityBreakdown(breakdown));
        }
      }
      if (!sessionFilter) {
        console.log(`Updated ${result.densityScoresUpdated} density scores.`);
      }
    }

    if (queries) {
      const sessionIds = await this.backend.getSessionIds({ sessionId: sessionFilter, projectId: projectFilter });
      console.log(`Enriching ${sessionIds.length} session${sessionIds.length === 1 ? "" : "s"} with query labels...`);

      for (let i = 0; i < sessionIds.length; i++) {
        const sid = sessionIds[i];
        const session = await this.backend.getSessionInfo(sid);
        if (!session?.title) {
          result.queriesSkipped++;
          continue;
        }

        const input = session.title + (session.summary ? ". " + session.summary : "");
        process.stdout.write(`  [${i + 1}/${sessionIds.length}] ${session.title.slice(0, 60)}...`);

        try {
          const expanded = await this.backend.expandQuery(input);
          const queryTexts = expanded.map((e) => e.query).filter(Boolean);

          if (dryRun) {
            console.log(`\n    → ${queryTexts.join(" | ")}`);
          } else {
            const n = this.backend.insertSessionQueries(sid, queryTexts);
            process.stdout.write(` +${n}\n`);
            result.queriesEnriched++;
          }
        } catch {
          process.stdout.write(` (LLM unavailable, skipped)\n`);
          result.queriesSkipped++;
        }
      }

      if (!dryRun) {
        console.log(`\nEnriched ${result.queriesEnriched} sessions${result.queriesSkipped > 0 ? `, skipped ${result.queriesSkipped}` : ""}.`);
      }
    }

    if (clusters) {
      console.log("Clustering sessions...");
      const clusterResult = await this.backend.clusterSessions({
        projectId: projectFilter,
        k,
        model,
      });
      result.clustersFound = clusterResult.clusters.length;
      result.totalClusteredSessions = clusterResult.totalSessions;

      if (clusterResult.clusters.length === 0) {
        console.log("Not enough sessions with embeddings to cluster. Run 'smriti embed' first.");
      } else {
        for (const c of clusterResult.clusters) {
          const lastActive = c.lastActive ? new Date(c.lastActive).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
          console.log(`  ${c.name.padEnd(40)} ${c.sessionIds.length} session${c.sessionIds.length === 1 ? "" : "s"}${lastActive ? `  (${lastActive})` : ""}`);
        }
        console.log(`\n${clusterResult.clusters.length} clusters across ${clusterResult.totalSessions} sessions.`);
      }
    }

    return result;
  }
}
