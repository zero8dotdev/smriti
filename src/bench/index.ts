/**
 * bench/index.ts - Orchestrator for Smriti quality + performance benchmarking
 *
 * Seeds a temp DB with realistic corpus, evaluates search quality against
 * ground truth queries, measures performance, and outputs a report with
 * one combined score for autonomous optimization.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync, readFileSync } from "fs";
import { dirname } from "path";
import { searchFiltered } from "../search/index";
import { recall } from "../search/recall";
import { initializeMemoryTables } from "../qmd";
import { initializeSmritiTables, seedDefaults } from "../db";
import { seedCorpus } from "./corpus";
import { ALL_QUERIES } from "./queries";
import { calcTierMetrics, calcCombinedScore, checkThresholds, calcTimedStats } from "./metrics";
import { formatBenchReport, formatComparison, formatHistory } from "./format";
import type {
  BenchOptions,
  BenchReport,
  QueryResult,
  BenchProfile,
} from "./types";
import { PROFILES } from "./types";

// =============================================================================
// Query Evaluation
// =============================================================================

async function evaluateQuery(
  db: Database,
  query: typeof ALL_QUERIES[number]
): Promise<QueryResult> {
  const t0 = Bun.nanoseconds();
  let resultSessionIds: string[];

  switch (query.method) {
    case "fts":
    case "filtered": {
      const results = searchFiltered(db, query.query, {
        limit: 10,
        ...query.filters,
      });
      resultSessionIds = results.map((r) => r.session_id);
      break;
    }
    case "recall": {
      const result = await recall(db, query.query, {
        limit: 10,
        synthesize: false,
        ...query.filters,
      });
      resultSessionIds = result.results.map((r) => r.session_id);
      break;
    }
    default:
      resultSessionIds = [];
  }

  const latencyMs = (Bun.nanoseconds() - t0) / 1_000_000;

  // Deduplicate session IDs (FTS may return multiple messages from same session)
  const uniqueSessionIds = [...new Set(resultSessionIds)];

  // Calculate reciprocal rank: position of first correct result
  const rank = uniqueSessionIds.findIndex((id) =>
    query.expectedSessionIds.includes(id)
  );
  const reciprocalRank = rank >= 0 ? 1 / (rank + 1) : 0;

  return {
    queryId: query.id,
    difficulty: query.difficulty,
    method: query.method,
    reciprocalRank,
    hitAt3: rank >= 0 && rank < 3,
    hitAt5: rank >= 0 && rank < 5,
    latencyMs,
    resultCount: uniqueSessionIds.length,
  };
}

// =============================================================================
// Performance Measurement
// =============================================================================

async function measurePerformance(
  db: Database,
  profile: BenchProfile
): Promise<BenchReport["performance"]> {
  const queries = [
    "authentication middleware",
    "training pipeline GPU",
    "database sharding strategy",
    "deployment pipeline CI",
    "rate limiting Redis",
    "OAuth2 integration",
    "connection pool exhausted",
    "feature store versioning",
    "Kubernetes pod scaling",
    "model overfitting regularization",
  ];

  // Warmup
  for (let i = 0; i < profile.warmupQueries; i++) {
    const q = queries[i % queries.length]!;
    searchFiltered(db, q, { limit: 10 });
  }

  const ftsDurations: number[] = [];
  const filteredDurations: number[] = [];
  const recallDurations: number[] = [];

  for (let i = 0; i < profile.measureQueries; i++) {
    const q = queries[i % queries.length]!;

    // FTS (no filters)
    const tFts = Bun.nanoseconds();
    searchFiltered(db, q, { limit: 10 });
    ftsDurations.push((Bun.nanoseconds() - tFts) / 1_000_000);

    // Filtered
    const tFiltered = Bun.nanoseconds();
    searchFiltered(db, q, { limit: 10, project: "webapp" });
    filteredDurations.push((Bun.nanoseconds() - tFiltered) / 1_000_000);

    // Recall
    const tRecall = Bun.nanoseconds();
    await recall(db, q, { limit: 10, synthesize: false });
    recallDurations.push((Bun.nanoseconds() - tRecall) / 1_000_000);
  }

  return {
    fts: calcTimedStats(ftsDurations),
    filtered: calcTimedStats(filteredDurations),
    recall: calcTimedStats(recallDurations),
  };
}

// =============================================================================
// Bench Run Table Operations
// =============================================================================

function saveBenchRun(db: Database, report: BenchReport): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS smriti_bench_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_at TEXT NOT NULL DEFAULT (datetime('now')),
      profile TEXT NOT NULL,
      combined_score REAL NOT NULL,
      easy_mrr REAL,
      medium_mrr REAL,
      hard_mrr REAL,
      easy_hit3 REAL,
      medium_hit3 REAL,
      hard_hit3 REAL,
      fts_p50_ms REAL,
      recall_p50_ms REAL,
      metadata TEXT
    )
  `);

  db.prepare(
    `INSERT INTO smriti_bench_runs(
      profile, combined_score, easy_mrr, medium_mrr, hard_mrr,
      easy_hit3, medium_hit3, hard_hit3, fts_p50_ms, recall_p50_ms, metadata
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    report.profile,
    report.quality.combined,
    report.quality.easy.mrr,
    report.quality.medium.mrr,
    report.quality.hard.mrr,
    report.quality.easy.hitAt3,
    report.quality.medium.hitAt3,
    report.quality.hard.hitAt3,
    report.performance?.fts.p50_ms ?? null,
    report.performance?.recall.p50_ms ?? null,
    JSON.stringify(report)
  );
}

function getBenchHistory(
  db: Database,
  profile?: string,
  limit: number = 20
): Array<{
  run_at: string;
  profile: string;
  combined_score: number;
  easy_mrr: number;
  medium_mrr: number;
  hard_mrr: number;
}> {
  // Ensure table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS smriti_bench_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_at TEXT NOT NULL DEFAULT (datetime('now')),
      profile TEXT NOT NULL,
      combined_score REAL NOT NULL,
      easy_mrr REAL,
      medium_mrr REAL,
      hard_mrr REAL,
      easy_hit3 REAL,
      medium_hit3 REAL,
      hard_hit3 REAL,
      fts_p50_ms REAL,
      recall_p50_ms REAL,
      metadata TEXT
    )
  `);

  if (profile) {
    return db
      .prepare(
        `SELECT run_at, profile, combined_score, easy_mrr, medium_mrr, hard_mrr
         FROM smriti_bench_runs WHERE profile = ?
         ORDER BY run_at DESC LIMIT ?`
      )
      .all(profile, limit) as any;
  }
  return db
    .prepare(
      `SELECT run_at, profile, combined_score, easy_mrr, medium_mrr, hard_mrr
       FROM smriti_bench_runs ORDER BY run_at DESC LIMIT ?`
    )
    .all(limit) as any;
}

// =============================================================================
// Main Orchestrator
// =============================================================================

export async function runBench(options: BenchOptions): Promise<BenchReport> {
  const profile = PROFILES[options.profile];
  if (!profile) throw new Error(`Unknown profile: ${options.profile}`);

  // Handle --history
  if (options.history && options.realDb) {
    const runs = getBenchHistory(options.realDb, options.profile);
    console.log(formatHistory(runs));
    // Return a stub report
    return {
      profile: options.profile,
      generated_at: new Date().toISOString(),
      corpus: { sessions: 0, messages: 0, projects: 0 },
      quality: {
        easy: { hitAt3: 0, hitAt5: 0, mrr: 0, queryCount: 0 },
        medium: { hitAt3: 0, hitAt5: 0, mrr: 0, queryCount: 0 },
        hard: { hitAt3: 0, hitAt5: 0, mrr: 0, queryCount: 0 },
        byMethod: {},
        combined: 0,
      },
      performance: null,
      thresholds: { passed: true, checks: [] },
      queryDetails: [],
    };
  }

  // Create temp in-memory DB for benchmarking
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  initializeMemoryTables(db);
  initializeSmritiTables(db);
  seedDefaults(db);

  // Seed corpus
  const manifest = await seedCorpus(db, profile);
  const totalMessages = manifest.sessions.reduce(
    (sum, s) => sum + s.messages.length,
    0
  );

  // Evaluate quality
  const queryResults: QueryResult[] = [];
  for (const query of ALL_QUERIES) {
    const result = await evaluateQuery(db, query);
    queryResults.push(result);
  }

  // Compute metrics by tier
  const easyResults = queryResults.filter((r) => r.difficulty === "easy");
  const mediumResults = queryResults.filter((r) => r.difficulty === "medium");
  const hardResults = queryResults.filter((r) => r.difficulty === "hard");

  const easyMetrics = calcTierMetrics(easyResults);
  const mediumMetrics = calcTierMetrics(mediumResults);
  const hardMetrics = calcTierMetrics(hardResults);

  // Filter-specific results (queries that use project/category/agent filters)
  const filterResults = queryResults.filter((r) => r.method === "filtered");

  const combined = calcCombinedScore(easyMetrics, mediumMetrics, hardMetrics, filterResults);

  // Compute metrics by method
  const byMethod: Record<string, typeof easyMetrics> = {};
  const methods = [...new Set(queryResults.map((r) => r.method))];
  for (const method of methods) {
    byMethod[method] = calcTierMetrics(queryResults.filter((r) => r.method === method));
  }

  // Performance measurement
  let performance: BenchReport["performance"] = null;
  if (!options.skipPerf) {
    performance = await measurePerformance(db, profile);
  }

  // Build report
  const report: BenchReport = {
    profile: options.profile,
    generated_at: new Date().toISOString(),
    corpus: {
      sessions: manifest.sessions.length,
      messages: totalMessages,
      projects: manifest.projects.length,
    },
    quality: {
      easy: easyMetrics,
      medium: mediumMetrics,
      hard: hardMetrics,
      byMethod,
      combined,
    },
    performance,
    thresholds: { passed: true, checks: [] },
    queryDetails: queryResults,
  };

  // Check thresholds
  report.thresholds = checkThresholds(report);

  // Output
  if (options.json) {
    const jsonStr = JSON.stringify(report, null, 2);
    console.log(jsonStr);
  } else {
    console.log(formatBenchReport(report));
  }

  // Write to file
  if (options.outPath) {
    mkdirSync(dirname(options.outPath), { recursive: true });
    writeFileSync(options.outPath, JSON.stringify(report, null, 2));
    if (!options.json) {
      console.log(`\nReport written to: ${options.outPath}`);
    }
  }

  // Compare with baseline
  if (options.comparePath) {
    try {
      const baselineJson = readFileSync(options.comparePath, "utf-8");
      const baseline: BenchReport = JSON.parse(baselineJson);
      console.log("\n" + formatComparison(report, baseline));
    } catch (err) {
      console.error(`Could not read baseline: ${options.comparePath}`);
    }
  }

  // Save to bench history
  if (options.save && options.realDb) {
    saveBenchRun(options.realDb, report);
    if (!options.json) {
      console.log("Results saved to bench history.");
    }
  }

  db.close();
  return report;
}
