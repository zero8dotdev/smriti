/**
 * bench/format.ts - CLI output formatting for benchmark results
 */

import { table } from "../format";
import type { BenchReport } from "./types";

// =============================================================================
// CLI Output
// =============================================================================

function pct(v: number): string {
  return (v * 100).toFixed(1) + "%";
}

function score(v: number): string {
  return v.toFixed(3);
}

function ms(v: number): string {
  return v.toFixed(3) + "ms";
}

/** Format a full benchmark report for CLI display */
export function formatBenchReport(report: BenchReport): string {
  const lines: string[] = [];

  lines.push(`Smriti Bench: ${report.profile}`);
  lines.push(`Corpus: ${report.corpus.sessions} sessions, ${report.corpus.messages} messages`);
  lines.push("");

  // Quality by tier
  lines.push("Quality");
  lines.push(
    table(
      ["Tier", "Hit@3", "Hit@5", "MRR", "Queries"],
      [
        ["Easy", pct(report.quality.easy.hitAt3), pct(report.quality.easy.hitAt5), score(report.quality.easy.mrr), String(report.quality.easy.queryCount)],
        ["Medium", pct(report.quality.medium.hitAt3), pct(report.quality.medium.hitAt5), score(report.quality.medium.mrr), String(report.quality.medium.queryCount)],
        ["Hard", pct(report.quality.hard.hitAt3), pct(report.quality.hard.hitAt5), score(report.quality.hard.mrr), String(report.quality.hard.queryCount)],
      ]
    )
  );
  lines.push("");

  // Quality by method
  const methods = Object.entries(report.quality.byMethod);
  if (methods.length > 0) {
    lines.push(
      table(
        ["Method", "Hit@3", "Hit@5", "MRR", "Queries"],
        methods.map(([method, m]) => [
          method,
          pct(m.hitAt3),
          pct(m.hitAt5),
          score(m.mrr),
          String(m.queryCount),
        ])
      )
    );
    lines.push("");
  }

  lines.push(`Combined Score: ${score(report.quality.combined)}`);
  lines.push("");

  // Performance
  if (report.performance) {
    lines.push("Performance");
    lines.push(
      table(
        ["Metric", "p50", "p95", "mean"],
        [
          ["FTS search", ms(report.performance.fts.p50_ms), ms(report.performance.fts.p95_ms), ms(report.performance.fts.mean_ms)],
          ["Filtered search", ms(report.performance.filtered.p50_ms), ms(report.performance.filtered.p95_ms), ms(report.performance.filtered.mean_ms)],
          ["Recall", ms(report.performance.recall.p50_ms), ms(report.performance.recall.p95_ms), ms(report.performance.recall.mean_ms)],
        ]
      )
    );
    lines.push("");
  }

  // Thresholds
  lines.push("Thresholds");
  for (const check of report.thresholds.checks) {
    const status = check.passed ? "PASS" : "FAIL";
    const actual = check.name.includes("Hit") ? pct(check.actual) : score(check.actual);
    const required = check.name.includes("Hit") ? pct(check.required) : score(check.required);
    lines.push(`  ${check.name}: ${actual} >= ${required}  ${status}`);
  }
  lines.push("");
  lines.push(report.thresholds.passed ? "All thresholds passed." : "THRESHOLD FAILURES DETECTED.");

  return lines.join("\n");
}

/** Format comparison between two reports */
export function formatComparison(current: BenchReport, baseline: BenchReport): string {
  const lines: string[] = [];

  lines.push("Comparison vs Baseline");
  lines.push("");

  function delta(curr: number, base: number): string {
    const d = curr - base;
    const sign = d >= 0 ? "+" : "";
    return `${sign}${d.toFixed(3)}`;
  }

  lines.push(
    table(
      ["Tier", "MRR", "Baseline", "Delta"],
      [
        ["Easy", score(current.quality.easy.mrr), score(baseline.quality.easy.mrr), delta(current.quality.easy.mrr, baseline.quality.easy.mrr)],
        ["Medium", score(current.quality.medium.mrr), score(baseline.quality.medium.mrr), delta(current.quality.medium.mrr, baseline.quality.medium.mrr)],
        ["Hard", score(current.quality.hard.mrr), score(baseline.quality.hard.mrr), delta(current.quality.hard.mrr, baseline.quality.hard.mrr)],
        ["Combined", score(current.quality.combined), score(baseline.quality.combined), delta(current.quality.combined, baseline.quality.combined)],
      ]
    )
  );

  const combinedDelta = current.quality.combined - baseline.quality.combined;
  if (combinedDelta < -0.05) {
    lines.push("");
    lines.push(`WARNING: Combined score regressed by ${(-combinedDelta).toFixed(3)} (>5% threshold)`);
  }

  return lines.join("\n");
}

/** Format historical bench runs */
export function formatHistory(
  runs: Array<{
    run_at: string;
    profile: string;
    combined_score: number;
    easy_mrr: number;
    medium_mrr: number;
    hard_mrr: number;
  }>
): string {
  if (runs.length === 0) return "No bench history found.";

  return table(
    ["Date", "Profile", "Combined", "Easy", "Medium", "Hard"],
    runs.map((r) => [
      r.run_at.slice(0, 19),
      r.profile,
      score(r.combined_score),
      score(r.easy_mrr),
      score(r.medium_mrr),
      score(r.hard_mrr),
    ])
  );
}
