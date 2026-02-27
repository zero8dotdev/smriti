import { existsSync, readFileSync } from "fs";

type TimedStats = { p50_ms: number; p95_ms: number; mean_ms: number; runs: number };
type BenchReport = {
  profile: string;
  metrics: {
    ingest_throughput_msgs_per_sec: number;
    ingest_p95_ms_per_session: number;
    fts: TimedStats;
    recall: TimedStats;
    vector: TimedStats | null;
  };
};

type RepeatSummary = {
  profiles: Record<
    string,
    {
      median: {
        ingest_throughput_msgs_per_sec: number;
        ingest_p95_ms_per_session: number;
        fts_p95_ms: number;
        recall_p95_ms: number;
      };
    }
  >;
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fmtNum(x: number): string {
  return x.toFixed(3).replace(/\.000$/, "");
}

function pctDelta(current: number, baseline: number): number {
  if (!baseline) return 0;
  return ((current - baseline) / baseline) * 100;
}

function fmtDelta(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function passWarn(deltaPct: number, thresholdPct: number, higherIsBetter: boolean): "PASS" | "WARN" {
  if (higherIsBetter) {
    return deltaPct < -thresholdPct ? "WARN" : "PASS";
  }
  return deltaPct > thresholdPct ? "WARN" : "PASS";
}

function main() {
  const baselinePath = arg("--baseline") || "bench/baseline.ci-small.json";
  const requestedRepeatPath = arg("--repeat");
  const repeatPath =
    requestedRepeatPath ||
    (existsSync("bench/results/repeat-summary.json")
      ? "bench/results/repeat-summary.json"
      : "bench/results/repeat-summary.current.json");
  const thresholdPct = Number(arg("--threshold-pct") || "20");

  if (!existsSync(repeatPath)) {
    throw new Error(
      `Repeat summary not found at "${repeatPath}". Run: bun run bench:qmd:repeat`
    );
  }

  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as BenchReport;
  const repeat = JSON.parse(readFileSync(repeatPath, "utf8")) as RepeatSummary;

  const baselineProfile = baseline.profile;
  const selected = arg("--profile") || baselineProfile;
  const profile = repeat.profiles[selected];
  if (!profile) {
    const choices = Object.keys(repeat.profiles).join(", ") || "(none)";
    throw new Error(`Profile "${selected}" not found in repeat summary. Available: ${choices}`);
  }

  const rows = [
    {
      metric: "ingest_throughput_msgs_per_sec",
      current: profile.median.ingest_throughput_msgs_per_sec,
      base: baseline.metrics.ingest_throughput_msgs_per_sec,
      higherIsBetter: true,
    },
    {
      metric: "ingest_p95_ms_per_session",
      current: profile.median.ingest_p95_ms_per_session,
      base: baseline.metrics.ingest_p95_ms_per_session,
      higherIsBetter: false,
    },
    {
      metric: "fts_p95_ms",
      current: profile.median.fts_p95_ms,
      base: baseline.metrics.fts.p95_ms,
      higherIsBetter: false,
    },
    {
      metric: "recall_p95_ms",
      current: profile.median.recall_p95_ms,
      base: baseline.metrics.recall.p95_ms,
      higherIsBetter: false,
    },
  ];

  console.log(`# Bench Scorecard (${selected})`);
  console.log(`threshold: ${thresholdPct.toFixed(2)}%`);
  console.log("");
  console.log("| metric | baseline | current (median) | delta | status |");
  console.log("|---|---:|---:|---:|---|");

  let warnCount = 0;
  for (const row of rows) {
    const deltaPct = pctDelta(row.current, row.base);
    const status = passWarn(deltaPct, thresholdPct, row.higherIsBetter);
    if (status === "WARN") warnCount += 1;
    console.log(
      `| ${row.metric} | ${fmtNum(row.base)} | ${fmtNum(row.current)} | ${fmtDelta(deltaPct)} | ${status} |`
    );
  }

  console.log("");
  console.log(`Summary: ${warnCount === 0 ? "PASS" : `WARN (${warnCount} metrics)`}`);
}

main();
