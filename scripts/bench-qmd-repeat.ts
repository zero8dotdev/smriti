import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

type ProfileName = "ci-small" | "small" | "medium";

type BenchMetrics = {
  ingest_throughput_msgs_per_sec: number;
  ingest_p95_ms_per_session: number;
  fts: { p50_ms: number; p95_ms: number; mean_ms: number; runs: number };
  recall: { p50_ms: number; p95_ms: number; mean_ms: number; runs: number };
};

type SingleRunReport = {
  profile: ProfileName;
  mode: "no-llm" | "llm";
  metrics: BenchMetrics;
};

type AggregatedReport = {
  generated_at: string;
  runs_per_profile: number;
  mode: "no-llm";
  profiles: Record<
    string,
    {
      raw: BenchMetrics[];
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

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  );
  return sorted[idx] || 0;
}

function parseProfiles(input: string | undefined): ProfileName[] {
  const raw = (input || "ci-small,small,medium")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as ProfileName[];
  return raw.length > 0 ? raw : ["ci-small", "small", "medium"];
}

async function runOne(profile: ProfileName, outPath: string): Promise<SingleRunReport> {
  const proc = Bun.spawn(
    [
      "bun",
      "run",
      "scripts/bench-qmd.ts",
      "--profile",
      profile,
      "--out",
      outPath,
      "--no-llm",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      cwd: process.cwd(),
    }
  );

  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`bench-qmd failed for ${profile}: ${stderr}`);
  }

  return JSON.parse(readFileSync(outPath, "utf8")) as SingleRunReport;
}

async function main() {
  const profiles = parseProfiles(arg("--profiles"));
  const runs = Math.max(1, Number(arg("--runs") || "3"));
  const out = arg("--out") || join("bench", "results", "repeat-summary.json");

  const tempDir = mkdtempSync(join(tmpdir(), "smriti-bench-repeat-"));
  const result: AggregatedReport = {
    generated_at: new Date().toISOString(),
    runs_per_profile: runs,
    mode: "no-llm",
    profiles: {},
  };

  for (const profile of profiles) {
    const raw: BenchMetrics[] = [];
    for (let i = 0; i < runs; i++) {
      const outPath = join(tempDir, `${profile}.run${i + 1}.json`);
      const report = await runOne(profile, outPath);
      raw.push(report.metrics);
      console.log(
        `[bench-repeat] ${profile} run ${i + 1}/${runs} ` +
          `ingest=${report.metrics.ingest_throughput_msgs_per_sec.toFixed(2)} ` +
          `fts_p95=${report.metrics.fts.p95_ms.toFixed(3)} ` +
          `recall_p95=${report.metrics.recall.p95_ms.toFixed(3)}`
      );
    }

    result.profiles[profile] = {
      raw,
      median: {
        ingest_throughput_msgs_per_sec: Number(
          percentile(raw.map((m) => m.ingest_throughput_msgs_per_sec), 50).toFixed(2)
        ),
        ingest_p95_ms_per_session: Number(
          percentile(raw.map((m) => m.ingest_p95_ms_per_session), 50).toFixed(3)
        ),
        fts_p95_ms: Number(percentile(raw.map((m) => m.fts.p95_ms), 50).toFixed(3)),
        recall_p95_ms: Number(
          percentile(raw.map((m) => m.recall.p95_ms), 50).toFixed(3)
        ),
      },
    };
  }

  mkdirSync(join(process.cwd(), "bench", "results"), { recursive: true });
  writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(`Repeat benchmark summary written: ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
