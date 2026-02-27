import { readFileSync } from "fs";

type TimedStats = { p50_ms: number; p95_ms: number; mean_ms: number; runs: number };
type BenchReport = {
  metrics: {
    ingest_throughput_msgs_per_sec: number;
    ingest_p95_ms_per_session: number;
    fts: TimedStats;
    recall: TimedStats;
    vector: TimedStats | null;
  };
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function pctChange(current: number, baseline: number): number {
  if (!baseline) return 0;
  return (current - baseline) / baseline;
}

function fmtPct(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}

function checkLatency(
  label: string,
  current: number,
  baseline: number,
  threshold: number,
  warnings: string[]
) {
  const delta = pctChange(current, baseline);
  if (delta > threshold) {
    warnings.push(`${label} regressed by ${fmtPct(delta)} (current=${current}, baseline=${baseline})`);
  }
}

function checkThroughput(
  label: string,
  current: number,
  baseline: number,
  threshold: number,
  warnings: string[]
) {
  const drop = baseline ? (baseline - current) / baseline : 0;
  if (drop > threshold) {
    warnings.push(`${label} dropped by ${fmtPct(drop)} (current=${current}, baseline=${baseline})`);
  }
}

function main() {
  const baselinePath = arg("--baseline");
  const currentPath = arg("--current");
  const threshold = Number(arg("--threshold") || "0.2");

  if (!baselinePath || !currentPath) {
    console.error("Usage: bun run scripts/bench-compare.ts --baseline <file> --current <file> [--threshold 0.2]");
    process.exit(1);
  }

  const baseline = JSON.parse(readFileSync(baselinePath, "utf-8")) as BenchReport;
  const current = JSON.parse(readFileSync(currentPath, "utf-8")) as BenchReport;

  const warnings: string[] = [];

  checkThroughput(
    "ingest_throughput_msgs_per_sec",
    current.metrics.ingest_throughput_msgs_per_sec,
    baseline.metrics.ingest_throughput_msgs_per_sec,
    threshold,
    warnings
  );

  checkLatency(
    "ingest_p95_ms_per_session",
    current.metrics.ingest_p95_ms_per_session,
    baseline.metrics.ingest_p95_ms_per_session,
    threshold,
    warnings
  );

  checkLatency("fts_p95_ms", current.metrics.fts.p95_ms, baseline.metrics.fts.p95_ms, threshold, warnings);
  checkLatency("recall_p95_ms", current.metrics.recall.p95_ms, baseline.metrics.recall.p95_ms, threshold, warnings);

  if (baseline.metrics.vector && current.metrics.vector) {
    checkLatency("vector_p95_ms", current.metrics.vector.p95_ms, baseline.metrics.vector.p95_ms, threshold, warnings);
  }

  if (warnings.length === 0) {
    console.log("No performance regressions detected.");
    return;
  }

  console.log("Performance regression warnings:");
  for (const w of warnings) {
    console.log(`- ${w}`);
  }

  // Intentionally non-blocking for now.
  process.exit(0);
}

main();
