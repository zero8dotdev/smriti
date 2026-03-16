/**
 * bench.test.ts - Tests for the benchmark infrastructure
 *
 * Tests the machinery (corpus seeding, metric calculations, formatting),
 * not the actual search quality (that's what `smriti bench` output measures).
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeMemoryTables } from "../src/qmd";
import { initializeSmritiTables, seedDefaults } from "../src/db";
import { seedCorpus } from "../src/bench/corpus";
import { ALL_QUERIES, QUERIES_BY_DIFFICULTY } from "../src/bench/queries";
import {
  calcTierMetrics,
  calcCombinedScore,
  calcTimedStats,
  percentile,
  checkThresholds,
} from "../src/bench/metrics";
import { formatBenchReport, formatComparison, formatHistory } from "../src/bench/format";
import { PROFILES } from "../src/bench/types";
import type { QueryResult, BenchReport, TierMetrics } from "../src/bench/types";

// =============================================================================
// Corpus Tests
// =============================================================================

describe("corpus", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    initializeMemoryTables(db);
    initializeSmritiTables(db);
    seedDefaults(db);
  });

  afterAll(() => {
    db.close();
  });

  test("seedCorpus creates 12 sessions", async () => {
    const manifest = await seedCorpus(db, PROFILES["ci-small"]);
    expect(manifest.sessions.length).toBe(12);
  });

  test("seedCorpus populates 3 projects", () => {
    const projects = db
      .prepare("SELECT id FROM smriti_projects")
      .all() as { id: string }[];
    const benchProjects = projects.filter((p) =>
      ["webapp", "ml-pipeline", "infra"].includes(p.id)
    );
    expect(benchProjects.length).toBe(3);
  });

  test("seedCorpus sets session metadata", () => {
    const meta = db
      .prepare(
        "SELECT session_id, agent_id, project_id FROM smriti_session_meta WHERE session_id LIKE 'bench-%'"
      )
      .all() as { session_id: string; agent_id: string; project_id: string }[];
    expect(meta.length).toBe(12);

    // Check specific session metadata
    const s01 = meta.find((m) => m.session_id === "bench-s01");
    expect(s01?.project_id).toBe("webapp");
    expect(s01?.agent_id).toBe("claude-code");

    const s05 = meta.find((m) => m.session_id === "bench-s05");
    expect(s05?.project_id).toBe("ml-pipeline");
    expect(s05?.agent_id).toBe("codex");
  });

  test("seedCorpus tags sessions with categories", () => {
    const tags = db
      .prepare(
        "SELECT session_id, category_id FROM smriti_session_tags WHERE session_id LIKE 'bench-%'"
      )
      .all() as { session_id: string; category_id: string }[];
    expect(tags.length).toBe(12);

    const s01Tag = tags.find((t) => t.session_id === "bench-s01");
    expect(s01Tag?.category_id).toBe("architecture/design");
  });

  test("seedCorpus inserts messages", () => {
    const msgCount = db
      .prepare(
        "SELECT COUNT(*) as c FROM memory_messages WHERE session_id LIKE 'bench-%'"
      )
      .get() as { c: number };
    // 12 sessions * ~6-8 messages each
    expect(msgCount.c).toBeGreaterThan(60);
    expect(msgCount.c).toBeLessThan(120);
  });

  test("seedCorpus creates sidecar content for s04", () => {
    // Check thinking
    const thinking = db
      .prepare(
        "SELECT COUNT(*) as c FROM smriti_thinking WHERE session_id = 'bench-s04'"
      )
      .get() as { c: number };
    expect(thinking.c).toBeGreaterThan(0);

    // Check artifact
    const artifact = db
      .prepare(
        "SELECT COUNT(*) as c FROM smriti_artifacts WHERE session_id = 'bench-s04'"
      )
      .get() as { c: number };
    expect(artifact.c).toBeGreaterThan(0);

    // Check attachment
    const attachment = db
      .prepare(
        "SELECT COUNT(*) as c FROM smriti_attachments WHERE session_id = 'bench-s04'"
      )
      .get() as { c: number };
    expect(attachment.c).toBeGreaterThan(0);
  });

  test("FTS index contains session content", () => {
    const results = db
      .prepare(
        "SELECT COUNT(*) as c FROM memory_fts WHERE memory_fts MATCH 'bcrypt'"
      )
      .get() as { c: number };
    expect(results.c).toBeGreaterThan(0);
  });
});

// =============================================================================
// Query Suite Tests
// =============================================================================

describe("queries", () => {
  test("36 total queries", () => {
    expect(ALL_QUERIES.length).toBe(36);
  });

  test("12 per difficulty tier", () => {
    expect(QUERIES_BY_DIFFICULTY.easy.length).toBe(12);
    expect(QUERIES_BY_DIFFICULTY.medium.length).toBe(12);
    expect(QUERIES_BY_DIFFICULTY.hard.length).toBe(12);
  });

  test("all query IDs are unique", () => {
    const ids = ALL_QUERIES.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("all expected session IDs reference bench corpus", () => {
    for (const q of ALL_QUERIES) {
      for (const sid of q.expectedSessionIds) {
        expect(sid).toMatch(/^bench-s\d{2}$/);
      }
    }
  });

  test("queries use valid methods", () => {
    for (const q of ALL_QUERIES) {
      expect(["fts", "filtered", "recall"]).toContain(q.method);
    }
  });

  test("filtered queries include filter criteria", () => {
    const filtered = ALL_QUERIES.filter((q) => q.method === "filtered");
    for (const q of filtered) {
      expect(q.filters).toBeDefined();
      const hasFilter =
        q.filters?.project || q.filters?.category || q.filters?.agent || q.filters?.includeThinking;
      expect(hasFilter).toBeTruthy();
    }
  });
});

// =============================================================================
// Metrics Tests
// =============================================================================

describe("metrics", () => {
  test("MRR: perfect ranking = 1.0", () => {
    const results: QueryResult[] = [
      { queryId: "q1", difficulty: "easy", method: "fts", reciprocalRank: 1.0, hitAt3: true, hitAt5: true, latencyMs: 1, resultCount: 5 },
      { queryId: "q2", difficulty: "easy", method: "fts", reciprocalRank: 1.0, hitAt3: true, hitAt5: true, latencyMs: 1, resultCount: 5 },
    ];
    const metrics = calcTierMetrics(results);
    expect(metrics.mrr).toBe(1.0);
  });

  test("MRR: result at rank 3 = 0.333", () => {
    const results: QueryResult[] = [
      { queryId: "q1", difficulty: "easy", method: "fts", reciprocalRank: 1 / 3, hitAt3: true, hitAt5: true, latencyMs: 1, resultCount: 5 },
    ];
    const metrics = calcTierMetrics(results);
    expect(metrics.mrr).toBeCloseTo(0.333, 2);
  });

  test("MRR: no result = 0.0", () => {
    const results: QueryResult[] = [
      { queryId: "q1", difficulty: "easy", method: "fts", reciprocalRank: 0, hitAt3: false, hitAt5: false, latencyMs: 1, resultCount: 0 },
    ];
    const metrics = calcTierMetrics(results);
    expect(metrics.mrr).toBe(0);
  });

  test("Hit@3: correct count", () => {
    const results: QueryResult[] = [
      { queryId: "q1", difficulty: "easy", method: "fts", reciprocalRank: 1.0, hitAt3: true, hitAt5: true, latencyMs: 1, resultCount: 5 },
      { queryId: "q2", difficulty: "easy", method: "fts", reciprocalRank: 0.2, hitAt3: false, hitAt5: true, latencyMs: 1, resultCount: 5 },
      { queryId: "q3", difficulty: "easy", method: "fts", reciprocalRank: 0, hitAt3: false, hitAt5: false, latencyMs: 1, resultCount: 0 },
    ];
    const metrics = calcTierMetrics(results);
    expect(metrics.hitAt3).toBeCloseTo(1 / 3, 5);
    expect(metrics.hitAt5).toBeCloseTo(2 / 3, 5);
  });

  test("empty results returns zeros", () => {
    const metrics = calcTierMetrics([]);
    expect(metrics.mrr).toBe(0);
    expect(metrics.hitAt3).toBe(0);
    expect(metrics.hitAt5).toBe(0);
    expect(metrics.queryCount).toBe(0);
  });

  test("combined score is in [0, 1] range", () => {
    const perfect: TierMetrics = { hitAt3: 1, hitAt5: 1, mrr: 1, queryCount: 10 };
    const zero: TierMetrics = { hitAt3: 0, hitAt5: 0, mrr: 0, queryCount: 10 };

    const maxScore = calcCombinedScore(perfect, perfect, perfect, [
      { queryId: "q1", difficulty: "hard", method: "filtered", reciprocalRank: 1, hitAt3: true, hitAt5: true, latencyMs: 1, resultCount: 5 },
    ]);
    expect(maxScore).toBeLessThanOrEqual(1.0);
    expect(maxScore).toBeGreaterThan(0.9);

    const minScore = calcCombinedScore(zero, zero, zero, []);
    expect(minScore).toBe(0);
  });

  test("combined score weights sum to 1.0", () => {
    // All tiers at 1.0 should produce ~1.0 combined score
    const allPerfect: TierMetrics = { hitAt3: 1, hitAt5: 1, mrr: 1, queryCount: 10 };
    const score = calcCombinedScore(allPerfect, allPerfect, allPerfect, [
      { queryId: "q1", difficulty: "hard", method: "filtered", reciprocalRank: 1, hitAt3: true, hitAt5: true, latencyMs: 1, resultCount: 5 },
    ]);
    expect(score).toBeCloseTo(1.0, 5);
  });
});

// =============================================================================
// Performance Stats Tests
// =============================================================================

describe("performance stats", () => {
  test("percentile with sorted array", () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 50)).toBe(5);
    expect(percentile(sorted, 95)).toBe(10);
    expect(percentile(sorted, 10)).toBe(1);
  });

  test("percentile with empty array returns 0", () => {
    expect(percentile([], 50)).toBe(0);
  });

  test("calcTimedStats computes correctly", () => {
    const values = [1, 2, 3, 4, 5];
    const stats = calcTimedStats(values);
    expect(stats.mean_ms).toBe(3);
    expect(stats.runs).toBe(5);
    expect(stats.p50_ms).toBeGreaterThan(0);
    expect(stats.p95_ms).toBeGreaterThanOrEqual(stats.p50_ms);
  });
});

// =============================================================================
// Threshold Tests
// =============================================================================

describe("thresholds", () => {
  test("passing report shows all passed", () => {
    const report: BenchReport = {
      profile: "ci-small",
      generated_at: new Date().toISOString(),
      corpus: { sessions: 12, messages: 96, projects: 3 },
      quality: {
        easy: { hitAt3: 0.9, hitAt5: 1.0, mrr: 0.85, queryCount: 12 },
        medium: { hitAt3: 0.5, hitAt5: 0.6, mrr: 0.4, queryCount: 12 },
        hard: { hitAt3: 0.25, hitAt5: 0.3, mrr: 0.2, queryCount: 12 },
        byMethod: {},
        combined: 0.45,
      },
      performance: null,
      thresholds: { passed: true, checks: [] },
      queryDetails: [],
    };
    const result = checkThresholds(report);
    expect(result.passed).toBe(true);
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });

  test("failing report detects failures", () => {
    const report: BenchReport = {
      profile: "ci-small",
      generated_at: new Date().toISOString(),
      corpus: { sessions: 12, messages: 96, projects: 3 },
      quality: {
        easy: { hitAt3: 0.5, hitAt5: 0.6, mrr: 0.4, queryCount: 12 }, // below 0.80 / 0.70
        medium: { hitAt3: 0.1, hitAt5: 0.2, mrr: 0.1, queryCount: 12 }, // below thresholds
        hard: { hitAt3: 0.05, hitAt5: 0.1, mrr: 0.05, queryCount: 12 },
        byMethod: {},
        combined: 0.15, // below 0.30
      },
      performance: null,
      thresholds: { passed: true, checks: [] },
      queryDetails: [],
    };
    const result = checkThresholds(report);
    expect(result.passed).toBe(false);
    expect(result.checks.some((c) => !c.passed)).toBe(true);
  });
});

// =============================================================================
// Formatting Tests
// =============================================================================

describe("formatting", () => {
  const sampleReport: BenchReport = {
    profile: "ci-small",
    generated_at: new Date().toISOString(),
    corpus: { sessions: 12, messages: 96, projects: 3 },
    quality: {
      easy: { hitAt3: 0.833, hitAt5: 0.917, mrr: 0.75, queryCount: 12 },
      medium: { hitAt3: 0.417, hitAt5: 0.583, mrr: 0.312, queryCount: 12 },
      hard: { hitAt3: 0.25, hitAt5: 0.333, mrr: 0.189, queryCount: 12 },
      byMethod: {
        fts: { hitAt3: 0.727, hitAt5: 0.818, mrr: 0.614, queryCount: 11 },
        filtered: { hitAt3: 0.6, hitAt5: 0.8, mrr: 0.48, queryCount: 5 },
        recall: { hitAt3: 0.45, hitAt5: 0.55, mrr: 0.337, queryCount: 20 },
      },
      combined: 0.384,
    },
    performance: {
      fts: { p50_ms: 0.42, p95_ms: 0.61, mean_ms: 0.45, runs: 20 },
      filtered: { p50_ms: 0.55, p95_ms: 0.78, mean_ms: 0.59, runs: 20 },
      recall: { p50_ms: 0.51, p95_ms: 0.73, mean_ms: 0.55, runs: 20 },
    },
    thresholds: {
      passed: true,
      checks: [{ name: "Combined Score", actual: 0.384, required: 0.3, passed: true }],
    },
    queryDetails: [],
  };

  test("formatBenchReport includes key sections", () => {
    const output = formatBenchReport(sampleReport);
    expect(output).toContain("Smriti Bench: ci-small");
    expect(output).toContain("Quality");
    expect(output).toContain("Performance");
    expect(output).toContain("Thresholds");
    expect(output).toContain("Combined Score");
  });

  test("formatComparison shows delta", () => {
    const baseline = { ...sampleReport, quality: { ...sampleReport.quality, combined: 0.35 } };
    const output = formatComparison(sampleReport, baseline);
    expect(output).toContain("Comparison");
    expect(output).toContain("Delta");
  });

  test("formatHistory handles empty", () => {
    const output = formatHistory([]);
    expect(output).toContain("No bench history");
  });

  test("formatHistory shows runs", () => {
    const output = formatHistory([
      { run_at: "2026-03-09T10:00:00", profile: "ci-small", combined_score: 0.384, easy_mrr: 0.75, medium_mrr: 0.312, hard_mrr: 0.189 },
    ]);
    expect(output).toContain("ci-small");
    expect(output).toContain("0.384");
  });
});

// =============================================================================
// Integration Test (end-to-end bench run)
// =============================================================================

describe("bench integration", () => {
  test("runBench completes with ci-small profile", async () => {
    const { runBench } = await import("../src/bench/index");

    // Capture stdout
    const originalLog = console.log;
    let output = "";
    console.log = (msg: string) => { output += msg + "\n"; };

    try {
      const report = await runBench({
        profile: "ci-small",
        json: false,
        skipPerf: true,
        save: false,
        history: false,
      });

      expect(report.profile).toBe("ci-small");
      expect(report.corpus.sessions).toBe(12);
      expect(report.quality.combined).toBeGreaterThan(0);
      expect(report.quality.easy.queryCount).toBe(12);
      expect(report.quality.medium.queryCount).toBe(12);
      expect(report.quality.hard.queryCount).toBe(12);
      expect(report.queryDetails.length).toBe(36);
      expect(output).toContain("Smriti Bench");
    } finally {
      console.log = originalLog;
    }
  }, 30_000); // Allow 30s for full run
});
