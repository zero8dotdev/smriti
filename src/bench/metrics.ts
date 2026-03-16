/**
 * bench/metrics.ts - Quality and performance metrics for benchmarking
 *
 * MRR (Mean Reciprocal Rank), Hit@K, combined score calculation,
 * and threshold checking for CI gates.
 */

import type { QueryResult, TierMetrics, TimedStats, BenchReport } from "./types";

// =============================================================================
// Thresholds (FTS-only, conservative)
// =============================================================================

export const THRESHOLDS = {
  easy: { hitAt3: 0.80, mrr: 0.70 },
  medium: { hitAt3: 0.30, mrr: 0.25 },
  hard: { hitAt3: 0.15, mrr: 0.12 },
  combined: 0.30,
};

// =============================================================================
// Combined Score Weights
// =============================================================================

const WEIGHTS = {
  easy: 0.15,
  medium: 0.35,
  hard: 0.35,
  filter: 0.15,
};

// =============================================================================
// Metric Calculations
// =============================================================================

/** Calculate tier metrics from a set of query results */
export function calcTierMetrics(results: QueryResult[]): TierMetrics {
  if (results.length === 0) {
    return { hitAt3: 0, hitAt5: 0, mrr: 0, queryCount: 0 };
  }

  const hitAt3Count = results.filter((r) => r.hitAt3).length;
  const hitAt5Count = results.filter((r) => r.hitAt5).length;
  const mrrSum = results.reduce((sum, r) => sum + r.reciprocalRank, 0);

  return {
    hitAt3: hitAt3Count / results.length,
    hitAt5: hitAt5Count / results.length,
    mrr: mrrSum / results.length,
    queryCount: results.length,
  };
}

/** Calculate the combined quality score (the "one number") */
export function calcCombinedScore(
  easy: TierMetrics,
  medium: TierMetrics,
  hard: TierMetrics,
  filterResults: QueryResult[]
): number {
  const filterMrr =
    filterResults.length > 0
      ? filterResults.reduce((sum, r) => sum + r.reciprocalRank, 0) / filterResults.length
      : 0;

  return (
    WEIGHTS.easy * easy.mrr +
    WEIGHTS.medium * medium.mrr +
    WEIGHTS.hard * hard.mrr +
    WEIGHTS.filter * filterMrr
  );
}

/** Run threshold checks for CI pass/fail */
export function checkThresholds(report: BenchReport): BenchReport["thresholds"] {
  const checks: BenchReport["thresholds"]["checks"] = [
    {
      name: "Combined Score",
      actual: report.quality.combined,
      required: THRESHOLDS.combined,
      passed: report.quality.combined >= THRESHOLDS.combined,
    },
    {
      name: "Easy Hit@3",
      actual: report.quality.easy.hitAt3,
      required: THRESHOLDS.easy.hitAt3,
      passed: report.quality.easy.hitAt3 >= THRESHOLDS.easy.hitAt3,
    },
    {
      name: "Easy MRR",
      actual: report.quality.easy.mrr,
      required: THRESHOLDS.easy.mrr,
      passed: report.quality.easy.mrr >= THRESHOLDS.easy.mrr,
    },
    {
      name: "Medium Hit@3",
      actual: report.quality.medium.hitAt3,
      required: THRESHOLDS.medium.hitAt3,
      passed: report.quality.medium.hitAt3 >= THRESHOLDS.medium.hitAt3,
    },
    {
      name: "Medium MRR",
      actual: report.quality.medium.mrr,
      required: THRESHOLDS.medium.mrr,
      passed: report.quality.medium.mrr >= THRESHOLDS.medium.mrr,
    },
    {
      name: "Hard Hit@3",
      actual: report.quality.hard.hitAt3,
      required: THRESHOLDS.hard.hitAt3,
      passed: report.quality.hard.hitAt3 >= THRESHOLDS.hard.hitAt3,
    },
    {
      name: "Hard MRR",
      actual: report.quality.hard.mrr,
      required: THRESHOLDS.hard.mrr,
      passed: report.quality.hard.mrr >= THRESHOLDS.hard.mrr,
    },
  ];

  return {
    passed: checks.every((c) => c.passed),
    checks,
  };
}

// =============================================================================
// Performance Stats
// =============================================================================

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] || 0;
}

export function calcTimedStats(values: number[]): TimedStats {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  return {
    p50_ms: Number(percentile(sorted, 50).toFixed(3)),
    p95_ms: Number(percentile(sorted, 95).toFixed(3)),
    mean_ms: Number(mean.toFixed(3)),
    runs: values.length,
  };
}
